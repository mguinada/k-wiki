/**
 * The wiki-query CLI shell: the argv surface of the answer-only query
 * stage — help, argument validation, instance resolution, and the
 * stage dispatch. The run machinery (the two-phase `--web`
 * orchestration included) lives in wiki-query.ts; this module only
 * decides which stage runs and what the operator typed wrong.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { cliFail, errorMessage, terminalColors } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { runContext } from "../cli/run-context.ts";
import { repoRoot } from "../cli/shared.ts";
import { type AgentRunFlags, agentRunFlags, parseArgs } from "../cli/shell.ts";
import { resolveWikiInstance, wikiArgError } from "../sync/instance.ts";
import {
  confirmPush,
  pushFiledCommit,
  queryCommitMessage,
} from "./commit-push.ts";
import { fileLastQuery } from "./file-last.ts";
import { runQueryCli } from "./query-shell.ts";
import { LAST_QUERY_FILE } from "./wiki-query.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-query [-h | --help] [--file-last] [--push] [--no-commit] [--web] [--wiki, -w <name>] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>

Ask the built wiki one question headless. Filing is
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
  suggested sources and exits 0, with a hint that rerunning with
  --web may enrich the topic.

Stage 1 with web enrichment: wiki-query "<question>" --web
  Two agent passes. The first is the ordinary wiki-only core run —
  no web extension is loadable, so the core answer is web-blind by
  construction. The second, spawned only because --web was passed,
  has lane-shaped web access — pi gets the pi-web-access extension
  restricted to the search and fetch tools; codex runs its
  enrichment in a managed home whose config enables live web
  search (web_search = "live") and closes its report with the
  fenced k-wiki-web-audit block the wrapper parses per the codex
  report contract — and produces an enrichment section the wrapper
  audits, machine-assembles, and partitions after the core answer:
  never inside it, never in any wiki page. The saved artifact gains
  the mode, the web reference count, the retrieval timestamp, the
  Web enrichment and Web sources sections (computed from the
  recorded tool calls, not model output), and a Web calls audit
  table. The run prints a cost-and-slowness disclosure first.
  Degradations never fail the query: with the pi lane's web
  extension unavailable the run continues as a normal wiki-only run
  with the warning persisted in the artifact header; a citation the
  audit cannot account for is pruned from the enrichment, leaving
  the traceable remainder with the prune recorded in the audit
  section; when the enrichment still fails — the agent run, a
  report that cannot yield the lane's contract-shaped result (the
  named contract-parse failure), network or tool failure, or the
  pruning leaves nothing — the artifact keeps the wiki-only core
  answer with the failure warning and its concrete reason persisted
  in the header. --file-last on a --web artifact files the core
  answer only — the web sections never enter the wiki.

Stage 2 (human-only): wiki-query --file-last
  Deterministic code, no agent, zero tokens: template the saved
  answer byte-exactly into wiki/queries/<slug>.md (slug derived from
  the question; -2, -3, … suffixes on collision), append the
  index.md entry under ## Queries, and prepend the log.md entry
  (## [date] query | <question>) as the new topmost entry — below
  the # Wiki Log header and any standing comment; older entries
  stay untouched. The three writes are a unit: a
  failure anywhere in the filing rolls all of them back — no
  half-filed wiki is left behind. Filing is durable: the three
  files land as one atomic commit, message exactly
  "query: file <slug>", staged by path so unrelated edits elsewhere
  in the data repo stay uncommitted. After the commit the CLI asks
  "push now? [y/N]" — default no, and only on a terminal; --push
  pre-answers yes. The push rides the shared-writer machinery:
  preconditions, fetch first, fast-forward-only exact refspec of
  the filing commit, and a clean refusal — never force, never a
  merge — on a remote that moved since the filing, on dirt beyond
  it (guidance: run the sync cycle or pull), or on unshared local
  commits ahead of the filing (guidance: git push); shared-writer
  mode must be enabled (enable-shared-writer). --no-commit skips the
  commit — the filing stays uncommitted, a rebuild will lose the
  page, and nothing is pushed. Fails cleanly when no saved answer
  exists. Warns when the data repo's raw/ or wiki/ changed after the
  saved timestamp (the answer cites pages that may have moved); the
  warning does not block the filing.

Instances (--wiki, both stages):
  One checkout can host several wiki instances, one sync config
  each. --wiki <name> — short alias -w — selects one for both
  stages: the raw dir,
  outputs dir, and settings file all follow the resolved instance's
  config, and --file-last files into that instance's data repo.
  Resolution chain: an alias in the checkout's sync.json instances
  map first (explicit human intent beats convention), then a free
  stem — sync-<name>.json in the checkout root. Derivation keys off
  the resolved config file, never the typed name: sync-<x>.json →
  outputs-x/ and settings-x.yml (falling back to settings.yml when
  the sibling is absent); the default config (sync.json) → outputs/
  and settings.yml. An unknown name exits 1 listing every known
  name — aliases with their targets, then stems. Names are letters,
  digits, "-", and "_". No flag: the default instance, exactly
  today's behavior.

Switches and arguments:
  --wiki, -w <name> Select the wiki instance for both stages (see
                    Instances above); -w is the documented short
                    alias of --wiki. Default: the default instance.
  --file-last       Run stage 2: file the saved answer. Takes no
                    <question>; reads outputs/last-query.md, writes
                    wiki/queries/<slug>.md, wiki/index.md, wiki/log.md,
                    and commits the three atomically
                    ("query: file <slug>") unless --no-commit.
  --push            Stage 2 only: push after filing without the
                    interactive ask. The push rides the shared-writer
                    lease — fetch first, fast-forward only, never
                    forced; it refuses a moved remote, dirt beyond
                    the filing, or unshared local commits. Requires
                    shared-writer mode (enable-shared-writer).
  --no-commit       Stage 2 only: skip the commit — the filing stays
                    uncommitted (a rebuild will lose the page) and
                    nothing is pushed.
  --web             Stage 1 only: opt-in web enrichment (two agent
                    passes — a web-blind wiki-only core run, then an
                    audited, partitioned enrichment run; pi is
                    granted the pi-web-access search and fetch
                    tools, codex runs live web search in its
                    managed home). Slower and may cost more.
                    Default: off — the plain run is web-blind by
                    construction and byte-identical to a
                    closed-world run.
  --settings <path> Agent settings file, stage 1 only. Default: the
                    instance's settings.yml — or settings-<stem>.yml
                    under --wiki; an explicit flag overrides the
                    derived file. command, model, provider, and
                    reasoning level are passed to the agent as
                    --model/--thinking; provider is optional and
                    passed as --provider when set.
  --outputs <dir>   Directory holding last-query.md. Default: the
                    instance's outputs/ — or outputs-<stem>/ under
                    --wiki; an explicit flag overrides the derived dir.
  --raw-dir <dir>   raw/ directory of the data repo to query; its
                    parent is the data repo root the agent runs in
                    (stage 1) and files into (stage 2). Default:
                    <dataRoot>/raw from the resolved instance's sync
                    config; an explicit flag overrides it.
  --timeout <secs>  Kill the agent run after this many seconds and
                    fail it. Default: 1800 (30 minutes). Stage 1 only.
  -h, --help        Print this help and exit; no side effects.
  <question>        The question, quoted (one positional argument,
                    no interactive prompt). Stage 1 only.

Precedence: an explicit --settings, --outputs, or --raw-dir always
overrides its --wiki-derived counterpart.

What it writes: stage 1 writes outputs/last-query.md (the selected
instance's outputs dir) and prints the answer to stdout (plus a
filing hint on stderr, echoing --wiki when one was used); it never
writes wiki/ — enforced mechanically, with revert. Stage 2 writes
the three wiki files named above, commits them ("query: file
<slug>"), and prints "Filed: <path>" then "Committed: <oid>"; the
drift warning, if any, goes to stderr, as do the push-ask prompt and
push progress. Under --no-commit nothing is committed and a loud
rebuild-loss warning goes to stderr. Errors print red, prefixed
"wiki-query:", and exit 1. On a terminal (TTY, color enabled) the
agent run shows one animated status line - braille spinner plus
elapsed time - rewritten in place; piped, redirected, CI, or
NO_COLOR runs get one plain heartbeat line per 60 seconds instead.
Live progress goes to stderr; the answer and the Filed line go to
stdout.`;

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-query", message);
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

/** The usage error when --web accompanies --file-last: enrichment
 *  belongs to a stage-1 answer run. */
function webFlagError(fileLast: boolean, web: boolean): string | undefined {
  if (fileLast && web) {
    return "--web enriches a stage-1 answer run; --file-last takes no --web";
  }

  return undefined;
}

/** The usage errors when the stage-2 durability flags appear where
 *  they mean nothing. */
function durabilityFlagError(
  fileLast: boolean,
  push: boolean,
  noCommit: boolean,
): string | undefined {
  if (!fileLast && (push || noCommit)) {
    return "--push and --no-commit belong to --file-last";
  }

  if (push && noCommit) {
    return "--no-commit skips the commit — there is nothing to push (drop one of the two)";
  }

  return undefined;
}

/** Stage 2: file the saved answer, commit it durably, and offer the
 *  guarded push. */
async function fileLastStage(
  colors: ReturnType<typeof terminalColors>,
  dataRoot: string,
  outputsDir: string,
  filing: { readonly push: boolean; readonly noCommit: boolean },
): Promise<void> {
  const result = await fileLastQuery({
    artifactPath: join(outputsDir, LAST_QUERY_FILE),
    dataRoot,
    commit: !filing.noCommit,
  });

  console.log(colors.bold(`Filed: ${result.pagePath}`));

  if (result.warning !== undefined) {
    console.error(result.warning);
  }

  if (filing.noCommit) {
    console.error(
      "WARNING: --no-commit left the filing uncommitted — git history is its record, and a rebuild will lose this page",
    );

    return;
  }

  console.log(
    `Committed: ${result.commit?.slice(0, 8)} — ${queryCommitMessage(result.slug)}`,
  );

  if (
    !filing.push &&
    !(await confirmPush({
      input: process.stdin,
      output: process.stderr,
      isTTY: Boolean(process.stdin.isTTY),
    }))
  ) {
    console.error(
      "Not pushed — the commit stays local; push it soon (git push): a shared-writer cycle refuses a local-ahead history",
    );

    return;
  }

  await pushFiledCommit({
    dataRoot,
    env: process.env,
    onProgress: (message) => console.error(message),
  });
}

/** The stage-1 filing hint, echoing the --wiki flag when one was
 *  used (issue #306, edge 3): without it a meta answer would be
 *  filed into the regular wiki. */
function fileLastHint(name: string | undefined): string {
  const wiki = name === undefined ? "" : `--wiki ${name} `;

  return `To file this answer: k-wiki wiki-query ${wiki}--file-last`;
}

/** Run the stage the arguments selected, in the data repo it
 *  resolved: stage 1 through the shared query shell, stage 2
 *  deterministically. The instance (issue #306) resolves through
 *  the checkout's alias/stem chain; explicit flags override each
 *  derived counterpart — one precedence rule. */
async function dispatchStage(
  parsed: ReturnType<typeof parseArgs>,
  runFlags: AgentRunFlags,
): Promise<void> {
  const name = parsed.values.get("--wiki");
  const instance = await resolveWikiInstance({
    checkout: repoRoot,
    name,
    home: homedir(),
  });
  const outputsDir = runFlags.outputs ?? instance.outputsDir;
  const settingsPath = runFlags.settings ?? instance.settingsPath;
  const rawDir = parsed.values.get("--raw-dir") ?? instance.rawDir;

  // The run context, built once at this CLI boundary (issue #257):
  // stage 2 files into its data root, stage 1 queries its raw dir.
  const run = runContext({ rawDir });

  if (parsed.flags.has("--file-last")) {
    await fileLastStage(terminalColors(process.env), run.dataRoot, outputsDir, {
      push: parsed.flags.has("--push"),
      noCommit: parsed.flags.has("--no-commit"),
    });

    return;
  }

  await runQueryCli({
    prefix: "wiki-query",
    settingsPath,
    rawDir: run.rawDir,
    promptsDir: join(repoRoot, "prompts"),
    outputsDir,
    question: parsed.positional[0] ?? "",
    timeoutMs: runFlags.timeoutMs,
    hint: fileLastHint(name),
    web: parsed.flags.has("--web"),
  });
}

/** The first usage error in the parsed arguments, if any: instance,
 *  run flags, stage-flag placement, then the positional question. */
function usageError(
  parsed: ReturnType<typeof parseArgs>,
  runFlags: AgentRunFlags,
): string | undefined {
  const fileLast = parsed.flags.has("--file-last");

  return (
    wikiArgError(parsed.values) ??
    runFlags.error ??
    webFlagError(fileLast, parsed.flags.has("--web")) ??
    durabilityFlagError(
      fileLast,
      parsed.flags.has("--push"),
      parsed.flags.has("--no-commit"),
    ) ??
    questionError(parsed.positional, fileLast)
  );
}

/** wiki-query entry point: `wiki-query [-h | --help] [--file-last] [--push] [--no-commit] [--web] [--wiki, -w <name>] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    value: ["--settings", "--outputs", "--raw-dir", "--timeout", "--wiki"],
    boolean: ["--file-last", "--web", "--push", "--no-commit"],
    alias: new Map([["-w", "--wiki"]]),
  });

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const pathValues = new Map(parsed.values);

  pathValues.delete("--wiki");

  const runFlags = agentRunFlags(pathValues);
  const usage = usageError(parsed, runFlags);

  if (usage !== undefined) {
    fail(usage);

    return;
  }

  try {
    await dispatchStage(parsed, runFlags);
  } catch (error) {
    cliFail("wiki-query", errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/query/query-cli.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-query");
