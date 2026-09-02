import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../cli/colors.ts";
import { flagValueError, readFlagValues } from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { formatDuration, stderrSink } from "../cli/progress.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseStatus, runGit, type StatusEntry } from "../data/git.ts";
import {
  type AgentRunner,
  readPrompt,
  spawnAgent,
} from "../ingest/agent-run.ts";
import {
  type AgentSettings,
  agentArgs,
  formatAgentInvocation,
  loadAgentSettings,
} from "../ingest/agent-settings.ts";
import {
  capturePreRunState,
  type PreRunState,
  revertToPreRun,
  runGuardrails,
} from "../ingest/guardrails.ts";
import {
  AGENT_HEARTBEAT_PREFIX,
  type IngestResult,
  runWikiIngest,
  sourceCount,
  type WikiPages,
  wikiPages,
} from "../ingest/wiki-ingest.ts";
import { checkCrossWikiLinks } from "../wiki/crosslinks.ts";
import {
  checkWikiFidelity,
  type FidelityReport,
  summarizeFidelity,
} from "../wiki/fidelity.ts";
import {
  checkWikiProvenance,
  type ProvenanceReport,
  summarizeProvenance,
} from "../wiki/provenance.ts";
import {
  expandHome,
  loadSyncConfig,
  type PublishConfig,
  resolveRawDir,
  type SourceConfig,
  type SyncConfig,
} from "./config.ts";
import type {
  DriverOptions,
  RepoSyncReport,
  SyncReport,
} from "./projection.ts";
import { type PublishResult, runPublishStage } from "./publish.ts";
import { runRepoSync } from "./sync-repo.ts";
import { runVaultSync } from "./sync-vault.ts";

/**
 * wiki-sync: the one-command orchestrator (guide §18, issue #13). It
 * chains the proven pieces — sync (sync-vault for vault sources,
 * sync-repo for repo sources, issue #145) → wiki-ingest → headless
 * lint (§17, prompts/lint.md) → crosslink audit (issue #96,
 * configured second brains only) → verification (issue #138) →
 * data-repo commit — and prints one digest: the run's ingest digest,
 * the lint summary, the audit result, the fidelity and provenance
 * results, and the commit hash. Nothing here is new capability;
 * every stage stays independently runnable (guide §8).
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
 * check-crosslinks core (src/wiki/crosslinks.ts) run over its wiki
 * against
 * every listed domain wiki, after lint and before the commit. A
 * failed audit fails the cycle like lint does; instances without the
 * key skip the stage, so the default instance is unchanged.
 *
 * The verification stage (issue #138) runs the deterministic
 * check-fidelity (issue #125) and check-provenance (issue #65) cores
 * over the data repo's wiki/ and raw/ every cycle, after lint and the
 * crosslink audit. One problem line per finding fails the cycle
 * before the commit: the lint edits are reverted (the ingest edits
 * stay, uncommitted, as the fix surface), mirroring the lint stage's
 * own failure semantics.
 *
 * The publish stage (guide §26, issue #15) copies the data repo's
 * include-matched files into the configured mirror vault — verbatim,
 * or re-based to vault root when `publish.root` is configured (issue
 * #203) — the iCloud-served reading copy for iPhone and iPad. It runs after
 * the commit, every cycle, so a mirror the transport mangled is
 * healed by the next run; deletions included, the device-side
 * `.obsidian/` state preserved, byte-identical files never rewritten
 * (idempotent). A publish failure fails the cycle after the commit
 * has landed; the next run retries the copy.
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
  /** The post-run status the stage's guardrails produced; the cycle's
   *  commit summary reuses it instead of spawning git again (B-10:
   *  no hidden child-process run inside the summary builder). */
  readonly entries: readonly StatusEntry[];
}

/** The data-repo-relative lint report path for a run's date. */
export function lintReportPath(now: () => Date): string {
  return `outputs/lint-${now().toISOString().slice(0, 10)}.md`;
}

export interface LintOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** Agent settings when the caller already loaded them — the cycle
   *  loads once and threads them (R-1, one settings.yml parse per
   *  run); loaded from `settingsPath` otherwise. */
  readonly settings?: AgentSettings | undefined;
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
  /** Pre-run state captured by the caller (the wiki-sync cycle
   *  captures it once so its verification stage can revert to the
   *  same point); captured here when absent. */
  readonly pre?: PreRunState | undefined;
}

/** The agent's expected report path as an absolute check path. */
function absoluteReportPath(dataRoot: string, reportPath: string): string {
  return join(dataRoot, ...reportPath.split("/"));
}

/** The lint agent run's outcome: its stdout, or the failure that
 *  must wait for the guardrail check before it escapes. */
interface LintAgentRun {
  readonly stdout: string;
  readonly error: unknown;
}

/** Invoke the lint agent under its heartbeat line. The run's failure
 *  is captured, not thrown: the guardrails must run first, and a
 *  guardrail failure names the agent error as its cause. */
async function invokeLintAgent(
  settings: AgentSettings,
  args: readonly string[],
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  runAgent: AgentRunner,
  timeoutMs: number | undefined,
  heartbeatMs: number | undefined,
  onProgress: (message: string) => void,
  now: () => Date,
): Promise<LintAgentRun> {
  const startedAt = now().getTime();
  const heartbeat = setInterval(() => {
    const elapsed = formatDuration(now().getTime() - startedAt);

    onProgress(`${LINT_HEARTBEAT_PREFIX} (${elapsed})`);
  }, heartbeatMs ?? 60_000);

  let stdout = "";
  let error: unknown;

  try {
    ({ stdout } = await runAgent(settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs,
    }));
  } catch (caught) {
    error = caught;
  } finally {
    clearInterval(heartbeat);
  }

  if (error === undefined) {
    onProgress("wiki-sync: lint — agent finished");
  }

  return { stdout, error };
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
  const settings =
    options.settings ??
    (await loadAgentSettings(options.settingsPath, { onProgress }));

  onProgress("wiki-sync: lint — reading prompts/lint.md");

  const reportPath = lintReportPath(now);
  const promptText = (
    await readPrompt(join(options.promptsDir, "lint.md"))
  ).replaceAll("outputs/lint-<YYYY-MM-DD>.md", reportPath);
  const args = agentArgs(settings, promptText);
  const runAgent = options.runAgent ?? spawnAgent;
  const pre = options.pre ?? (await capturePreRunState(dataRoot, env));

  onProgress(
    `wiki-sync: lint — invoking agent: ${formatAgentInvocation(settings)}`,
  );

  const { stdout, error: agentError } = await invokeLintAgent(
    settings,
    args,
    dataRoot,
    env,
    runAgent,
    options.timeoutMs,
    options.heartbeatMs,
    onProgress,
    now,
  );

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

  return {
    reportPath,
    reportWritten,
    summary: stdout,
    entries: post.entries,
  };
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

/** What the verification stage reports back to the cycle digest. */
export interface VerificationResult {
  readonly fidelity: FidelityReport;
  readonly provenance: ProvenanceReport;
}

export interface VerificationOptions {
  /** The raw dir; its parent's wiki/ dir is the checked wiki. */
  readonly rawDir: string;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

/**
 * The verification stage (issue #138): run the deterministic
 * check-fidelity (issue #125) and check-provenance (issue #65) cores
 * over the data repo's wiki/ and raw/ — every cycle, after lint and
 * the crosslink audit, whatever the ingest stage did. One problem
 * line per finding throws (fidelity first, provenance second),
 * stopping the cycle before the commit; the caller owns the revert.
 */
export async function runVerificationStage(
  options: VerificationOptions,
): Promise<VerificationResult> {
  const onProgress = options.onProgress ?? (() => {});

  onProgress(
    "wiki-sync: verification — checking citation fidelity and provenance",
  );

  const wikiDir = join(dirname(options.rawDir), "wiki");
  const fidelity = await checkWikiFidelity(wikiDir, options.rawDir);

  failProblems("fidelity", fidelity.problems);

  const provenance = await checkWikiProvenance(wikiDir, options.rawDir);

  failProblems("provenance", provenance.problems);

  return { fidelity, provenance };
}

/** Fail the cycle naming one problem line per finding: the shared
 *  failure shape of the stage's two checks. */
function failProblems(
  check: "fidelity" | "provenance",
  problems: readonly string[],
): void {
  if (problems.length > 0) {
    throw new Error(`${check} check failed:\n${problems.join("\n")}`);
  }
}

/** One cycle commit: what the message summarizes. */
export interface CommitSummary {
  readonly sourcesCount: number;
  /** e.g. `1 added, 0 changed, 0 removed, 0 renamed`. */
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
  /** The stage-1 report — source-neutral: one row per source the
   *  driver table picked for the config's source kinds (issue #250). */
  readonly sync: SyncReport;
  readonly ingest: IngestResult;
  /** Undefined when the ingest stage skipped (nothing to lint). */
  readonly lint: LintResult | undefined;
  /** Undefined when the instance has no `secondBrain.domains` key. */
  readonly crosslinks: CrosslinksResult | undefined;
  /** The fidelity + provenance reports; the checks run every cycle. */
  readonly verification: VerificationResult;
  readonly commit: CommitResult;
  /** Undefined when the config has no `publish` section (issue #15). */
  readonly publish?: PublishResult | undefined;
}

export interface WikiSyncOptions {
  /** Path to `sync.json`. */
  readonly configPath: string;
  /** The parsed sync config when the caller already holds it — the
   *  CLI parses once (raw-dir resolution) and threads it (R-1, one
   *  sync.json parse per run); parsed from `configPath` otherwise. */
  readonly config?: SyncConfig | undefined;
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

/** Count a sync report's copied and removed notes across every
 *  source row — vault or repo. */
function syncChangeCounts(sync: SyncReport): {
  copied: number;
  removed: number;
} {
  return {
    copied: sync.sources.reduce(
      (total, source) => total + source.copied.length,
      0,
    ),
    removed: sync.sources.reduce(
      (total, source) => total + source.removed.length,
      0,
    ),
  };
}

/** The commit summary of one cycle: ingest diff counts when the agent
 *  ran, the sync report's counts otherwise. The page counts come from
 *  the caller — the status snapshot the cycle already holds (B-10:
 *  the summary builder hides no git child-process run). */
function commitSummaryOf(
  sync: SyncReport,
  ingest: IngestResult,
  lint: LintResult | undefined,
  pages: WikiPages,
): CommitSummary {
  if (ingest.status === "ran") {
    const added = sourceCount(ingest.diff, "added");
    const changed = sourceCount(ingest.diff, "changed");
    const removed = sourceCount(ingest.diff, "removed");
    const renamed = sourceCount(ingest.diff, "renamed");

    return {
      sourcesCount: added + changed + removed + renamed,
      sourcesLine: `${added} added, ${changed} changed, ${removed} removed, ${renamed} renamed`,
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

/** The config's single source kind: mixed kinds refuse (issue #145,
 *  one instance per config), an empty config stays vault-kind so the
 *  vault driver's empty-config safety holds. */
function syncKindOf(
  config: SyncConfig,
  configPath: string,
): SourceConfig["kind"] {
  const kinds = new Set(config.vaults.map((source) => source.kind));

  if (kinds.has("vault") && kinds.has("repo")) {
    throw new Error(
      `mixed source kinds in ${configPath}: one instance per config — vault sources for sync-vault, a repo source for sync-repo`,
    );
  }

  return kinds.has("repo") ? "repo" : "vault";
}

/** The sync driver table (issue #250): one row per source kind, keyed
 *  by the config's source kinds — a future source kind (devices,
 *  mirror) is a row, not a copy of the cycle. */
const DRIVERS: Record<
  SourceConfig["kind"],
  (options: DriverOptions) => Promise<SyncReport>
> = {
  vault: runVaultSync,
  repo: runRepoSync,
};

/** The cycle's stage names in run order (the stage table, issue
 *  #250): crosslinks only for instances whose settings carry a
 *  `secondBrain.domains` key, publish only for configs with a
 *  publish section. Every stage line numbers itself from this
 *  table — no scattered stage arithmetic. */
export function stageNames(options: {
  readonly domains: readonly string[] | undefined;
  readonly publish: PublishConfig | undefined;
}): readonly string[] {
  const names = ["sync", "ingest", "lint"];

  if (options.domains !== undefined) {
    names.push("crosslinks");
  }

  names.push("verification", "commit");

  if (options.publish !== undefined) {
    names.push("publish");
  }

  return names;
}

/** One stage's progress line, numbered by its table position. */
export function stageLine(stages: readonly string[], name: string): string {
  return `wiki-sync: stage ${stages.indexOf(name) + 1}/${stages.length} — ${name}`;
}

/** Stage 1 (issue #145 dispatch): refuse mixed source kinds, then run
 *  the driver table's row for the config's kind — same cycle, same
 *  lint → verification → commit flow, whatever the source kind. */
async function runSyncStage(
  config: SyncConfig,
  options: WikiSyncOptions,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  onProgress: (message: string) => void,
  stages: readonly string[],
): Promise<SyncReport> {
  const kind = syncKindOf(config, options.configPath);

  onProgress(stageLine(stages, "sync"));

  return await DRIVERS[kind]({
    configPath: options.configPath,
    config,
    rawDir: options.rawDir,
    env,
    now,
    onProgress: (message) => onProgress(message.text),
  });
}

/** Stage 3: lint what the ingest agent produced, or skip the lint
 *  stage with it when no ingest ran. */
async function runLintOrSkip(
  options: WikiSyncOptions,
  ingest: IngestResult,
  stages: readonly string[],
  preLint: PreRunState,
  settings: AgentSettings,
): Promise<LintResult | undefined> {
  const onProgress = options.onProgress ?? (() => {});

  if (ingest.status !== "ran") {
    onProgress(`${stageLine(stages, "lint")} skipped (no ingest ran)`);

    return undefined;
  }

  onProgress(stageLine(stages, "lint"));

  return await runLintStage({
    settingsPath: options.settingsPath,
    settings,
    rawDir: options.rawDir,
    promptsDir: options.promptsDir,
    env: options.env ?? process.env,
    now: options.now ?? (() => new Date()),
    runAgent: options.runAgent,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    onProgress,
    pre: preLint,
  });
}

/** Stage 4: the configured crosslink audit; skipped outright when
 *  the instance carries no `secondBrain.domains` key. */
async function runCrosslinksOrSkip(
  options: WikiSyncOptions,
  domains: readonly string[] | undefined,
  onProgress: (message: string) => void,
  stages: readonly string[],
): Promise<CrosslinksResult | undefined> {
  if (domains === undefined) {
    return undefined;
  }

  onProgress(stageLine(stages, "crosslinks"));

  return await runCrosslinksStage({
    rawDir: options.rawDir,
    domains,
    onProgress,
  });
}

/** The verification stage with the cycle's revert semantics: on
 *  failure, revert the lint edits (the ingest edits stay) before
 *  rejecting. */
async function runVerificationWithRevert(
  options: WikiSyncOptions,
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  preLint: PreRunState,
  onProgress: (message: string) => void,
  stages: readonly string[],
): Promise<VerificationResult> {
  onProgress(stageLine(stages, "verification"));

  try {
    return await runVerificationStage({
      rawDir: options.rawDir,
      onProgress,
    });
  } catch (error) {
    onProgress(
      `wiki-sync: verification failed — reverting lint edits to ${preLint.commit.slice(0, 8)} (ingest edits kept)`,
    );

    const post = await runGuardrails(dataRoot, env, preLint);

    await revertToPreRun(dataRoot, env, preLint, post.entries);

    throw error;
  }
}

/** The final stage (issue #15): copy the wiki into the configured
 *  mirror vault — every cycle, after the commit; skipped outright
 *  when the config has no publish section. */
async function runPublishOrSkip(
  options: WikiSyncOptions,
  publish: PublishConfig | undefined,
  onProgress: (message: string) => void,
  stages: readonly string[],
): Promise<PublishResult | undefined> {
  if (publish === undefined) {
    return undefined;
  }

  onProgress(stageLine(stages, "publish"));

  return await runPublishStage({
    dataRoot: dirname(options.rawDir),
    mirror: publish.mirror,
    include: publish.include,
    root: publish.root,
    onProgress,
  });
}

/**
 * One full cycle: sync → ingest → lint → crosslinks → verification →
 * commit → publish. Stage 1 dispatches on the config's source kinds (issue
 * #145): vault sources run the sync-vault core, a repo-typed source
 * (the meta instance) runs the sync-repo core in-process — mixed
 * configs refuse. Any stage failure stops the chain and rejects (the
 * CLI exits 1); guardrail failures have already reverted their agent
 * run, and a verification failure reverts the lint edits (the ingest
 * edits stay) before rejecting. With no changed sources the ingest
 * stage skips on its own, lint is skipped with it, and a clean data
 * repo commits nothing — cost scales with activity, not the clock.
 * The configured crosslink audit and the verification checks still
 * run every cycle: their discipline holds or the cycle fails. The
 * ingest skip also keys on the manifest snapshot, so a run whose
 * agent failed (snapshot untouched) is retried by the next cycle
 * even when sync then reports no changes.
 *
 * The publish stage (issue #15) runs after the commit, every cycle:
 * a mirror the transport mangled is healed by the next run. A
 * publish failure fails the cycle after the commit has landed — the
 * next run retries the copy.
 */
export async function runWikiSync(
  options: WikiSyncOptions,
): Promise<WikiSyncResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});
  const dataRoot = dirname(options.rawDir);
  const settings = await loadAgentSettings(options.settingsPath, {
    onProgress,
  });
  const { secondBrainDomains: domains } = settings;
  const config =
    options.config ?? (await loadSyncConfig(options.configPath, homedir()));
  const stages = stageNames({ domains, publish: config.publish });
  const sync = await runSyncStage(
    config,
    options,
    env,
    now,
    onProgress,
    stages,
  );

  onProgress(stageLine(stages, "ingest"));

  const ingest = await runWikiIngest({
    settingsPath: options.settingsPath,
    settings,
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

  // The verification stage's revert target: everything the ingest
  // stage left, before the lint agent runs.
  const preLint = await capturePreRunState(dataRoot, env);

  const lint = await runLintOrSkip(options, ingest, stages, preLint, settings);
  const crosslinks = await runCrosslinksOrSkip(
    options,
    domains,
    onProgress,
    stages,
  );
  const verification = await runVerificationWithRevert(
    options,
    dataRoot,
    env,
    preLint,
    onProgress,
    stages,
  );

  onProgress(stageLine(stages, "commit"));

  // The commit summary's page counts, from the status snapshot the
  // cycle already holds: the lint stage's post-run entries when lint
  // ran; otherwise the pre-lint capture (nothing changes between it
  // and the commit on a lint-skip path — verification is read-only).
  const pages = await wikiPages(dataRoot, lint?.entries ?? preLint.status);
  const summary = commitSummaryOf(sync, ingest, lint, pages);

  return {
    sync,
    ingest,
    lint,
    crosslinks,
    verification,
    commit: await commitDataRepo(dataRoot, env, formatCommitMessage(summary)),
    publish: await runPublishOrSkip(
      options,
      config.publish,
      onProgress,
      stages,
    ),
  };
}

function pluralized(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** One line per source: what sync copied and removed; a repo run
 *  also names the commit its projection is stamped with. */
function syncSummaryLines(sync: SyncReport): string[] {
  const { copied, removed } = syncChangeCounts(sync);
  const pruned = sync.prunedNamespaces.length;

  if (copied === 0 && removed === 0 && pruned === 0) {
    return ["no source changes"];
  }

  const commit = sync.sources.find(
    (source): source is RepoSyncReport => source.kind === "repo",
  )?.commit;

  return [
    `${pluralized(copied, "source")} copied, ${pluralized(removed, "source")} removed` +
      (pruned === 0 ? "" : `, ${pluralized(pruned, "namespace")} pruned`) +
      (commit === undefined ? "" : ` at commit ${commit.slice(0, 8)}`),
  ];
}

/** The digest's crosslink sentence, shared by the full digest and
 *  the nothing-to-do line: what was audited and that it holds. */
function crosslinksLine(crosslinks: CrosslinksResult): string {
  return `${pluralized(crosslinks.external, "cross-wiki link")} against ${pluralized(crosslinks.domainPages, "domain page")}`;
}

/** The one-line digest of a no-op cycle — nothing to commit after
 *  a skipped ingest, and publish (when configured) copied and removed
 *  nothing; undefined whenever the cycle did real work. */
function nothingToDoLine(result: WikiSyncResult): string | undefined {
  const { commit, crosslinks, ingest, publish } = result;

  if (commit.status !== "nothing-to-commit" || ingest.status !== "skipped") {
    return undefined;
  }

  if (publish !== undefined && publish.copied + publish.removed > 0) {
    return undefined;
  }

  const audit =
    crosslinks === undefined
      ? ""
      : `; crosslink audit passed — ${crosslinksLine(crosslinks)}`;

  return `wiki-sync: nothing to do — ${ingest.reason}${audit}; fidelity + provenance ok\n`;
}

/**
 * The final printed digest: counts first, details after — the sync
 * summary, the lint summary, the commit hash, then the full ingest
 * digest.
 */
export function formatFinalDigest(result: WikiSyncResult): string {
  const { commit, crosslinks, ingest, lint, sync, verification } = result;
  const nothing = nothingToDoLine(result);

  if (nothing !== undefined) {
    return nothing;
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

  lines.push(
    `- **Fidelity:** ok — ${summarizeFidelity(verification.fidelity)}`,
  );
  lines.push(
    `- **Provenance:** ok — ${summarizeProvenance(verification.provenance)}`,
  );

  if (commit.status === "committed") {
    lines.push(`- **Commit:** \`${commit.hash.slice(0, 8)}\``);
  } else {
    lines.push("- **Commit:** nothing to commit");
  }

  if (result.publish !== undefined) {
    lines.push(
      `- **Publish:** ok — ${pluralized(result.publish.copied, "file")} copied, ${pluralized(result.publish.removed, "file")} removed`,
    );
  }

  if (lint !== undefined) {
    lines.push("", "## Lint summary", "", lint.summary.trimEnd());
  }

  if (ingest.status === "ran") {
    lines.push("", "## Ingest digest", "", ingest.digest.trimEnd());
  }

  return `${lines.join("\n")}\n`;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-sync [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]

Run the whole cycle in one command (guide §18):
sync (sync-vault for vault sources, sync-repo for repo sources) →
wiki-ingest → headless lint (prompts/lint.md) →
crosslink audit (configured second brains) → verification
(check-fidelity + check-provenance) → one data-repo
commit → mirror publish (configs with a publish
section). Every stage stays independently runnable for debugging;
this command only chains them.

  --settings <path>  Agent settings file (command, model, provider,
                     reasoning) for both agent stages — ingest and
                     lint — and the optional secondBrain.domains list
                     of the crosslink stage. Provider is optional.
                     isolate (true by default, false to opt out) adds
                     the pi isolation flags --no-context-files
                     --no-extensions --no-skills to both agent runs
                     so global agent config cannot leak in.
                     isolate.skills and isolate.extensions
                     (optional comma-separated lists)
                     whitelist specific entries back in: one --skill
                     flag per skill dir (resolved against the
                     settings file's directory) and one -e flag per
                     extension source (a path, npm:<package>, or
                     git:<repo>). A missing entry warns and is
                     omitted; both keys are ignored with isolate:
                     false.
                     Default: the repo's settings.yml.
  --outputs <dir>    Where the ingest digest (runs/<timestamp>.md) goes.
                     Default: the repo's outputs/. The manifest snapshot
                     always lives in the data repo's outputs/ and is not
                     moved by this switch.
  --timeout <secs>   Kill either agent run after this many seconds
                     and fail the cycle. Default: 1800 (30 minutes).
  -h, --help         Print this help and exit; no side effects.
  <config>           Path to sync.json (vault sources) or a
                     repo-sourced config such as sync-meta.json
                     (source: "repo"). Default: the repo's own
                     sync.json.
  <raw-dir>          raw/ directory; its parent is the data repo the
                     agents run in and the commit lands in. Default:
                     <dataRoot>/raw from the config, otherwise the
                     repo's own raw/.

What it does, stage by stage:
  1. sync — vault configs: sync-vault projects the vaults into raw/
     (deterministic). Repo-sourced configs (source: "repo", e.g.
     sync-meta.json) run the sync-repo core instead: the allowlisted
     files of the committed source tree are projected verbatim into
     raw/notes/<name>/, stamped with the source HEAD commit; a dirty
     source tree fails the cycle (commit first). Mixed vault+repo
     configs are refused — one instance per config.
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
  5. verification — run the deterministic check-fidelity and
     check-provenance cores over the data
     repo's wiki/ and raw/ — every cycle, including no-change
     cycles, no configuration. One problem line per finding fails
     the cycle before the commit: the lint edits are reverted (the
     ingest edits stay, uncommitted, as the fix surface), mirroring
     the lint stage's failure semantics, and the command exits 1.
  6. commit — stage wiki/, raw/, and outputs/ in the data repo and
     commit with a message summarizing sources processed and pages
     touched.
  7. publish — only for configs whose sync.json carries a publish
     section (guide §26): copy the data repo's
     include-matched files (["wiki/**"] in the shipped config) into the
     mirror vault — an iCloud-served disposable reading copy for
     iPhone and iPad. With publish.root set ("wiki" in the shipped
     config) the top-level segment is stripped from every
     mirror path, so the wiki tree appears at vault root; without it
     the copy is verbatim. Deletions included: a page gone from the wiki
     is removed from the mirror; the mirror's own .obsidian/ device
     state is never touched; byte-identical files are never
     rewritten, so a second run over an intact mirror changes
     nothing (idempotent). Runs after the commit, every cycle —
     a mirror the transport mangled is healed by the next run. A
     publish failure fails the cycle (exit 1) after the commit has
     landed; the next run retries the copy. Instances without the
     publish section skip the stage.

With no changed sources the agent stages skip (cost scales with
activity, not the clock), a clean data repo commits nothing, and the
command exits 0; a configured crosslink audit and the verification
checks still run. A failed previous ingest is retried even when sync
reports no changes — the skip keys on the manifest snapshot, which a
failed run leaves untouched. A failure at any stage stops the chain
and exits 1; a tripped guardrail has already reverted its agent run,
and a verification failure has reverted the lint edits.

The final digest on stdout — sync summary, lint summary, the crosslink
audit (configured second brains), the fidelity and provenance results,
the commit hash, the publish summary (configured mirror), and the full
ingest digest — plus git log -1 in the data repo tell the whole story
of the run. Live progress goes to stderr. Unattended scheduling is
setup-schedule.`;

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-sync", message);
}

/** The parsed command line: the flag values and positionals, or the
 *  first usage error (`fail` prints it verbatim). */
interface ParsedArgs {
  readonly error: string | undefined;
  readonly positional: readonly string[];
  readonly values: Map<string, string | undefined>;
}

/** Pull the three value flags and the positionals out of argv,
 *  rejecting unknown options and more than two positionals. */
function parseCliArgs(args: readonly string[]): ParsedArgs {
  const { values, consumed } = readFlagValues(
    ["--settings", "--outputs", "--timeout"],
    args,
  );

  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (consumed.has(index)) {
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        error: `unknown option ${JSON.stringify(arg)}`,
        positional,
        values,
      };
    }

    positional.push(arg);
  }

  if (positional.length > 2) {
    return {
      error: `expected at most two arguments (<config> and <raw-dir>), got ${positional.length}`,
      positional,
      values,
    };
  }

  return { error: undefined, positional, values };
}

/** Run the whole cycle for the parsed arguments and return its
 *  result for the digest. */
async function runCycle(
  parsed: ParsedArgs,
  onProgress: (message: string) => void,
  animated: boolean,
): Promise<WikiSyncResult> {
  const { positional, values } = parsed;
  const timeoutArg = values.get("--timeout");
  const configPath = positional[0] ?? join(repoRoot, "sync.json");
  const config = await loadSyncConfig(configPath, homedir());
  const rawDir = positional[1] ?? resolveRawDir(config.dataRoot, repoRoot);

  return await runWikiSync({
    configPath,
    config,
    rawDir,
    settingsPath: values.get("--settings") ?? join(repoRoot, "settings.yml"),
    outputsDir: values.get("--outputs") ?? join(repoRoot, "outputs"),
    promptsDir: join(repoRoot, "prompts"),
    timeoutMs: timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
    heartbeatMs: animated ? 100 : undefined,
    onProgress,
  });
}

/** wiki-sync entry point: `wiki-sync [-h | --help] [--settings <path>] [--timeout <secs>] [<config>] [<raw-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseCliArgs(args);

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const flagError = flagValueError(parsed.values);

  if (flagError !== undefined) {
    fail(flagError);

    return;
  }

  const { sink, animated } = stderrSink([
    ...AGENT_HEARTBEAT_PREFIX,
    LINT_HEARTBEAT_PREFIX,
  ]);

  try {
    const result = await runCycle(parsed, sink.render, animated);

    sink.end();
    console.log(formatFinalDigest(result));
  } catch (error) {
    sink.end();
    console.error(colors().red(`wiki-sync: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/sync/wiki-sync.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-sync");
