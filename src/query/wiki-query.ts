import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../cli/is-main.ts";
import { formatDuration } from "../cli/progress.ts";
import {
  type AgentRunner,
  createAgentProgressSink,
  HEARTBEAT_MS,
  loadAgentSettings,
  readPrompt,
  spawnAgent,
  type WikiPages,
  wikiPages,
} from "../ingest/wiki-ingest.ts";
import { loadSyncConfig, resolveRawDir } from "../sync/config.ts";

/**
 * wiki-query: the terminal front-end for asking questions against the
 * built wiki (guide §16, issue #67). It composes prompts/query.md
 * with the question and the mode (file, or --no-filing answer-only),
 * runs the agent CLI non-interactively in the data repo root, prints
 * the answer, and — in file mode — reports the query pages the agent
 * filed, read from the data repo's git status. The script itself
 * writes nothing anywhere; the agent does any filing (wiki/AGENTS.md,
 * Queries). The trailing `QUERY:` status line the composed prompt
 * asks for is how the wrapper learns the filing verdict it prints.
 */

/** What the agent's trailing `QUERY:` line reports about filing. */
export type QueryStatusKind =
  | "filed"
  | "meets-bar"
  | "not-filed"
  | "not-answerable"
  | "unknown";

export interface AgentReply {
  /** The agent output minus the trailing status line. */
  readonly answer: string;
  readonly kind: QueryStatusKind;
  /** The reason, pages, or suggested sources the status line carries. */
  readonly detail: string | undefined;
}

const STATUS_LINE =
  /^QUERY: (not-filed|not-answerable|meets-bar|filed) — (.+)$/;

/** Split the agent output into the answer and its trailing status line. */
export function parseAgentReply(output: string): AgentReply {
  const text = output.replace(/\s+$/, "");
  const lastNewline = text.lastIndexOf("\n");
  const lastLine = lastNewline === -1 ? text : text.slice(lastNewline + 1);
  const match = STATUS_LINE.exec(lastLine);

  if (match === null) {
    return { answer: output.trim(), kind: "unknown", detail: undefined };
  }

  const answer = (lastNewline === -1 ? "" : text.slice(0, lastNewline)).trim();

  return {
    answer,
    kind: match[1] as Exclude<QueryStatusKind, "unknown">,
    detail: match[2],
  };
}

/** The wiki/queries filing instruction appended to prompts/query.md. */
const STATUS_INSTRUCTIONS = [
  "End your reply with exactly one status line, nothing after it, the first that applies:",
  "QUERY: filed — <the wiki/queries/ pages you created or updated>",
  "QUERY: meets-bar — <why the answer deserves filing>",
  "QUERY: not-filed — <why the filing bar is not met>",
  "QUERY: not-answerable — <which sources to ingest next>",
];

/**
 * Compose the agent message: the query prompt, the question, the mode
 * (the agent must know whether filing is allowed), and the status-line
 * protocol the wrapper parses.
 */
export function composeQueryPrompt(
  promptText: string,
  question: string,
  noFiling: boolean,
): string {
  const mode = noFiling
    ? "Mode: answer-only (--no-filing) — write nothing: no query page, no index.md or log.md change; the reply is the only output."
    : "Mode: file — filing is allowed: when the answer meets the bar, create the query page and update index.md and log.md per the rules above.";

  return [
    promptText,
    "",
    `Question: ${question}`,
    "",
    mode,
    "",
    ...STATUS_INSTRUCTIONS,
  ].join("\n");
}

/** How the wrapper reports one completed query run. */
export type Verdict =
  | { readonly kind: "filed"; readonly pages: readonly string[] }
  | { readonly kind: "not-filed"; readonly reason: string }
  | { readonly kind: "not-answerable"; readonly suggestion: string }
  | { readonly kind: "offer"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "none" };

const EMPTY_PAGES: WikiPages = {
  created: [],
  updated: [],
  deleted: [],
  unavailable: undefined,
};

/**
 * The filing verdict to print. In file mode the data repo's git status
 * is the truth: wiki/queries changes mean filed, whatever the agent
 * claims; the agent's status line explains why nothing was filed or
 * reports an unanswerable question. In answer-only mode only the
 * agent's line speaks: meets-bar becomes the rerun offer.
 */
export function classifyVerdict(
  pages: WikiPages,
  reply: AgentReply,
  noFiling: boolean,
): Verdict {
  if (!noFiling) {
    const filed = [...pages.created, ...pages.updated];

    if (filed.length > 0) {
      return { kind: "filed", pages: filed };
    }

    if (reply.kind === "filed" && pages.unavailable === undefined) {
      return {
        kind: "not-filed",
        reason: `agent reported filing, but git shows no wiki/queries change (${reply.detail ?? "no detail"})`,
      };
    }

    if (reply.kind === "filed" && pages.unavailable !== undefined) {
      return { kind: "unavailable", reason: pages.unavailable };
    }

    if (reply.kind === "meets-bar") {
      return {
        kind: "not-filed",
        reason: `answer meets the filing bar, but nothing was filed (${reply.detail ?? "no detail"})`,
      };
    }
  }

  if (reply.kind === "meets-bar") {
    return { kind: "offer", reason: reply.detail ?? "" };
  }

  if (reply.kind === "not-filed") {
    return { kind: "not-filed", reason: reply.detail ?? "" };
  }

  if (reply.kind === "not-answerable") {
    return { kind: "not-answerable", suggestion: reply.detail ?? "" };
  }

  return { kind: "none" };
}

/** One printed verdict line: content plus its color weight. */
export interface VerdictLine {
  readonly text: string;
  readonly bold: boolean;
}

/** Render the verdict as terminal lines: filed/not-filed/offer bold,
 *  the unanswerable statement plain (issue #67 color policy). */
export function renderVerdict(verdict: Verdict): VerdictLine[] {
  switch (verdict.kind) {
    case "filed":
      return verdict.pages.map((path) => ({
        text: `Filed: ${path}`,
        bold: true,
      }));
    case "not-filed":
      return [{ text: `Not filed: ${verdict.reason}`, bold: true }];
    case "offer":
      return [
        {
          text: `Meets the filing bar (${verdict.reason}); rerun without --no-filing to file it.`,
          bold: true,
        },
      ];
    case "not-answerable":
      return [{ text: `Not answerable: ${verdict.suggestion}`, bold: false }];
    case "unavailable":
      return [
        {
          text: `Filing status unavailable: ${verdict.reason}`,
          bold: false,
        },
      ];
    default:
      return [];
  }
}

/** Liveness prefix; the animated sink keeps these on one line. */
export const QUERY_HEARTBEAT_PREFIX = "wiki-query: querying the wiki";

export interface QueryOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The raw dir of the data repo; its parent is the data repo root. */
  readonly rawDir: string;
  /** Directory holding query.md. */
  readonly promptsDir: string;
  /** The question, passed to the agent inside the composed prompt. */
  readonly question: string;
  /** Answer-only mode: the agent is told to write nothing, and the
   *  wrapper does not read the git status. */
  readonly noFiling?: boolean;
  /** Environment for child processes; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Agent runner; defaults to the real non-interactive invocation. */
  readonly runAgent?: AgentRunner;
  /** Kill the agent run after this many milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while the agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

export interface QueryResult {
  readonly reply: AgentReply;
  /** wiki/queries pages created/updated by the agent (file mode only). */
  readonly pages: WikiPages;
}

/** One headless query run: compose, invoke, parse, and (in file mode)
 *  read back what the agent filed. */
export async function runWikiQuery(
  options: QueryOptions,
): Promise<QueryResult> {
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? (() => {});
  const noFiling = options.noFiling ?? false;
  const settings = await loadAgentSettings(options.settingsPath);
  const dataRoot = dirname(options.rawDir);

  onProgress(`wiki-query: data repo ${dataRoot}`);

  const promptText = await readPrompt(join(options.promptsDir, "query.md"));
  const composed = composeQueryPrompt(promptText, options.question, noFiling);
  const args = [
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    composed,
  ];
  const runAgent = options.runAgent ?? spawnAgent;

  onProgress(
    `wiki-query: invoking agent: ${settings.command} --model ${settings.model} --thinking ${settings.reasoning}`,
  );

  const agentStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = formatDuration(Date.now() - agentStartedAt);

    onProgress(`${QUERY_HEARTBEAT_PREFIX} (${elapsed})`);
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  let stdout: string;

  try {
    ({ stdout } = await runAgent(settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs: options.timeoutMs,
    }));
  } finally {
    clearInterval(heartbeat);
  }

  onProgress("wiki-query: agent finished");

  const reply = parseAgentReply(stdout);
  const pages = noFiling
    ? EMPTY_PAGES
    : await wikiPages(dataRoot, env, "wiki/queries");

  return { reply, pages };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-query [-h | --help] [--no-filing] [--settings <path>] [--raw-dir <dir>] [--timeout <secs>] <question>

Ask the built wiki one question headless (guide §16, issue #67):
compose prompts/query.md with the question and the mode, run the
agent CLI non-interactively in the data repo root, print the answer,
and report the filing verdict.

Switches and arguments:
  --no-filing         Answer only: the agent writes nothing under wiki/
                    (no query page, no index.md or log.md change).
                    When the answer would meet the filing bar, the
                    wrapper prints the hint to rerun without it.
  --settings <path> Agent settings file. Default: the repo's
                    settings.yml — command, model, and reasoning
                    level, passed to the agent as --model/--thinking;
                    never hardcoded.
  --raw-dir <dir>   raw/ directory of the data repo to query; its
                    parent is the data repo root the agent runs in.
                    Default: <dataRoot>/raw from sync.json, otherwise
                    the repo's own raw/.
  --timeout <secs>  Kill the agent run after this many seconds and
                    fail it. Default: 1800 (30 minutes).
  -h, --help        Print this help and exit; no side effects.
  <question>        The question, quoted (one positional argument,
                    no interactive prompt).

What it writes: nothing itself, ever. In default mode the agent files
the query page (wiki/queries/<name>.md, type: query frontmatter,
plus index.md and log.md updates) per wiki/AGENTS.md; the wrapper only
reads the data repo's git status to report those pages under
"Filed:", or prints the reason nothing was filed. A question the wiki
cannot answer prints plainly with suggested sources and exits 0 —
being unanswerable is not an error. Errors print red, prefixed
"wiki-query:", and exit 1. On a terminal (TTY, color enabled) the
agent run shows one animated status line - braille spinner plus
elapsed time - rewritten in place; piped, redirected, CI, or NO_COLOR
runs get one plain heartbeat line per 60 seconds instead. Live
progress goes to stderr; the answer and verdict go to stdout.`;

/** Colors honoring NO_COLOR, like every CLI in this repo. */
export function terminalColors(env: NodeJS.ProcessEnv) {
  return createColors(env.NO_COLOR === undefined);
}

/** True when the stderr surface may animate: a TTY with color on. */
export function canAnimate(isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return isTTY && !env.NO_COLOR;
}

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  console.error(terminalColors(process.env).red(`wiki-query: ${message}`));
  process.exitCode = 1;
}

/** wiki-query entry point: `wiki-query [-h | --help] [--no-filing] [--settings <path>] [--raw-dir <dir>] [--timeout <secs>] <question>`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const values = new Map<string, string | undefined>();
  const positional: string[] = [];
  let noFiling = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--no-filing") {
      noFiling = true;

      continue;
    }

    if (arg === "--settings" || arg === "--raw-dir" || arg === "--timeout") {
      values.set(arg, args[index + 1]);
      index++;

      continue;
    }

    if (arg.startsWith("-")) {
      fail(`unknown option ${JSON.stringify(arg)}`);

      return;
    }

    positional.push(arg);
  }

  for (const [flag, value] of values) {
    if (flag === "--timeout") {
      continue;
    }

    if (value === undefined) {
      fail(`${flag} needs a path value`);

      return;
    }
  }

  const timeoutArg = values.get("--timeout");

  if (
    values.has("--timeout") &&
    (timeoutArg === undefined || !/^[1-9][0-9]*$/.test(timeoutArg))
  ) {
    fail("--timeout needs a positive integer number of seconds");

    return;
  }

  if (positional.length === 0) {
    fail('a question is required: wiki-query "<question>"');

    return;
  }

  if (positional.length > 1) {
    fail(`expected exactly one <question> argument, got ${positional.length}`);

    return;
  }

  const question = positional[0] ?? "";

  if (question.trim() === "") {
    fail('a question is required: wiki-query "<question>"');

    return;
  }

  const settingsPath =
    values.get("--settings") ?? join(repoRoot, "settings.yml");
  const colors = terminalColors(process.env);
  const animated = canAnimate(process.stderr.isTTY === true, process.env);
  const sink = createAgentProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    (text) => colors.dim(text),
    (message) => message.startsWith(QUERY_HEARTBEAT_PREFIX),
  );

  try {
    const config = await loadSyncConfig(join(repoRoot, "sync.json"), homedir());
    const rawDir =
      values.get("--raw-dir") ?? resolveRawDir(config.dataRoot, repoRoot);
    const result = await runWikiQuery({
      settingsPath,
      rawDir,
      promptsDir: join(repoRoot, "prompts"),
      question,
      noFiling,
      timeoutMs:
        timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
      heartbeatMs: animated ? 100 : undefined,
      onProgress: sink.render,
    });

    sink.end();

    const verdict = classifyVerdict(result.pages, result.reply, noFiling);
    const lines = renderVerdict(verdict);

    if (result.reply.answer !== "") {
      console.log(result.reply.answer);
    }

    if (lines.length > 0) {
      console.log();

      for (const line of lines) {
        console.log(line.bold ? colors.bold(line.text) : line.text);
      }
    }
  } catch (error) {
    sink.end();
    console.error(
      colors.red(
        `wiki-query: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url);

/* v8 ignore next: covered only under `node src/query/wiki-query.ts` */
if (isMain) {
  await main();
}
