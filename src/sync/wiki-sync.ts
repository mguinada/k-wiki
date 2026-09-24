/**
 * wiki-sync: the one-command orchestrator (guide §18, issue #13). It
 * chains the proven pieces — sync (sync-vault for vault sources,
 * sync-repo for repo sources, issue #145) → wiki-ingest → headless
 * lint (§17, prompts/lint.md) → crosslink audit (issue #96,
 * configured second brains only) → citation wall (issue #339) →
 * verification (issue #138) → data-repo commit — and prints one
 * digest: the run's ingest digest, the lint summary, the audit
 * result, the citation-wall result, the fidelity and provenance
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
 * over the data repo's wiki/ and raw/ every cycle, after lint, the
 * crosslink audit, and the citation wall. One problem line per finding fails the cycle
 * before the commit: the lint edits are reverted (the ingest edits
 * stay, uncommitted, as the fix surface), mirroring the lint stage's
 * own failure semantics.
 *
 * The citation wall stage (issue #339) runs the one-way sandbox
 * audit (src/sandbox/citations.ts) over the working tree every
 * cycle, after the crosslink audit and before verification: main
 * pages must never link, embed, or cite sandbox pages, sandbox
 * pages must never carry `sources` edges or cross-wiki links, and
 * the `via: agent` stamp lives only inside wiki/sandbox/. A
 * violation fails the cycle after path-scoped-reverting every
 * offending page to its last committed state (family 3's primitive
 * shape — never a whole-repo reset), so a rogue edge never
 * compounds into the cycle's commit. The wall judges direction and
 * placement only; link resolution stays check-links' business, and
 * the sandbox namespace still never lists anywhere else.
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

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { AGENT_HEARTBEAT_PREFIX, stderrSink } from "../cli/progress.ts";
import { type RunContext, runContext } from "../cli/run-context.ts";
import {
  pathExists,
  pluralized,
  readTextIfExists,
  repoRoot,
} from "../cli/shared.ts";
import {
  type AgentRunFlags,
  agentRunFlags,
  parseSyncRunArgs,
} from "../cli/shell.ts";
import { parseStatus, runGit } from "../data/git.ts";
import type { AgentRunner } from "../ingest/agent-run.ts";
import {
  type AgentSettings,
  loadAgentSettings,
} from "../ingest/agent-settings.ts";
import {
  capturePreRunState,
  type PreRunState,
  revertToPreRun,
  runGuardrails,
} from "../ingest/guardrails.ts";
import {
  sourceCount,
  type WikiPages,
  wikiPages,
} from "../ingest/manifest-diff.ts";
import { SNAPSHOT_FILENAME, writeSnapshotAdvance } from "../ingest/snapshot.ts";
import {
  type IngestResult,
  ingestEditsKept,
  runWikiIngest,
} from "../ingest/wiki-ingest.ts";
import {
  type CitationWallStageResult,
  runCitationWallStage,
} from "../sandbox/citations.ts";
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
import { readSharedWriterMarker } from "../writer/marker.ts";
import {
  expandHome,
  loadSyncConfig,
  type PublishConfig,
  resolveRawDir,
  type SourceConfig,
  type SyncConfig,
} from "./config.ts";
import {
  LINT_HEARTBEAT_PREFIX,
  type LintResult,
  runLintStage,
} from "./lint-stage.ts";
import { lintWindowPath, restoreLintWindowSnapshot } from "./lint-window.ts";
import type {
  DriverOptions,
  RepoSyncReport,
  SyncReport,
} from "./projection.ts";
import { type PublishResult, runPublishStage } from "./publish.ts";
import {
  acquireLock,
  holderDescription,
  readLockHolder,
  releaseLock,
  runLockPath,
} from "./run-lock.ts";
import { runRepoSync } from "./sync-repo.ts";
import { runVaultSync } from "./sync-vault.ts";
import { HELP } from "./wiki-sync-help.ts";

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
  /** The run context: the audit runs over the context's wiki dir.
   *  Built once at the CLI boundary (issue #257). */
  readonly run: RunContext;
  /** Domain wiki dirs from the settings' `secondBrain.domains`;
   *  undefined or absent (the key missing) skips the stage entirely. */
  readonly domains?: readonly string[] | undefined;
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

  const { run } = options;
  const domains = options.domains.map((dir) => expandHome(dir, options.home));

  run.onProgress(
    `wiki-sync: crosslinks — auditing against ${pluralized(domains.length, "domain wiki")}`,
  );

  const report = await checkCrossWikiLinks(run.wikiDir, ...domains);

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
  /** The run context: the checks run over the context's wiki dir and
   *  raw dir. Built once at the CLI boundary (issue #257). */
  readonly run: RunContext;
}

/**
 * The verification stage (issue #138): run the deterministic
 * check-fidelity (issue #125) and check-provenance (issue #65) cores
 * over the data repo's wiki/ and raw/ — every cycle, after lint, the
 * crosslink audit, and the citation wall, whatever the ingest stage did. One problem
 * line per finding throws (fidelity first, provenance second),
 * stopping the cycle before the commit; the caller owns the revert.
 */
export async function runVerificationStage(
  options: VerificationOptions,
): Promise<VerificationResult> {
  const { run } = options;

  run.onProgress(
    "wiki-sync: verification — checking citation fidelity and provenance",
  );

  const fidelity = await checkWikiFidelity(run.wikiDir, run.rawDir);

  failProblems("fidelity", fidelity.problems);

  const provenance = await checkWikiProvenance(run.wikiDir, run.rawDir);

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

  if (await pathExists(join(dataRoot, "outputs"))) {
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
  /** The one-way sandbox wall audit; it runs every cycle. */
  readonly citations: CitationWallStageResult;
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
  /** The run context: raw dir, data root, wiki dir, environment,
   *  clock, progress sink — built once at the CLI boundary (issue
   *  #257) and threaded through every stage. */
  readonly run: RunContext;
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** Digest destination (the code repo's outputs/); the manifest
   *  snapshot lives in the data repo's outputs/ (issue #112). */
  readonly outputsDir: string;
  /** Directory holding ingest.md, incremental.md, and lint.md. */
  readonly promptsDir: string;
  /** Agent runner for both agent stages; defaults to the real one. */
  readonly runAgent?: AgentRunner;
  /** Kill either agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while an agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** The shared-writer coordinator's renewal hook (issue #390):
   *  invoked before and after each long agent stage so the remote
   *  lease outlives them. Undefined outside shared mode. A throw
   *  aborts the cycle before the stage runs (renewal CAS loss must
   *  abort before the final push). */
  readonly onAgentBoundary?:
    | ((stage: "ingest" | "lint", phase: "before" | "after") => Promise<void>)
    | undefined;
  /** The shared-writer coordinator's snapshot deferral (issue #390):
   *  the ingest stage returns its pending snapshot state instead of
   *  writing, and the cycle anchors it to the content commit after
   *  that commit exists. Undefined outside shared mode — standalone
   *  ingest writes immediately, exactly as before. */
  readonly deferIngestSnapshot?: boolean | undefined;
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

  names.push("citations", "verification", "commit");

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
  options: WikiSyncOptions,
  config: SyncConfig,
  stages: readonly string[],
): Promise<SyncReport> {
  const { run } = options;
  const kind = syncKindOf(config, options.configPath);

  run.onProgress(stageLine(stages, "sync"));

  return await DRIVERS[kind]({
    configPath: options.configPath,
    config,
    rawDir: run.rawDir,
    env: run.env,
    now: run.now,
    onProgress: (message) => run.onProgress(message.text),
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
  const { run } = options;

  if (ingest.status !== "ran") {
    run.onProgress(`${stageLine(stages, "lint")} skipped (no ingest ran)`);

    return undefined;
  }

  run.onProgress(stageLine(stages, "lint"));

  return await runLintStage({
    settingsPath: options.settingsPath,
    settings,
    run,
    promptsDir: options.promptsDir,
    runAgent: options.runAgent,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    pre: preLint,
  });
}

/** Stage 4: the configured crosslink audit; skipped outright when
 *  the instance carries no `secondBrain.domains` key. */
async function runCrosslinksOrSkip(
  run: RunContext,
  domains: readonly string[] | undefined,
  stages: readonly string[],
): Promise<CrosslinksResult | undefined> {
  if (domains === undefined) {
    return undefined;
  }

  run.onProgress(stageLine(stages, "crosslinks"));

  return await runCrosslinksStage({ run, domains });
}

/** The verification stage with the cycle's revert semantics: on
 *  failure, revert the lint edits (the ingest edits stay) and rewind
 *  the lint-window snapshot to its pre-lint bytes — the audit those
 *  edits recorded must not survive its own revert — before
 *  rejecting. */
async function runVerificationWithRevert(
  options: WikiSyncOptions,
  preLint: PreRunState,
  preLintSnapshot: string | undefined,
  stages: readonly string[],
): Promise<VerificationResult> {
  const { run } = options;

  run.onProgress(stageLine(stages, "verification"));

  try {
    return await runVerificationStage({ run });
  } catch (error) {
    run.onProgress(
      `wiki-sync: verification failed — reverting lint edits to ${preLint.commit.slice(0, 8)} (ingest edits kept)`,
    );

    const post = await runGuardrails(run.dataRoot, run.env, preLint);

    await revertToPreRun(run.dataRoot, run.env, preLint, post.entries);
    await restoreLintWindowSnapshot(
      lintWindowPath(run.dataRoot),
      preLintSnapshot,
    );

    throw error;
  }
}

/** The final stage (issue #15): copy the wiki into the configured
 *  mirror vault — every cycle, after the commit; skipped outright
 *  when the config has no publish section. */
async function runPublishOrSkip(
  run: RunContext,
  publish: PublishConfig | undefined,
  stages: readonly string[],
): Promise<PublishResult | undefined> {
  if (publish === undefined) {
    return undefined;
  }

  run.onProgress(stageLine(stages, "publish"));

  return await runPublishStage({
    dataRoot: run.dataRoot,
    mirror: publish.mirror,
    include: publish.include,
    root: publish.root,
    onProgress: run.onProgress,
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
  const { run } = options;
  const settings = await loadAgentSettings(options.settingsPath, {
    onProgress: run.onProgress,
  });
  const config =
    options.config ?? (await loadSyncConfig(options.configPath, homedir()));
  const release = await acquireCycleLock(run);

  try {
    return await runCycleStages(options, settings, config);
  } finally {
    await release();
  }
}

/** The cycle's run-lock tenure (issue #313): acquire the shared
 *  `<dataRoot>/.scheduled-run.lock` before the first stage and hold
 *  it across the whole cycle — success, failure, and guardrail
 *  revert all release. Skipped only for the scheduled wrapper's
 *  child (KWIKI_RUN_LOCK_HELD=1: the wrapper holds the tenure around
 *  its pull → sync → push cycle). A fresh foreign lock fails loud
 *  naming the holder — a manual request is never silently dropped;
 *  a stale one (a killed run) is taken over. The shared-writer
 *  coordinator acquires the same tenure before its remote steps
 *  (issue #390's state machine puts the local lock first), so the
 *  cycle it delegates to skips re-acquisition the same way. */
export async function acquireCycleLock(
  run: RunContext,
): Promise<() => Promise<void>> {
  if (run.env.KWIKI_RUN_LOCK_HELD === "1") {
    return async () => {};
  }

  const lockPath = runLockPath(run.dataRoot);

  await mkdir(dirname(lockPath), { recursive: true });

  if ((await acquireLock(lockPath, { now: run.now })) === "busy") {
    throw new Error(await runLockRefusal(lockPath));
  }

  return () => releaseLock(lockPath);
}

/** The busy-lock message: the holder's start time and PID — never a
 *  cryptic git index.lock collision (issue #313). */
async function runLockRefusal(lockPath: string): Promise<string> {
  const holder = await readLockHolder(lockPath);

  return holder === undefined
    ? "another run holds the lock — retry in a few minutes"
    : `a run has been ${holderDescription(holder)} — retry in a few minutes`;
}

/** The cycle's stages, in order — everything between the run-lock
 *  acquire and its release. The settings and config loads happen in
 *  the caller, before the lock: a bad argument path must fail on its
 *  own error, never on a lock, and take no lock side effects. */
async function runCycleStages(
  options: WikiSyncOptions,
  settings: AgentSettings,
  config: SyncConfig,
): Promise<WikiSyncResult> {
  const { run } = options;
  const { env, onProgress, dataRoot } = run;
  const { secondBrainDomains: domains } = settings;
  const stages = stageNames({ domains, publish: config.publish });
  const boundary = options.onAgentBoundary;
  const sync = await runSyncStage(options, config, stages);

  onProgress(stageLine(stages, "ingest"));
  await boundary?.("ingest", "before");

  // The cycle report is promised in the ingest prompt and written at
  // the cycle's end (issue #385): one path, computed once, so a
  // cycle spanning midnight cannot cite a file the write never
  // creates.
  const cyclePath = cycleReportPath(run.now);

  // Everything from the ingest call onward runs inside the citation
  // promise (issue #385): the agent's log entry names the cycle
  // report, so a failure while the entry survives still writes the
  // day's file — recording the failure — before the error propagates.
  // Ingest-stage failures write it only when the ingest stage kept
  // the run's edits; a guardrail-reverted failure leaves nothing
  // citing and the clean tree the scheduled wrapper's recovery owns.
  let ingest: IngestResult | undefined;

  try {
    ingest = await runWikiIngest({
      settingsPath: options.settingsPath,
      settings,
      run,
      outputsDir: options.outputsDir,
      promptsDir: options.promptsDir,
      runAgent: options.runAgent,
      timeoutMs: options.timeoutMs,
      heartbeatMs: options.heartbeatMs,
      cycleReportNote: cycleReportPromise(cyclePath),
      deferSnapshot: options.deferIngestSnapshot === true,
    });

    // The verification stage's revert target: everything the ingest
    // stage left, before the lint agent runs.
    const preLint = await capturePreRunState(dataRoot, env);

    // The lint-window snapshot's pre-lint bytes: the verification
    // revert rewinds the lint edits, so the audit that recorded them
    // is unrecorded too and the next cycle re-audits the reverted
    // pages.
    const preLintSnapshot = await readTextIfExists(lintWindowPath(dataRoot));

    await boundary?.("ingest", "after");
    await boundary?.("lint", "before");

    const lint = await runLintOrSkip(
      options,
      ingest,
      stages,
      preLint,
      settings,
    );

    await boundary?.("lint", "after");

    const crosslinks = await runCrosslinksOrSkip(run, domains, stages);

    onProgress(stageLine(stages, "citations"));

    const citations = await runCitationWallStage({ run });

    const verification = await runVerificationWithRevert(
      options,
      preLint,
      preLintSnapshot,
      stages,
    );

    onProgress(stageLine(stages, "commit"));

    // The commit summary's page counts, from the status snapshot the
    // cycle already holds: the lint stage's post-run entries when lint
    // ran; otherwise the pre-lint capture (nothing changes between it
    // and the commit on a lint-skip path — verification is read-only).
    const pages = await wikiPages(dataRoot, lint?.entries ?? preLint.status);
    const summary = commitSummaryOf(sync, ingest, lint, pages);
    const commit = await commitDataRepo(
      dataRoot,
      env,
      formatCommitMessage(summary),
    );

    await writeDeferredSnapshot(dataRoot, run, ingest);

    const publish = await runPublishOrSkip(run, config.publish, stages);
    const result: WikiSyncResult = {
      sync,
      ingest,
      lint,
      crosslinks,
      citations,
      verification,
      commit,
      publish,
    };

    if (nothingToDoLine(result) === undefined) {
      await commitCycleDigest(
        dataRoot,
        env,
        cyclePath,
        formatFinalDigest(result),
      );
    }

    return result;
  } catch (error) {
    if (ingest !== undefined || ingestEditsKept(error)) {
      await writeFailureDigest(dataRoot, cyclePath, error);
    }

    throw error;
  }
}

/** The deferred shared-writer snapshot (issue #390): the content
 *  commit now exists, so the pending snapshot state is written
 *  anchored to it — the anchor is only ever a commit already in the
 *  branch's history. No-op outside shared mode (no pending state). */
async function writeDeferredSnapshot(
  dataRoot: string,
  run: RunContext,
  ingest: IngestResult,
): Promise<void> {
  if (ingest.status !== "ran" || ingest.pendingSnapshot === undefined) {
    return;
  }

  await writeSnapshotAdvance(
    join(dataRoot, "outputs", SNAPSHOT_FILENAME),
    run,
    ingest.pendingSnapshot.manifest,
  );
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

/** The digest's citation-wall sentence: what the wall scanned and
 *  that it holds — the sandbox count names the namespace only when
 *  one exists. */
function citationsLine(citations: CitationWallStageResult): string {
  const pages = pluralized(citations.pages, "page");
  const sandbox =
    citations.sandboxPages > 0
      ? ` (${pluralized(citations.sandboxPages, "sandbox note")})`
      : "";

  return `the one-way wall holds over ${pages}${sandbox}`;
}

/** The data-repo-relative cycle digest path for a run's date — the
 *  lint report's date-named mechanism (issue #385): a same-day rerun
 *  overwrites, git history disambiguates. */
export function cycleReportPath(now: () => Date): string {
  return `outputs/cycle-${now().toISOString().slice(0, 10)}.md`;
}

/** The ingest-prompt line promising the cycle report (issue #385):
 *  the agent writes its log entry during stage 2, before the digest
 *  exists, and cites this exact path. */
function cycleReportPromise(path: string): string {
  return `This cycle's full report will be committed at \`${path}\`; cite it in your log entry.`;
}

/** Write the finished digest beside the lint reports and commit it in
 *  its own commit (issue #385). The digest cites the content commit's
 *  hash, so it must be written after that commit — amending would
 *  rewrite the hash away from the one the digest cites; the digest
 *  commit keeps both true. */
async function commitCycleDigest(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  path: string,
  digest: string,
): Promise<void> {
  await mkdir(join(dataRoot, dirname(path)), { recursive: true });
  await writeFile(join(dataRoot, path), digest);

  await commitDataRepo(dataRoot, env, `wiki-sync: cycle digest ${path}`);
}

/** The failure digest (issue #385): once the ingest prompt promised
 *  the cycle report, a later stage failure still writes the day's
 *  file — recording the failure — so the log entry's citation
 *  resolves. Uncommitted, it rides the next real cycle's commit,
 *  like the ingest edits a failed cycle already leaves. Best-effort:
 *  the cycle's real failure must surface. */
async function writeFailureDigest(
  dataRoot: string,
  path: string,
  error: unknown,
): Promise<void> {
  try {
    await mkdir(join(dataRoot, dirname(path)), { recursive: true });
    await writeFile(
      join(dataRoot, path),
      `# wiki-sync cycle digest\n\n- **Result:** failed — ${errorMessage(error)}\n`,
    );
  } catch {
    // An unwritable digest is secondary; nothing committed cites it —
    // a failed cycle's log entry stays uncommitted with the ingest
    // edits.
  }
}

/** The one-line digest of a no-op cycle — nothing to commit after
 *  a skipped ingest, and publish (when configured) copied and removed
 *  nothing; undefined whenever the cycle did real work. Exported for
 *  the shared-writer coordinator's no-op lease release (issue #390). */
export function nothingToDoLine(result: WikiSyncResult): string | undefined {
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

/** The digest's lint lines: skipped (no ingest), window-empty, or
 *  the completed audit with its scope and report. */
function lintLines(lint: LintResult | undefined): string[] {
  if (lint === undefined) {
    return ["- **Lint:** skipped — no ingest ran"];
  }

  if (lint.skipped === "empty-window") {
    return [
      "- **Lint:** window empty — nothing left to audit since the last audit",
    ];
  }

  const scope =
    lint.windowPages === undefined
      ? "full audit"
      : `window audit (${pluralized(lint.windowPages.length, "page")})`;

  return [
    `- **Lint:** ${scope}, ${lint.reportWritten ? `report \`${lint.reportPath}\`` : `report not written (expected \`${lint.reportPath}\`)`} — summary below`,
  ];
}

/**
 * The final printed digest: counts first, details after — the sync
 * summary, the lint summary, the commit hash, then the full ingest
 * digest.
 */
export function formatFinalDigest(result: WikiSyncResult): string {
  const { citations, commit, crosslinks, ingest, lint, sync, verification } =
    result;
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

  lines.push(...lintLines(lint));

  if (crosslinks !== undefined) {
    lines.push(`- **Crosslinks:** ok — ${crosslinksLine(crosslinks)}`);
  }

  lines.push(`- **Citations:** ok — ${citationsLine(citations)}`);

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

  if (lint !== undefined && lint.skipped === undefined) {
    lines.push("", "## Lint summary", "", lint.summary.trimEnd());
  }

  if (ingest.status === "ran") {
    lines.push("", "## Ingest digest", "", ingest.digest.trimEnd());
  }

  return `${lines.join("\n")}\n`;
}

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-sync", message);
}

/** Run the whole cycle for the parsed arguments and return its
 *  result for the digest. A marker-enabled data repo dispatches to
 *  the shared-writer coordinator (issue #390): manual wiki-sync and
 *  scheduled-run exercise the same state machine. A malformed marker
 *  refuses the run; a refused precondition prints one line and exits
 *  1. */
async function runCycle(
  positional: readonly string[],
  runFlags: AgentRunFlags,
  onProgress: (message: string) => void,
  animated: boolean,
): Promise<WikiSyncResult> {
  const configPath = positional[0] ?? join(repoRoot, "sync.json");
  const config = await loadSyncConfig(configPath, homedir());
  const rawDir = positional[1] ?? resolveRawDir(config.dataRoot, repoRoot);

  // The run context, built once at this CLI boundary from the raw
  // dir it resolved and the sink it derived (issue #257).
  const run = runContext({ rawDir, onProgress });
  const options = {
    configPath,
    config,
    run,
    settingsPath: runFlags.settings ?? join(repoRoot, "settings.yml"),
    outputsDir: runFlags.outputs ?? join(repoRoot, "outputs"),
    promptsDir: join(repoRoot, "prompts"),
    timeoutMs: runFlags.timeoutMs,
    heartbeatMs: animated ? 100 : undefined,
  };

  const marker = await readSharedWriterMarker(run.dataRoot);

  if (marker.kind === "invalid") {
    throw new Error(
      `shared-writer marker invalid — failing closed: ${marker.reason}`,
    );
  }

  if (marker.kind === "enabled") {
    const { runSharedCycle } = await import("../writer/coordinator.ts");
    const outcome = await runSharedCycle({
      ...options,
      removalReceiptPath: runFlags.removalReceipt,
    });

    if (outcome.status === "refused") {
      throw new Error(outcome.reason);
    }

    return outcome.result;
  }

  if (runFlags.removalReceipt !== undefined) {
    throw new Error(
      "--removal-receipt requires shared-writer mode — this data repo carries no shared-writer marker",
    );
  }

  return await runWikiSync(options);
}

/** wiki-sync entry point: `wiki-sync [-h | --help] [--settings <path>] [--timeout <secs>] [<config>] [<raw-dir>]`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseSyncRunArgs(args);

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const runFlags = agentRunFlags(parsed.values);

  if (runFlags.error !== undefined) {
    fail(runFlags.error);

    return;
  }

  const { sink, animated } = stderrSink([
    ...AGENT_HEARTBEAT_PREFIX,
    LINT_HEARTBEAT_PREFIX,
  ]);

  try {
    const result = await runCycle(
      parsed.positional,
      runFlags,
      sink.render,
      animated,
    );

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
