import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canAnimate,
  cliFail,
  errorMessage,
  terminalColors,
} from "../cli/colors.ts";
import { flagValueError } from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import {
  createAgentProgressSink,
  formatDuration,
  HEARTBEAT_MS,
  type ProgressSink,
} from "../cli/progress.ts";
import { statusSince } from "../data/git.ts";
import {
  type AgentRunner,
  readPrompt,
  spawnAgent,
} from "../ingest/agent-run.ts";
import {
  type AgentSettings,
  loadAgentSettings,
} from "../ingest/agent-settings.ts";
import {
  capturePreRunState,
  type PreRunState,
  revertToPreRun,
} from "../ingest/guardrails.ts";
import { loadSyncConfig, resolveRawDir } from "../sync/config.ts";
import { citedPages, fileLastQuery, writeQueryArtifact } from "./file-last.ts";

/**
 * wiki-query: the terminal front-end for asking questions against the
 * built wiki (guide §16, issues #67 and #72). Filing is two-stage:
 *
 *  Stage 1 (default) — `wiki-query <question>` is always answer-only.
 *  It composes prompts/query.md with the question, runs the agent CLI
 *  non-interactively in the data repo root, prints the answer, and
 *  persists the run to outputs/last-query.md. The guardrail is
 *  mechanical, not prompt-deep: any change under wiki/ during the
 *  run — a commit the agent makes included — reverts the data repo
 *  to its pre-run state and fails the run.
 *
 *  Stage 2 (human-only) — `wiki-query --file-last` templates the saved
 *  answer byte-exactly into wiki/queries/<slug>.md and updates
 *  index.md and log.md. Deterministic code, zero LLM involvement; see
 *  src/query/file-last.ts.
 */

/**
 * Compose the agent message: the query prompt, the question, and the
 * answer-only mode. There is no filing mode and no status-line
 * protocol — stage 1 only answers.
 */
export function composeQueryPrompt(
  promptText: string,
  question: string,
): string {
  return [
    promptText,
    "",
    `Question: ${question}`,
    "",
    "Mode: answer-only — write nothing: no query page, no index.md or log.md change, no edit anywhere under wiki/; the reply is the only output. The wrapper saves it; the human alone decides later whether to file it.",
  ].join("\n");
}

/** Liveness prefix; the animated sink keeps these on one line. */
export const QUERY_HEARTBEAT_PREFIX = "wiki-query: querying the wiki";

/** Where stage 1 persists the run inside the outputs dir. */
export const LAST_QUERY_FILE = "last-query.md";

export interface QueryOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The raw dir of the data repo; its parent is the data repo root. */
  readonly rawDir: string;
  /** Directory holding query.md. */
  readonly promptsDir: string;
  /** Directory the saved answer is written to. */
  readonly outputsDir: string;
  /** The question, passed to the agent inside the composed prompt. */
  readonly question: string;
  /** Environment for child processes; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock for the saved timestamp; defaults to the wall clock. */
  readonly now?: () => Date;
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
  /** The agent's answer, trimmed. */
  readonly answer: string;
  /** Where the run was persisted (outputs/last-query.md). */
  readonly artifactPath: string;
}

/** The agent CLI argument list for one answer-only run. */
function queryAgentArgs(settings: AgentSettings, composed: string): string[] {
  return [
    ...(settings.provider ? ["--provider", settings.provider] : []),
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    composed,
  ];
}

/** Announce the exact agent invocation before it starts. */
function announceAgent(
  onProgress: (message: string) => void,
  settings: AgentSettings,
): void {
  const providerFlag = settings.provider
    ? ` --provider ${settings.provider}`
    : "";

  onProgress(
    `wiki-query: invoking agent: ${settings.command}${providerFlag} --model ${settings.model} --thinking ${settings.reasoning}`,
  );
}

/** Fail the run when the answer-only contract was violated: revert, then throw. */
async function assertWikiUnchanged(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  onProgress: (message: string) => void,
): Promise<void> {
  const { entries, changed, headMoved } = await statusSince(
    dataRoot,
    env,
    pre,
    "wiki",
  );

  if (changed.length > 0 || headMoved) {
    const revertTo = pre.commit.slice(0, 8);
    const reason =
      changed.length > 0 ? "wiki changed" : "the data repo's HEAD moved";

    onProgress(
      `wiki-query: ${reason} during the answer-only run — reverting to ${revertTo}`,
    );
    await revertToPreRun(dataRoot, env, pre, entries);

    const violations = [
      ...(changed.length > 0 ? [`wrote to wiki/ (${changed.join(", ")})`] : []),
      ...(headMoved ? ["moved the data repo's HEAD"] : []),
    ];

    throw new Error(
      `answer-only run ${violations.join(" and ")}; reverted to ${revertTo} — the answer was saved nowhere; rerun the question`,
    );
  }
}

/**
 * One headless answer-only query run: capture the pre-run state,
 * compose, invoke, then verify mechanically that wiki/ did not move
 * (git status is the truth — a wiki agent that writes despite the
 * prompt is caught, reverted, and failed) before persisting the run.
 */
export async function runWikiQuery(
  options: QueryOptions,
): Promise<QueryResult> {
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? (() => {});
  const settings = await loadAgentSettings(options.settingsPath);
  const dataRoot = dirname(options.rawDir);

  onProgress(`wiki-query: data repo ${dataRoot}`);

  const pre = await capturePreRunState(dataRoot, env);
  const promptText = await readPrompt(join(options.promptsDir, "query.md"));
  const composed = composeQueryPrompt(promptText, options.question);
  const args = queryAgentArgs(settings, composed);
  const runAgent = options.runAgent ?? spawnAgent;

  announceAgent(onProgress, settings);

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

  const answer = stdout.trim();

  if (answer === "") {
    throw new Error("the agent produced no answer");
  }

  await assertWikiUnchanged(dataRoot, env, pre, onProgress);

  const artifactPath = join(options.outputsDir, LAST_QUERY_FILE);

  await writeQueryArtifact(artifactPath, {
    question: options.question,
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    pages: citedPages(answer),
    answer,
  });
  onProgress(`wiki-query: answer saved to ${artifactPath}`);

  return { answer, artifactPath };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-query [-h | --help] [--file-last] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>

Ask the built wiki one question headless (guide §16). Filing is
two-stage: stage 1 answers and saves; stage 2 files
what the human approved.

Stage 1 (default): wiki-query "<question>"
  Compose prompts/query.md with the question, run the agent CLI
  non-interactively in the data repo root, print the answer, and save
  the run (question, answer, pages cited, timestamp) to
  outputs/last-query.md. The run is answer-only by construction: the
  wrapper captures the data repo's pre-run git state, and any change
  under wiki/ during the run — whatever the agent claims, even one
  the agent commits — reverts the data repo to that state and exits
  1; nothing is saved. A question the wiki cannot answer prints its
  suggested sources and exits 0.

Stage 2 (human-only): wiki-query --file-last
  Deterministic code, no agent, zero tokens: template the saved
  answer byte-exactly into wiki/queries/<slug>.md (slug derived from
  the question; -2, -3, … suffixes on collision), append the
  index.md entry under ## Queries, and append the log.md entry
  (## [date] query | <question>). The three writes are a unit: a
  failure anywhere in the filing rolls all of them back — no
  half-filed wiki is left behind. Fails cleanly when no saved answer
  exists. Warns when the data repo's raw/ or wiki/ changed after the
  saved timestamp (the answer cites pages that may have moved); the
  warning does not block the filing.

Switches and arguments:
  --file-last       Run stage 2: file the saved answer. Takes no
                    <question>; reads outputs/last-query.md, writes
                    wiki/queries/<slug>.md, wiki/index.md, wiki/log.md.
  --settings <path> Agent settings file, stage 1 only. Default: the
                    repo's settings.yml — command, model, provider,
                    and reasoning level, passed to the agent as
                    --model/--thinking; provider is optional and
                    passed as --provider when set.
  --outputs <dir>   Directory holding last-query.md. Default: the
                    repo's outputs/.
  --raw-dir <dir>   raw/ directory of the data repo to query; its
                    parent is the data repo root the agent runs in
                    (stage 1) and files into (stage 2). Default:
                    <dataRoot>/raw from sync.json, otherwise the
                    repo's own raw/.
  --timeout <secs>  Kill the agent run after this many seconds and
                    fail it. Default: 1800 (30 minutes). Stage 1 only.
  -h, --help        Print this help and exit; no side effects.
  <question>        The question, quoted (one positional argument,
                    no interactive prompt). Stage 1 only.

What it writes: stage 1 writes outputs/last-query.md and prints the
answer to stdout (plus a filing hint on stderr); it never writes
wiki/ — enforced mechanically, with revert. Stage 2 writes the three
wiki files named above and prints "Filed: <path>"; the drift warning,
if any, goes to stderr. Errors print red, prefixed "wiki-query:", and
exit 1. On a terminal (TTY, color enabled) the agent run shows one
animated status line - braille spinner plus elapsed time - rewritten
in place; piped, redirected, CI, or NO_COLOR runs get one plain
heartbeat line per 60 seconds instead. Live progress goes to stderr;
the answer and the Filed line go to stdout.`;

/** Colors honoring NO_COLOR, like every CLI in this repo — moved to
 *  the shared presentation kit (src/cli/colors.ts) and re-exported
 *  here for the query surface's existing importers. */
export { canAnimate, terminalColors } from "../cli/colors.ts";

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-query", message);
}

/** What parseArgs lifted out of argv: switch values, positionals, mode. */
interface ParsedArgs {
  readonly values: Map<string, string | undefined>;
  readonly positional: string[];
  readonly fileLast: boolean;
  readonly error: string | undefined;
}

/** Split argv into switch values, positionals, and the --file-last mode. */
function parseArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string | undefined>();
  const positional: string[] = [];
  let fileLast = false;
  let error: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--file-last") {
      fileLast = true;

      continue;
    }

    if (
      arg === "--settings" ||
      arg === "--outputs" ||
      arg === "--raw-dir" ||
      arg === "--timeout"
    ) {
      values.set(arg, args[index + 1]);
      index++;

      continue;
    }

    if (arg.startsWith("-")) {
      error = `unknown option ${JSON.stringify(arg)}`;

      break;
    }

    positional.push(arg);
  }

  return { values, positional, fileLast, error };
}

/** The first usage error in the positional question, if any. */
function questionError(
  positional: readonly string[],
  fileLast: boolean,
): string | undefined {
  if (fileLast && positional.length > 0) {
    return `--file-last takes no <question> argument (it files the saved answer; got ${JSON.stringify(positional[0])})`;
  }

  if (!fileLast) {
    if (positional.length === 0) {
      return 'a question is required: wiki-query "<question>"';
    }

    if (positional.length > 1) {
      return `expected exactly one <question> argument, got ${positional.length}`;
    }
  }

  const question = positional[0] ?? "";

  if (!fileLast && question.trim() === "") {
    return 'a question is required: wiki-query "<question>"';
  }

  return undefined;
}

/** Stage 2: file the saved answer and print the Filed line. */
async function fileLastStage(
  colors: ReturnType<typeof terminalColors>,
  rawDir: string,
  outputsDir: string,
): Promise<void> {
  const result = await fileLastQuery({
    artifactPath: join(outputsDir, LAST_QUERY_FILE),
    dataRoot: dirname(rawDir),
  });

  console.log(colors.bold(`Filed: ${result.pagePath}`));

  if (result.warning !== undefined) {
    console.error(result.warning);
  }
}

/** Stage 1: ask the question, print the answer and the filing hint. */
async function answerStage(
  parsed: ParsedArgs,
  colors: ReturnType<typeof terminalColors>,
  rawDir: string,
  outputsDir: string,
  animated: boolean,
  sink: ProgressSink,
): Promise<void> {
  const timeoutArg = parsed.values.get("--timeout");
  const result = await runWikiQuery({
    settingsPath:
      parsed.values.get("--settings") ?? join(repoRoot, "settings.yml"),
    rawDir,
    promptsDir: join(repoRoot, "prompts"),
    outputsDir,
    question: parsed.positional[0] ?? "",
    timeoutMs: timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
    heartbeatMs: animated ? 100 : undefined,
    onProgress: sink.render,
  });

  sink.end();

  console.log(result.answer);
  console.error();
  console.error(colors.dim(`To file this answer: wiki-query --file-last`));
}

/** Run the stage the arguments selected, in the data repo it resolved. */
async function dispatchStage(
  parsed: ParsedArgs,
  colors: ReturnType<typeof terminalColors>,
  animated: boolean,
  sink: ProgressSink,
): Promise<void> {
  const outputsDir =
    parsed.values.get("--outputs") ?? join(repoRoot, "outputs");
  const config = await loadSyncConfig(join(repoRoot, "sync.json"), homedir());
  const rawDir =
    parsed.values.get("--raw-dir") ?? resolveRawDir(config.dataRoot, repoRoot);

  if (parsed.fileLast) {
    await fileLastStage(colors, rawDir, outputsDir);

    return;
  }

  await answerStage(parsed, colors, rawDir, outputsDir, animated, sink);
}

/** Print the failure red and set the exit code; the sink is closed first. */
function reportFailure(
  sink: ProgressSink,
  colors: ReturnType<typeof terminalColors>,
  error: unknown,
): void {
  sink.end();
  console.error(colors.red(`wiki-query: ${errorMessage(error)}`));
  process.exitCode = 1;
}

/** wiki-query entry point: `wiki-query [-h | --help] [--file-last] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args);

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const usageError =
    flagValueError(parsed.values) ??
    questionError(parsed.positional, parsed.fileLast);

  if (usageError !== undefined) {
    fail(usageError);

    return;
  }

  const colors = terminalColors(process.env);
  const animated = canAnimate(process.stderr.isTTY === true, process.env);
  const sink = createAgentProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    colors,
    QUERY_HEARTBEAT_PREFIX,
  );

  try {
    await dispatchStage(parsed, colors, animated, sink);
  } catch (error) {
    reportFailure(sink, colors, error);
  }
}

/* v8 ignore next: covered only under direct `node src/query/wiki-query.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-query");
