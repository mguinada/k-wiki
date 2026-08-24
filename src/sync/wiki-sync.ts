import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../cli/is-main.ts";
import { formatDuration } from "../cli/progress.ts";
import { checkCrossWikiLinks } from "../crosslinks.ts";
import { runGit } from "../data/init-data-repo.ts";
import {
  capturePreRunState,
  parseStatus,
  revertToPreRun,
  runGuardrails,
} from "../ingest/guardrails.ts";
import {
  AGENT_HEARTBEAT_PREFIX,
  type AgentRunner,
  createAgentProgressSink,
  type IngestResult,
  loadAgentSettings,
  readPrompt,
  runWikiIngest,
  sourceCount,
  spawnAgent,
  wikiPages,
} from "../ingest/wiki-ingest.ts";
import { expandHome, loadSyncConfig, resolveRawDir } from "./config.ts";
import { runSync, type SyncReport } from "./sync-vault.ts";

/**
 * wiki-sync: the one-command orchestrator (guide §18, issue #13). It
 * chains the proven pieces — sync-vault → wiki-ingest → headless lint
 * (§17, prompts/lint.md) → crosslink audit (issue #96, configured
 * second brains only) → data-repo commit — and prints one digest: the
 * run's ingest digest, the lint summary, the audit result, and the
 * commit hash. Nothing here is new capability; every stage stays
 * independently runnable (guide §8).
 *
 * The lint stage is the headless sibling of the manual lint run: the
 * same prompt file, invoked through the same agent settings, with the
 * same post-run guardrails and auto-revert as the ingest stage. Its
 * report lands in the DATA repo's outputs/ (the #61 convention:
 * quality history travels with the content), so the cycle's single
 * commit carries it.
 *
 * The crosslink stage (issue #96) enforces the wiki/AGENTS.md contract
 * that the cross-wiki audit runs after every run: an instance whose
 * settings carry `secondBrain.domains: [<wiki dirs>]` gets the
 * check-crosslinks core (src/crosslinks.ts) run over its wiki against
 * every listed domain wiki, after lint and before the commit. A
 * failed audit fails the cycle like lint does; instances without the
 * key skip the stage, so the default instance is unchanged.
 */

/** Liveness line while the lint agent runs (one animated line on a TTY). */
export const LINT_HEARTBEAT_PREFIX = "wiki-sync: lint agent still running";

/** What the lint stage reports back to the cycle digest. */
export interface LintResult {
  /** The data-repo-relative path the prompt told the agent to write. */
  readonly reportPath: string;
  /** False when the agent finished without writing the report. */
  readonly reportWritten: boolean;
  /** The agent's final report (stdout). */
  readonly summary: string;
}

/** The data-repo-relative lint report path for a run's date. */
export function lintReportPath(now: () => Date): string {
  return `outputs/lint-${now().toISOString().slice(0, 10)}.md`;
}

export interface LintOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The raw dir; its parent is the data repo the agent runs in. */
  readonly rawDir: string;
  /** Directory holding lint.md. */
  readonly promptsDir: string;
  /** Environment for child processes; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock for the report path date; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Agent runner; defaults to the real non-interactive invocation. */
  readonly runAgent?: AgentRunner | undefined;
  /** Kill the agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while the agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

/** The agent's expected report path as an absolute check path. */
function absoluteReportPath(dataRoot: string, reportPath: string): string {
  return join(dataRoot, ...reportPath.split("/"));
}

/**
 * One headless lint run (guide §17): invoke the agent with
 * prompts/lint.md in the data repo root, guardrail the result, and
 * auto-revert on a tripped check — the same contract the ingest stage
 * applies to its agent run.
 */
export async function runLintStage(options: LintOptions): Promise<LintResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});
  const dataRoot = dirname(options.rawDir);
  const settings = await loadAgentSettings(options.settingsPath);

  onProgress("wiki-sync: lint — reading prompts/lint.md");

  const reportPath = lintReportPath(now);
  const promptText = (
    await readPrompt(join(options.promptsDir, "lint.md"))
  ).replaceAll("outputs/lint-<YYYY-MM-DD>.md", reportPath);
  const args = [
    ...(settings.provider ? ["--provider", settings.provider] : []),
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    promptText,
  ];
  const runAgent = options.runAgent ?? spawnAgent;
  const pre = await capturePreRunState(dataRoot, env);

  const providerFlag = settings.provider
    ? ` --provider ${settings.provider}`
    : "";

  onProgress(
    `wiki-sync: lint — invoking agent: ${settings.command}${providerFlag} --model ${settings.model} --thinking ${settings.reasoning}`,
  );

  const startedAt = now().getTime();
  const heartbeat = setInterval(() => {
    const elapsed = formatDuration(now().getTime() - startedAt);

    onProgress(`${LINT_HEARTBEAT_PREFIX} (${elapsed})`);
  }, options.heartbeatMs ?? 60_000);

  let stdout = "";
  let agentError: unknown;

  try {
    ({ stdout } = await runAgent(settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs: options.timeoutMs,
    }));
  } catch (error) {
    agentError = error;
  } finally {
    clearInterval(heartbeat);
  }

  if (agentError === undefined) {
    onProgress("wiki-sync: lint — agent finished");
  }

  const post = await runGuardrails(dataRoot, env, pre);

  if (post.failure !== undefined) {
    const failure = post.failure;

    onProgress(
      `wiki-sync: lint guardrail check ${failure.check} (${failure.name}) failed — reverting to ${pre.commit.slice(0, 8)}`,
    );

    await revertToPreRun(dataRoot, env, pre, post.entries);

    throw new Error(
      `lint guardrail check ${failure.check} (${failure.name}) failed; reverted to ${pre.commit.slice(0, 8)} — ${failure.problems.join("; ")}`,
      { cause: agentError },
    );
  }

  onProgress("wiki-sync: lint — guardrails passed");

  if (agentError !== undefined) {
    throw agentError;
  }

  const reportWritten = await stat(
    absoluteReportPath(dataRoot, reportPath),
  ).then(
    () => true,
    () => false,
  );

  return { reportPath, reportWritten, summary: stdout };
}

/** What the crosslink stage reports back to the cycle digest. */
export interface CrosslinksResult {
  /** The expanded domain wiki dirs the audit ran against. */
  readonly domains: readonly string[];
  /** Cross-wiki links found in the audited wiki. */
  readonly external: number;
  /** Markdown pages scanned across the domain wikis. */
  readonly domainPages: number;
}

export interface CrosslinksOptions {
  /** The raw dir; its parent's wiki/ dir is the audited wiki. */
  readonly rawDir: string;
  /** Domain wiki dirs from the settings' `secondBrain.domains`;
   *  undefined or absent (the key missing) skips the stage entirely. */
  readonly domains?: readonly string[] | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
  /** Home dir for `~` expansion in domains; default: `os.homedir()`. */
  readonly home?: string;
}

/**
 * The crosslink stage (issue #96): run the check-crosslinks core
 * over the data repo's wiki against every configured domain wiki —
 * every cycle, after lint, whatever the ingest stage did. A broken
 * or forbidden link throws (one `file:line -> [[link]]` item per
 * problem), stopping the cycle before the commit like a lint
 * failure; a misconfigured domain dir (no sibling manifest) fails
 * the same way. Nothing reverts: the agent run already passed its
 * guardrails, and the uncommitted diff is the fix surface.
 */
export async function runCrosslinksStage(
  options: CrosslinksOptions,
): Promise<CrosslinksResult | undefined> {
  if (options.domains === undefined) {
    return undefined;
  }

  const onProgress = options.onProgress ?? (() => {});
  const domains = options.domains.map((dir) => expandHome(dir, options.home));

  onProgress(
    `wiki-sync: crosslinks — auditing against ${pluralized(domains.length, "domain wiki")}`,
  );

  const report = await checkCrossWikiLinks(
    join(dirname(options.rawDir), "wiki"),
    ...domains,
  );

  if (report.problems.length > 0) {
    throw new Error(`crosslink audit failed — ${report.problems.join("; ")}`);
  }

  return {
    domains,
    external: report.external,
    domainPages: report.domainPages,
  };
}

/** One cycle commit: what the message summarizes. */
export interface CommitSummary {
  readonly sourcesCount: number;
  /** e.g. `1 added, 0 changed, 0 removed`. */
  readonly sourcesLine: string;
  readonly pagesCreated: number;
  readonly pagesUpdated: number;
  /** Data-repo-relative lint report path; undefined when none was written. */
  readonly lintReport: string | undefined;
}

/** The commit message: sources processed, pages touched, lint report. */
export function formatCommitMessage(summary: CommitSummary): string {
  const sources =
    summary.sourcesCount === 1
      ? "1 source processed"
      : `${summary.sourcesCount} sources processed`;
  const pagesTouched = summary.pagesCreated + summary.pagesUpdated;
  const pages =
    pagesTouched === 1 ? "1 page touched" : `${pagesTouched} pages touched`;
  const lines = [
    `wiki-sync: ${sources}, ${pages}`,
    "",
    `- sources: ${summary.sourcesLine}`,
    `- pages: ${summary.pagesCreated} created, ${summary.pagesUpdated} updated`,
  ];

  if (summary.lintReport !== undefined) {
    lines.push(`- lint: ${summary.lintReport}`);
  }

  return lines.join("\n");
}

/** The cycle's commit outcome. */
export type CommitResult =
  | {
      readonly status: "committed";
      readonly hash: string;
      readonly message: string;
    }
  | { readonly status: "nothing-to-commit" };

/** Commit paths in the data repo; outputs/ only when it holds
 *  something git can act on. Since the manifest snapshot moved there
 *  (issue #112) the directory always exists — but it is ignored, and
 *  `git commit -- outputs` fails on a pathspec nothing known to git
 *  matches. */
async function commitPathspecs(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const pathspecs = ["wiki", "raw"];

  if (
    await stat(join(dataRoot, "outputs")).then(
      () => true,
      () => false,
    )
  ) {
    const { stdout } = await runGit(
      dataRoot,
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain",
        "-uall",
        "--",
        "outputs",
      ],
      env,
    );

    if (parseStatus(stdout).length > 0) {
      pathspecs.push("outputs");
    }
  }

  return pathspecs;
}

/** Stage wiki/, raw/, and outputs/ in the data repo and commit them. */
async function commitDataRepo(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  message: string,
): Promise<CommitResult> {
  const pathspecs = await commitPathspecs(dataRoot, env);
  const { stdout } = await runGit(
    dataRoot,
    [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain",
      "-uall",
      "--",
      ...pathspecs,
    ],
    env,
  );

  if (parseStatus(stdout).length === 0) {
    return { status: "nothing-to-commit" };
  }

  await runGit(dataRoot, ["add", "-A", "--", ...pathspecs], env);
  await runGit(
    dataRoot,
    ["commit", "--quiet", "-m", message, "--", ...pathspecs],
    env,
  );

  const { stdout: hash } = await runGit(dataRoot, ["rev-parse", "HEAD"], env);

  return { status: "committed", hash: hash.trim(), message };
}

/** Everything one wiki-sync cycle reports. */
export interface WikiSyncResult {
  readonly sync: SyncReport;
  readonly ingest: IngestResult;
  /** Undefined when the ingest stage skipped (nothing to lint). */
  readonly lint: LintResult | undefined;
  /** Undefined when the instance has no `secondBrain.domains` key. */
  readonly crosslinks: CrosslinksResult | undefined;
  readonly commit: CommitResult;
}

export interface WikiSyncOptions {
  /** Path to `sync.json`. */
  readonly configPath: string;
  /** The `raw/` directory; its parent is the data repo. */
  readonly rawDir: string;
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** Digest destination (the code repo's outputs/); the manifest
   *  snapshot lives in the data repo's outputs/ (issue #112). */
  readonly outputsDir: string;
  /** Directory holding ingest.md, incremental.md, and lint.md. */
  readonly promptsDir: string;
  /** Environment for child processes; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock for digests; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Agent runner for both agent stages; defaults to the real one. */
  readonly runAgent?: AgentRunner;
  /** Kill either agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while an agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

/** Count a sync report's copied and removed notes across every vault. */
function syncChangeCounts(sync: SyncReport): {
  copied: number;
  removed: number;
} {
  return {
    copied: sync.vaults.reduce(
      (total, vault) => total + vault.copied.length,
      0,
    ),
    removed: sync.vaults.reduce(
      (total, vault) => total + vault.removed.length,
      0,
    ),
  };
}

/** The commit summary of one cycle: ingest diff counts when the agent
 *  ran, the sync report's counts otherwise. */
async function commitSummaryOf(
  sync: SyncReport,
  ingest: IngestResult,
  lint: LintResult | undefined,
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<CommitSummary> {
  const pages = await wikiPages(dataRoot, env);

  if (ingest.status === "ran") {
    const added = sourceCount(ingest.diff, "added");
    const changed = sourceCount(ingest.diff, "changed");
    const removed = sourceCount(ingest.diff, "removed");

    return {
      sourcesCount: added + changed + removed,
      sourcesLine: `${added} added, ${changed} changed, ${removed} removed`,
      pagesCreated: pages.created.length,
      pagesUpdated: pages.updated.length,
      lintReport: lint?.reportWritten ? lint.reportPath : undefined,
    };
  }

  const { copied, removed } = syncChangeCounts(sync);

  return {
    sourcesCount: copied + removed,
    sourcesLine: `${copied} copied, ${removed} removed by sync (no ingest)`,
    pagesCreated: pages.created.length,
    pagesUpdated: pages.updated.length,
    lintReport: undefined,
  };
}

/**
 * One full cycle: sync → ingest → lint → crosslinks → commit. Any
 * stage failure stops the chain and rejects (the CLI exits 1);
 * guardrail failures have already reverted their agent run. With no
 * changed sources the ingest stage skips on its own, lint is skipped
 * with it, and a clean data repo commits nothing — cost scales with
 * activity, not the clock. The configured crosslink audit still runs
 * every cycle: its discipline holds or the cycle fails. The ingest
 * skip also keys on the manifest snapshot, so a run whose agent
 * failed (snapshot untouched) is retried by the next cycle even when
 * sync then reports no changes.
 */
export async function runWikiSync(
  options: WikiSyncOptions,
): Promise<WikiSyncResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});
  const dataRoot = dirname(options.rawDir);
  const { secondBrainDomains: domains } = await loadAgentSettings(
    options.settingsPath,
  );
  const total = domains === undefined ? 4 : 5;

  onProgress(`wiki-sync: stage 1/${total} — sync-vault`);

  const sync = await runSync({
    configPath: options.configPath,
    rawDir: options.rawDir,
    now,
    onProgress,
  });

  onProgress(`wiki-sync: stage 2/${total} — wiki-ingest`);

  const ingest = await runWikiIngest({
    settingsPath: options.settingsPath,
    rawDir: options.rawDir,
    outputsDir: options.outputsDir,
    promptsDir: options.promptsDir,
    env,
    now,
    runAgent: options.runAgent,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    onProgress,
  });

  let lint: LintResult | undefined;

  if (ingest.status === "ran") {
    onProgress(`wiki-sync: stage 3/${total} — lint`);

    lint = await runLintStage({
      settingsPath: options.settingsPath,
      rawDir: options.rawDir,
      promptsDir: options.promptsDir,
      env,
      now,
      runAgent: options.runAgent,
      timeoutMs: options.timeoutMs,
      heartbeatMs: options.heartbeatMs,
      onProgress,
    });
  } else {
    onProgress(`wiki-sync: stage 3/${total} — lint skipped (no ingest ran)`);
  }

  let crosslinks: CrosslinksResult | undefined;

  if (domains !== undefined) {
    onProgress(`wiki-sync: stage 4/${total} — crosslinks`);
    crosslinks = await runCrosslinksStage({
      rawDir: options.rawDir,
      domains,
      onProgress,
    });
  }

  onProgress(`wiki-sync: stage ${total}/${total} — commit`);

  const summary = await commitSummaryOf(sync, ingest, lint, dataRoot, env);

  return {
    sync,
    ingest,
    lint,
    crosslinks,
    commit: await commitDataRepo(dataRoot, env, formatCommitMessage(summary)),
  };
}

function pluralized(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** One line per vault: what sync copied and removed. */
function syncSummaryLines(sync: SyncReport): string[] {
  const { copied, removed } = syncChangeCounts(sync);
  const pruned = sync.prunedNamespaces.length;

  if (copied === 0 && removed === 0 && pruned === 0) {
    return ["no source changes"];
  }

  return [
    `${pluralized(copied, "source")} copied, ${pluralized(removed, "source")} removed` +
      (pruned === 0 ? "" : `, ${pluralized(pruned, "namespace")} pruned`),
  ];
}

/** The digest's crosslink sentence, shared by the full digest and
 *  the nothing-to-do line: what was audited and that it holds. */
function crosslinksLine(crosslinks: CrosslinksResult): string {
  return `${pluralized(crosslinks.external, "cross-wiki link")} against ${pluralized(crosslinks.domainPages, "domain page")}`;
}

/**
 * The final printed digest: counts first, details after — the sync
 * summary, the lint summary, the commit hash, then the full ingest
 * digest.
 */
export function formatFinalDigest(result: WikiSyncResult): string {
  const { commit, crosslinks, ingest, lint, sync } = result;

  if (commit.status === "nothing-to-commit" && ingest.status === "skipped") {
    const audit =
      crosslinks === undefined
        ? ""
        : `; crosslink audit passed — ${crosslinksLine(crosslinks)}`;

    return `wiki-sync: nothing to do — ${ingest.reason}${audit}\n`;
  }

  const lines: string[] = [
    "# wiki-sync cycle digest",
    "",
    `- **Sync:** ${syncSummaryLines(sync).join("; ")}`,
  ];

  if (ingest.status === "ran") {
    lines.push(`- **Ingest:** ${ingest.mode} — digest below`);
  } else {
    lines.push(`- **Ingest:** skipped — ${ingest.reason}`);
  }

  if (lint === undefined) {
    lines.push("- **Lint:** skipped — no ingest ran");
  } else {
    lines.push(
      `- **Lint:** ${lint.reportWritten ? `report \`${lint.reportPath}\`` : `report not written (expected \`${lint.reportPath}\`)`} — summary below`,
    );
  }

  if (crosslinks !== undefined) {
    lines.push(`- **Crosslinks:** ok — ${crosslinksLine(crosslinks)}`);
  }

  if (commit.status === "committed") {
    lines.push(`- **Commit:** \`${commit.hash.slice(0, 8)}\``);
  } else {
    lines.push("- **Commit:** nothing to commit");
  }

  if (lint !== undefined) {
    lines.push("", "## Lint summary", "", lint.summary.trimEnd());
  }

  if (ingest.status === "ran") {
    lines.push("", "## Ingest digest", "", ingest.digest.trimEnd());
  }

  return `${lines.join("\n")}\n`;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-sync [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]

Run the whole cycle in one command (guide §18, issue #13):
sync-vault → wiki-ingest → headless lint (prompts/lint.md) →
crosslink audit (configured second brains) → one data-repo commit.
Every stage stays independently runnable for debugging; this
command only chains them.

  --settings <path>  Agent settings file (command, model, provider,
                     reasoning) for both agent stages — ingest and
                     lint — and the optional secondBrain.domains list
                     of the crosslink stage. Provider is optional.
                     Default: the repo's settings.yml.
  --outputs <dir>    Where the ingest digest (runs/<timestamp>.md) goes.
                     Default: the repo's outputs/. The manifest snapshot
                     always lives in the data repo's outputs/ and is not
                     moved by this switch (issue #112).
  --timeout <secs>   Kill either agent run after this many seconds
                     and fail the cycle. Default: 1800 (30 minutes).
  -h, --help         Print this help and exit; no side effects.
  <config>           Path to sync.json. Default: the repo's own
                     sync.json.
  <raw-dir>          raw/ directory; its parent is the data repo the
                     agents run in and the commit lands in. Default:
                     <dataRoot>/raw from the config, otherwise the
                     repo's own raw/.

What it does, stage by stage:
  1. sync — sync-vault: project the vaults into raw/ (deterministic).
  2. ingest — wiki-ingest: run the wiki agent over the changed
     sources, guardrail-check it (auto-revert on failure), and write
     the digest to the code repo's outputs/runs/ (gitignored).
  3. lint — run the agent headless with prompts/lint.md; the report
     lands in the DATA repo's outputs/ and is committed with the
     cycle. Same guardrails and auto-revert as the ingest stage.
  4. crosslinks — only for instances whose settings carry a
     secondBrain.domains list ([<wiki dirs>], comma-separated,
     brackets optional): run the check-crosslinks audit of the data
     repo's wiki/ against every listed domain wiki — every cycle,
     including no-change cycles. One broken or forbidden
     [[<vault>/<page>]] link fails the cycle before the commit
     (nothing reverts; the uncommitted diff is the fix surface).
     Instances without the key skip the stage.
  5. commit — stage wiki/, raw/, and outputs/ in the data repo and
     commit with a message summarizing sources processed and pages
     touched.

With no changed sources the agent stages skip (cost scales with
activity, not the clock), a clean data repo commits nothing, and the
command exits 0; a configured crosslink audit still runs. A failed
previous ingest is retried even when sync reports no changes — the
skip keys on the manifest snapshot, which a failed run leaves
untouched. A failure at any stage stops the chain and exits 1; a
tripped guardrail has already reverted its agent run.

The final digest on stdout — sync summary, lint summary, the commit
hash, and the full ingest digest — plus git log -1 in the data repo
tell the whole story of the run. Live progress goes to stderr.
Scheduling is #14; publish/mirror is #15.`;

function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  console.error(colors().red(`wiki-sync: ${message}`));
  process.exitCode = 1;
}

/** wiki-sync entry point: `wiki-sync [-h | --help] [--settings <path>] [--timeout <secs>] [<config>] [<raw-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const values = new Map<string, string | undefined>();
  const consumed = new Set<number>();

  for (const flag of ["--settings", "--outputs", "--timeout"]) {
    const index = args.indexOf(flag);

    if (index !== -1) {
      values.set(flag, args[index + 1]);
      consumed.add(index);
      consumed.add(index + 1);
    }
  }

  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (consumed.has(index)) {
      continue;
    }

    if (arg.startsWith("-")) {
      fail(`unknown option ${JSON.stringify(arg)}`);

      return;
    }

    positional.push(arg);
  }

  if (positional.length > 2) {
    fail(
      `expected at most two arguments (<config> and <raw-dir>), got ${positional.length}`,
    );

    return;
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

  const settingsPath =
    values.get("--settings") ?? join(repoRoot, "settings.yml");
  const animated = process.stderr.isTTY === true && !process.env.NO_COLOR;
  const sink = createAgentProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    colors(),
    [...AGENT_HEARTBEAT_PREFIX, LINT_HEARTBEAT_PREFIX],
  );

  try {
    const configPath = positional[0] ?? join(repoRoot, "sync.json");
    const config = await loadSyncConfig(configPath, homedir());
    const rawDir = positional[1] ?? resolveRawDir(config.dataRoot, repoRoot);
    const result = await runWikiSync({
      configPath,
      rawDir,
      settingsPath,
      outputsDir: values.get("--outputs") ?? join(repoRoot, "outputs"),
      promptsDir: join(repoRoot, "prompts"),
      timeoutMs:
        timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
      heartbeatMs: animated ? 100 : undefined,
      onProgress: sink.render,
    });

    sink.end();
    console.log(formatFinalDigest(result));
  } catch (error) {
    sink.end();
    console.error(
      colors().red(
        `wiki-sync: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url);

/* v8 ignore next: covered only under `node src/sync/wiki-sync.ts` */
if (isMain) {
  await main();
}
