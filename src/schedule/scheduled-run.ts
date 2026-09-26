/**
 * scheduled-run: the unattended wrapper the scheduler runs on a fixed
 * interval (issue #14, guide §18). One portable Node file — identical
 * on macOS/Linux/Windows; only the scheduler registration differs.
 *
 *   lockfile → agent resolution (the settings' agent command
 *   resolved to an absolute path, issue #399; unresolvable fails
 *   the tick before any stage) → quota pre-flight (an optional
 *   quota-axi probe may skip the tick before any stage) →
 *   git pull --rebase → (with --lint-full: wiki-lint --full, the
 *   weekly quality sweep, issue #359) → wiki-sync (gates + commit)
 *   → git push
 *
 * Overlap guard (issue #14 decision 3; the lock itself now lives in
 * `src/sync/run-lock.ts`, shared with manual wiki-sync runs since
 * issue #313): an atomic `O_EXCL` lockfile with PID + timestamp at
 * the data repo root — outside wiki-sync's
 * wiki/raw/outputs commit pathspecs, so the sync can never commit or
 * stage it — same-machine overlap is *prevented*; a lock older than
 * LOCK_STALE_MS is taken over (a killed run must never wedge the
 * schedule). Cross-
 * machine overlap is prevented when the data repo carries the
 * shared-writer marker: the coordinator serializes through the
 * remote lease (issue #390). Without the marker it stays not
 * prevented but made recoverable: the pre-run `pull --rebase` and
 * the push's rejection → pull --rebase → retry-once → alert sequence
 * keep any slipped-through overlap visible instead of silently
 * diverged (decisions 4–5). The lease-as-git-ref upgrade shipped as
 * shared-writer mode.
 *
 * `wiki-sync` stays commit-only (decision 5): unattended pushing is
 * consented to here and only here, after wiki-sync's guardrails and
 * checks have passed — the gate stays ahead of the publish. Push
 * retry is the one exception to "no retry/backoff" (guide §26): it
 * resolves the benign lost-the-push-race case; every other failure
 * waits for the next interval by design.
 *
 * Environment (issue #14, plist scope): launchd runs the job with an
 * explicit HOME and a minimal PATH; the wrapper extends PATH with the
 * node bin dir and the standard CLI install locations so its own CLIs
 * resolve, and resolves the agent binary to an absolute path (issue
 * #399) — a bare agent name outside those dirs can never start, so
 * the launcher finds it once (scheduled PATH, then the login shell)
 * and hands the absolute path to every child through the environment.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { pathExists, repoRoot } from "../cli/shared.ts";
import { agentRunFlags, type ParsedCli, parseArgs } from "../cli/shell.ts";
import { runGit } from "../data/git.ts";
import { loadAgentSettings } from "../ingest/agent-settings.ts";
import { loadSyncConfig } from "../sync/config.ts";
import {
  acquireLock,
  holderDescription,
  type LockFileData,
  readLockHolder,
  releaseLock,
  runLockPath,
} from "../sync/run-lock.ts";
import { writeCycleHeartbeat } from "./heartbeat.ts";
import { notifyUser } from "./notify.ts";
import {
  type PreflightState,
  type QuotaPreflightResult,
  quotaPreflight,
  quotaPreflightUnavailable,
} from "./quota-preflight.ts";
import { buildScheduledEnv, spawnRepoScript } from "./repo-script.ts";
import { loginShell, resolveAgentPath } from "./resolve-agent.ts";
import { createRunLog, scheduledLogPath } from "./run-log.ts";
import { HELP } from "./scheduled-run-help.ts";
import { runSharedPipeline, scheduledSharedMode } from "./shared-cycle.ts";

/** The cycle's outcome. */
export type CycleOutcome =
  | { readonly status: "ok" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly error: string };

export interface ScheduledRunOptions {
  /** The data repo root (lock, pull, push, and the sync all key on
   *  it). */
  readonly dataRoot: string;
  /** The code repo checkout the wrapper runs from. */
  readonly repoRoot: string;
  /** Where the lockfile lives (the data repo root — outside
   *  wiki-sync's wiki/raw/outputs commit pathspecs, so the sync can
   *  never stage it). */
  readonly lockPath: string;
  /** Args forwarded verbatim to the wiki-sync invocation. */
  readonly args?: readonly string[];
  /** The weekly full-lint sweep mode (issue #359 C): run
   *  `wiki-lint --full` with the sweep budget after the pull and
   *  before the ordinary wiki-sync cycle, all under the same lock
   *  tenure — the sweep and a concurrent 30-minute cycle refuse
   *  loud, never interleave two writers. */
  readonly lintFull?: boolean | undefined;
  /** The sweep's per-invocation budget in milliseconds; default
   *  7 200 000 (two hours — issue #359's per-invocation override,
   *  never the 1800 s default the cycles keep). */
  readonly lintFullTimeoutMs?: number | undefined;
  /** The --settings path forwarded to the sweep, so it lints the
   *  same instance the cycle syncs (multi-instance setups); absent
   *  lets the door resolve the default instance. */
  readonly lintFullSettings?: string | undefined;
  /** Log sink; default: silent (the CLI main wires the log file). */
  readonly log?: (line: string) => void;
  /** ALERT notifier (macOS notification); default: silent (the CLI
   *  main wires the notifier — a failed cycle then reaches the
   *  operator's screen, not just the log). */
  readonly notify?: (message: string) => void | Promise<void>;
  /** The PID recorded in the lockfile; defaults to process.pid. */
  readonly pid?: number;
  /** Clock for log timestamps and lock staleness. */
  readonly now?: () => Date;
  /** Git step runner; defaults to the real runGit. Injected in tests. */
  readonly runGitStep?: (
    dir: string,
    args: readonly string[],
  ) => Promise<unknown>;
  /** The wiki-sync invocation; defaults to spawning node against the
   *  repo's bin/wiki-sync. Injected in tests. */
  readonly runSync?: (args: readonly string[]) => Promise<void>;
  /** Quota probe; injected in tests and optional on every machine. */
  readonly runQuotaPreflight?: () => Promise<QuotaPreflightResult>;
  /** The full-sweep wiki-lint invocation; defaults to spawning node
   *  against the repo's bin/wiki-lint. Injected in tests. */
  readonly runLintFull?: (args: readonly string[]) => Promise<void>;
  /** The agent-binary path probe (issue #399); defaults to the real
   *  resolveAgentPath. Injected in tests. */
  readonly resolveAgentPath?: typeof resolveAgentPath | undefined;
}

/**
 * One scheduled cycle. Every step logs; any failure releases the lock
 * and returns a failed outcome naming the error (the CLI exits 1 so
 * launchd records it, and the next interval is the recovery — no
 * retry/backoff by design, guide §26). The single push retry after a
 * successful commit is the one exception (lost-the-push-race).
 */
export async function runScheduledCycle(
  options: ScheduledRunOptions,
): Promise<CycleOutcome> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const runGitStep =
    options.runGitStep ??
    (async (dir: string, gitArgs: readonly string[]) =>
      runGit(dir, gitArgs, process.env));

  const stamp = (): string => now().toISOString();
  const notify = options.notify ?? (() => {});

  /** Best-effort heartbeat write: the stamp records that this cycle
   *  reached its end (ok, failed, or a benign quota-skipped tick) so
   *  the independent watchdog can see a pipeline that stops
   *  completing cycles — including one that never starts again. A
   *  failed write warns in the log and never changes the cycle's
   *  outcome. */
  const stampHeartbeat = async (
    outcome: "ok" | "failed" | "skipped",
    reason?: string,
    preflight?: PreflightState,
  ): Promise<void> => {
    try {
      await writeCycleHeartbeat({
        dataRoot: options.dataRoot,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        ...(preflight === undefined ? {} : { preflight }),
        pid,
        now: now(),
        onProgress: log,
      });
    } catch (error) {
      log(
        `scheduled-run: WARNING — heartbeat write failed — ${errorMessage(error)}`,
      );
    }
  };

  const fail = async (
    error: string,
    preflight?: PreflightState,
  ): Promise<CycleOutcome> => {
    log(`scheduled-run: ALERT ${error}`);

    await stampHeartbeat("failed", undefined, preflight);
    await releaseLock(options.lockPath, pid);
    await notify(error);

    return { status: "failed", error };
  };

  await mkdir(dirname(options.lockPath), { recursive: true });

  const lock = await acquireLock(options.lockPath, { now, pid });

  if (lock === "busy") {
    return {
      status: "skipped",
      reason: skipReason(await readLockHolder(options.lockPath)),
    };
  }

  log(`scheduled-run: ${stamp()} — ${cycleStartNote(lock)}`);

  const agentStep = await resolveCycleAgentOrOutcome(options, fail, log);

  if ("status" in agentStep) {
    return agentStep;
  }

  const agentCommand = agentStep.agentCommand;
  const quota = await runQuotaGate(options, log);

  if (quota.skipReason !== undefined) {
    await releaseLock(options.lockPath, pid);
    await stampHeartbeat("skipped", quota.skipReason);
    return { status: "skipped", reason: quota.skipReason };
  }

  try {
    await runStage(options, runGitStep, log, agentCommand);
  } catch (error) {
    return await fail(errorMessage(error), quota.preflight);
  }

  await releaseLock(options.lockPath, pid);
  await stampHeartbeat("ok", undefined, quota.preflight);
  log(`scheduled-run: ${stamp()} — cycle complete`);

  return { status: "ok" };
}

/** The pre-push stages: verify origin, pull --rebase, the optional
 *  full-sweep lint, then wiki-sync. Any failure throws — wiki-sync's
 *  guardrails and verification have already reverted their agent
 *  runs, so the wiki stays at the last good commit and the next
 *  interval is the recovery; a failed sweep leaves its own partial,
 *  guardrail-passed edits uncommitted with the window snapshot
 *  untouched, so the next sweep retries them (issue #359). */
/** The busy-lock skip reason, naming the holder when the lockfile
 *  is readable (issue #313 — the manual holder is who the operator
 *  must know about). */
function skipReason(holder: LockFileData | undefined): string {
  const holderLine =
    holder === undefined ? "" : `, ${holderDescription(holder)}`;

  return `another run holds the lock (fresh${holderLine}) — skipping this tick`;
}

/** The sweep's argv: --full, the budget, the instance's settings
 *  when the wrapper was given one, and the instance's raw dir — the
 *  sweep lints the same data repo the cycle syncs, never whatever
 *  the default instance happens to be. */
export function sweepArgsFor(
  options: ScheduledRunOptions,
  timeoutMs: number,
): readonly string[] {
  const settings = options.lintFullSettings;

  return [
    "--full",
    "--timeout",
    String(timeoutMs / 1000),
    ...(settings === undefined ? [] : ["--settings", settings]),
    join(options.dataRoot, "raw"),
  ];
}

/** The quota gate's effect on the cycle: a skip reason when the
 *  provider cannot finish the cycle, the dormant pre-flight state
 *  when the cycle ran ungated. */
interface QuotaGate {
  readonly skipReason?: string;
  readonly preflight?: PreflightState;
}

/** The cycle's agent-resolution outcome (issue #399): resolved to an
 *  absolute path, skipped (settings unreadable — the stage surfaces
 *  the precise settings error), or unresolved (the cycle fails
 *  before any stage, the shared-writer lease included). */
type AgentResolution =
  | { readonly kind: "resolved"; readonly command: string }
  | { readonly kind: "skipped" }
  | { readonly kind: "unresolved"; readonly error: string };

/** The cycle's agent resolution (issue #399), folded to one decision
 *  for the cycle: a failed outcome when the binary cannot be resolved
 *  — the ALERT before any stage, lease included — else the absolute
 *  command to hand the children, undefined when unreadable settings
 *  defer the failure to the stage's settings error. */
async function resolveCycleAgentOrOutcome(
  options: ScheduledRunOptions,
  fail: (error: string) => Promise<CycleOutcome>,
  log: (line: string) => void,
): Promise<CycleOutcome | { readonly agentCommand: string | undefined }> {
  const agent = await resolveCycleAgentCommand(options, log);

  if (agent.kind === "unresolved") {
    return await fail(agent.error);
  }

  return {
    agentCommand: agent.kind === "resolved" ? agent.command : undefined,
  };
}

/** The cycle-start log line: names a stale-lock takeover, plain
 *  start otherwise. */
function cycleStartNote(lock: "busy" | "took-over" | "acquired"): string {
  return lock === "took-over"
    ? "took over a stale lock; starting cycle"
    : "starting cycle";
}

/** The cycle's agent command, resolved to an absolute path
 *  before any stage runs (issue #399): the launchd PATH cannot start
 *  a bare agent name the standard dirs lack, so the launcher
 *  resolves the settings' command once — scheduled PATH, then the
 *  login shell — and hands the absolute path to every child through
 *  the environment. Settings that cannot load skip the resolution:
 *  the stage fails with the settings error, as before. */
async function resolveCycleAgentCommand(
  options: ScheduledRunOptions,
  log: (line: string) => void,
): Promise<AgentResolution> {
  const shell = loginShell(process.env, process.platform);

  let command: string;

  try {
    command = (await loadAgentSettings(settingsPathFor(options))).command;
  } catch {
    log(
      "scheduled-run: agent settings unreadable — agent resolution skipped (the stage will surface the settings error)",
    );

    return { kind: "skipped" };
  }

  const resolved = await (options.resolveAgentPath ?? resolveAgentPath)(
    command,
    buildScheduledEnv(process.env.HOME ?? homedir(), process.execPath).PATH,
    shell,
  );

  if (resolved === undefined) {
    return {
      kind: "unresolved",
      error: `agent ${command} could not be resolved to an absolute path — looked in the scheduled PATH and via the ${shell} login shell; an unstartable agent never runs the cycle`,
    };
  }

  log(`scheduled-run: agent ${command} resolved to ${resolved}`);

  return { kind: "resolved", command: resolved };
}

/** The agent-settings path this cycle's children will load: the
 *  --settings value the wrapper forwards, else the repo's default —
 *  the same resolution the quota pre-flight uses. */
function settingsPathFor(options: ScheduledRunOptions): string {
  const parsed = parseScheduledRunArgs(options.args ?? []);

  return (
    parsed.values.get("--settings") ?? join(options.repoRoot, "settings.yml")
  );
}

async function runQuotaGate(
  options: ScheduledRunOptions,
  log: (line: string) => void,
): Promise<QuotaGate> {
  const result = await (
    options.runQuotaPreflight ?? (() => runQuotaCheck(options, log))
  )();

  return result.status === "skip"
    ? { skipReason: result.reason }
    : result.preflight === undefined
      ? {}
      : { preflight: result.preflight };
}

async function runQuotaCheck(
  options: ScheduledRunOptions,
  log: (line: string) => void,
): Promise<QuotaPreflightResult> {
  const settingsPath = settingsPathFor(options);

  try {
    const settings = await loadAgentSettings(settingsPath);
    return quotaPreflight({
      settings,
      log,
      env: {
        ...process.env,
        PATH: buildScheduledEnv(process.env.HOME ?? homedir(), process.execPath)
          .PATH,
      },
    });
  } catch {
    return quotaPreflightUnavailable(log);
  }
}

/** One cycle's stages: shared mode runs the coordinator (no pull, no
 *  push — it finalizes remotely); local mode runs the pull → sweep →
 *  sync sequence and its push-with-retry. `agentCommand` is the
 *  launcher-resolved absolute agent path (issue #399) handed to
 *  every spawned child through the environment. */
async function runStage(
  options: ScheduledRunOptions,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
  agentCommand: string | undefined,
): Promise<void> {
  if (await scheduledSharedMode(options)) {
    await runSharedPipeline(options, log, agentCommand);

    // The shared coordinator finalized remotely (branch advance and
    // lease release in one atomic push); a wrapper push here would
    // race the lease protocol and is never issued in shared mode.
    log(
      "scheduled-run: shared-writer cycle complete — remote finalized by the coordinator",
    );

    return;
  }

  await runPipelineStages(options, runGitStep, log, agentCommand);
  await pushWithRetry(options.dataRoot, runGitStep, log);
}

async function runPipelineStages(
  options: ScheduledRunOptions,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
  agentCommand: string | undefined,
): Promise<void> {
  await runGitStep(options.dataRoot, ["remote", "get-url", "origin"]);
  await pullWhenClean(options.dataRoot, runGitStep, log);

  if (options.lintFull === true) {
    const timeoutMs = options.lintFullTimeoutMs ?? DEFAULT_LINT_FULL_TIMEOUT_MS;
    const runLintFull =
      options.runLintFull ??
      (async (lintArgs: readonly string[]) => {
        await spawnRepoScript(
          options.repoRoot,
          "wiki-lint",
          lintArgs,
          log,
          agentCommand,
        );
      });

    log(
      `scheduled-run: wiki-lint --full starting (budget ${timeoutMs / 1000}s)`,
    );
    await runLintFull(sweepArgsFor(options, timeoutMs));
    log("scheduled-run: wiki-lint --full finished — running the cycle");
  }

  log("scheduled-run: wiki-sync starting");

  const runSync =
    options.runSync ??
    (async (syncArgs: readonly string[]) => {
      await spawnRepoScript(
        options.repoRoot,
        "wiki-sync",
        syncArgs,
        log,
        agentCommand,
      );
    });

  await runSync(options.args ?? []);
  log("scheduled-run: wiki-sync finished — pushing");
}

/** The git step's stdout, empty when the runner reports none. */
async function gitStdout(
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  dir: string,
  args: readonly string[],
): Promise<string> {
  const result = await runGitStep(dir, args);

  return typeof result === "object" && result !== null && "stdout" in result
    ? String(result.stdout)
    : "";
}

/** True when the data repo sits mid-rebase: git marks the state with
 *  a `rebase-merge` (merge backend) or `rebase-apply` (apply backend)
 *  directory under `.git` — the residue of a conflicted
 *  `pull --rebase` from an earlier tick. */
async function rebaseInProgress(dataRoot: string): Promise<boolean> {
  return (
    (await pathExists(join(dataRoot, ".git", "rebase-merge"))) ||
    (await pathExists(join(dataRoot, ".git", "rebase-apply")))
  );
}

/** Abort a conflicted rebase left mid-progress by a previous tick
 *  before the next `git pull --rebase`: `git rebase --abort` returns
 *  the repo to its last actionable state — the last good commit on
 *  the pre-run path, the local unpushed commit on the push-retry
 *  path. Conflict content is never auto-resolved; the operator
 *  resolves divergent history manually, and the schedule self-heals
 *  on the next tick once the tree is actionable. */
async function abortConflictedRebase(
  dataRoot: string,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
): Promise<void> {
  if (!(await rebaseInProgress(dataRoot))) {
    return;
  }

  await runGitStep(dataRoot, ["rebase", "--abort"]);
  log("scheduled-run: aborted a conflicted rebase left by a previous tick");
}

/** The pre-run pull, skipped over a dirty tree: a failed or killed
 *  sync deliberately leaves its ingest edits uncommitted (the fix
 *  surface), and a rebase refuses such a tree — skipping the pull
 *  keeps the next interval's recovery reachable; divergence is then
 *  owned by the push-rejection path, which runs after a clean
 *  commit. Untracked files do not count: they never block a rebase,
 *  and the run's own lockfile is one. A rebase left mid-progress by a
 *  previous tick is aborted first, so the dirty check below sees the
 *  restored tree. */
async function pullWhenClean(
  dataRoot: string,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
): Promise<void> {
  await abortConflictedRebase(dataRoot, runGitStep, log);

  const status = await gitStdout(runGitStep, dataRoot, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);

  if (status.trim() !== "") {
    log(
      "scheduled-run: tree dirty — skipping the pre-run pull (wiki-sync's recovery owns a dirty tree)",
    );

    return;
  }

  log("scheduled-run: git pull --rebase (data repo)");

  await runGitStep(dataRoot, ["pull", "--rebase"]);
}

/** The push stage with its one recovery (issue #14 decision 5): a
 *  rejection gets one pull --rebase + retry; a second failure throws
 *  and the caller alerts. This retry is the sole exception to the
 *  no-retry operating rule (guide §26) — it resolves the benign
 *  lost-the-push-race case. */
async function pushWithRetry(
  dataRoot: string,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
): Promise<void> {
  try {
    await runGitStep(dataRoot, ["push"]);
    log("scheduled-run: pushed");
  } catch (pushError) {
    log(
      `scheduled-run: push rejected — pull --rebase and retry once: ${errorMessage(pushError)}`,
    );

    try {
      await abortConflictedRebase(dataRoot, runGitStep, log);
      await runGitStep(dataRoot, ["pull", "--rebase"]);
      await runGitStep(dataRoot, ["push"]);
      log("scheduled-run: pushed after retry");
    } catch (retryError) {
      log("scheduled-run: push failed again after retry");

      throw retryError;
    }
  }
}

/** The weekly full sweep's default budget (issue #359): two hours,
 *  a per-invocation override — the cycles' 1800 s default never
 *  moves. */
export const DEFAULT_LINT_FULL_TIMEOUT_MS = 7_200_000;

/** Print one usage error red on stderr and set the exit code
 *  (H-5: the shared rendering, like every sibling CLI). */
function fail(message: string): void {
  cliFail("scheduled-run", message);
}

/** The cycle's data repo, or the fail-loud reason it could not be
 *  resolved — the resolver returns errors; the shell renders them
 *  (B-12: no printing as a resolver side effect). */
export type DataRootResolution =
  | { readonly dataRoot: string; readonly error?: undefined }
  | { readonly dataRoot?: undefined; readonly error: string };

/** The data repo for the cycle — the same one wiki-sync resolves
 *  for the forwarded arguments: dirname(<raw-dir>) when the raw-dir
 *  positional is passed, else the config's expanded dataRoot. */
export async function resolveDataRoot(
  configPath: string,
  rawDir: string | undefined,
): Promise<DataRootResolution> {
  if (rawDir !== undefined) {
    return { dataRoot: dirname(rawDir) };
  }

  let config: Awaited<ReturnType<typeof loadSyncConfig>>;

  try {
    config = await loadSyncConfig(configPath, homedir());
  } catch (error) {
    return { error: errorMessage(error) };
  }

  if (config.dataRoot === undefined) {
    return {
      error: `no dataRoot in ${configPath} — the scheduled run's pull, push, and lock stage needs a data repo`,
    };
  }

  return { dataRoot: config.dataRoot };
}

/** Exit-code and stderr handling for one outcome. */
function reportOutcome(outcome: CycleOutcome): void {
  if (outcome.status === "failed") {
    fail(outcome.error);

    return;
  }

  if (outcome.status === "skipped") {
    console.log(`scheduled-run: skipped — ${outcome.reason}`);
  }
}

/** The wrapper's argv shape: the agent-run value flags wiki-sync
 *  takes, plus the --lint-full boolean only this wrapper owns
 *  (wiki-sync must reject it — the sweep is a wrapper mode, not a
 *  cycle stage). */
export function parseScheduledRunArgs(args: readonly string[]): ParsedCli {
  return parseArgs(args, {
    value: ["--settings", "--outputs", "--timeout"],
    boolean: ["--lint-full"],
    positionals: {
      max: 2,
      error: (_arg, count) =>
        `expected at most two arguments (<config> and <raw-dir>), got ${count}`,
    },
  });
}

/** scheduled-run entry point. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseScheduledRunArgs(args);

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const runFlags = agentRunFlags(parsed.values);

  if (runFlags.error !== undefined) {
    fail(runFlags.error);

    return;
  }

  const resolved = await resolveDataRoot(
    parsed.positional[0] ?? join(repoRoot, "sync.json"),
    parsed.positional[1],
  );

  if (resolved.error !== undefined) {
    fail(resolved.error);

    return;
  }

  const dataRoot = resolved.dataRoot;

  const logPath = process.env.KWIKI_SCHEDULED_LOG ?? scheduledLogPath();
  const runLog = createRunLog(logPath);
  const outcome = await runScheduledCycle({
    dataRoot,
    repoRoot,
    lockPath: runLockPath(dataRoot),
    // The sweep flag never reaches wiki-sync — it is this wrapper's
    // mode, not a wiki-sync argument.
    args: args.filter((arg) => arg !== "--lint-full"),
    lintFull: parsed.flags.has("--lint-full"),
    lintFullTimeoutMs: runFlags.timeoutMs ?? DEFAULT_LINT_FULL_TIMEOUT_MS,
    lintFullSettings: runFlags.settings,
    log: runLog.log,
    notify: async (message) => {
      await notifyUser("k-wiki", `scheduled-run: ${message}`);
    },
  });

  // Flush the log before reporting: an exit must never outrun its own
  // audit trail.
  await runLog.flush();
  reportOutcome(outcome);
}

/* v8 ignore next: covered only under direct `node src/schedule/scheduled-run.ts` runs */
refuseDirectExecution(import.meta.url, "scheduled-run");
