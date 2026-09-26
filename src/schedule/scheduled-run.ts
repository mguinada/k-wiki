/**
 * scheduled-run: the unattended wrapper the scheduler runs on a fixed
 * interval (issue #14, guide §18). One portable Node file — identical
 * on macOS/Linux/Windows; only the scheduler registration differs.
 *
 *   lockfile → quota pre-flight (an optional quota-axi probe may
 *   skip the tick before any stage) → git pull --rebase → (with
 *   --lint-full: wiki-lint --full, the weekly quality sweep, issue
 *   #359) → wiki-sync (gates + commit) → git push
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
 * node bin dir and the standard CLI install locations so the agent
 * CLI resolves without an interactive shell env.
 */

import { spawn } from "node:child_process";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
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
import { HELP } from "./scheduled-run-help.ts";
import { runSharedPipeline, scheduledSharedMode } from "./shared-cycle.ts";

/** The PATH a scheduled run gets: node's bin dir first (the wrapper
 *  and any sibling CLIs), then the standard install locations — the
 *  agent CLI resolves with no interactive shell env (issue #14).
 *  It also carries `KWIKI_RUN_LOCK_HELD=1`: this wrapper already
 *  holds the run lock across the whole cycle, so the spawned
 *  wiki-sync child must not re-acquire it (issue #313).
 *  ponytail: unix PATH layout; revisit when a Windows scheduler
 *  backend lands (issue #14 follow-up) — delimiter and dirs differ. */
export function buildScheduledEnv(
  home: string,
  execPath: string,
): NodeJS.ProcessEnv {
  const nodeBin = dirname(execPath);

  return {
    HOME: home,
    KWIKI_RUN_LOCK_HELD: "1",
    PATH: [
      nodeBin,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
  };
}

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

  log(
    `scheduled-run: ${stamp()} — ${lock === "took-over" ? "took over a stale lock; " : ""}starting cycle`,
  );

  const quota = await runQuotaGate(options, log);

  if (quota.skipReason !== undefined) {
    await releaseLock(options.lockPath, pid);
    await stampHeartbeat("skipped", quota.skipReason);
    return { status: "skipped", reason: quota.skipReason };
  }

  try {
    await runStage(options, runGitStep, log);
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
  const parsed = parseScheduledRunArgs(options.args ?? []);
  const settingsPath =
    parsed.values.get("--settings") ?? join(options.repoRoot, "settings.yml");

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
 *  sync sequence and its push-with-retry. */
async function runStage(
  options: ScheduledRunOptions,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
): Promise<void> {
  if (await scheduledSharedMode(options)) {
    await runSharedPipeline(options, log);

    // The shared coordinator finalized remotely (branch advance and
    // lease release in one atomic push); a wrapper push here would
    // race the lease protocol and is never issued in shared mode.
    log(
      "scheduled-run: shared-writer cycle complete — remote finalized by the coordinator",
    );

    return;
  }

  await runPipelineStages(options, runGitStep, log);
  await pushWithRetry(options.dataRoot, runGitStep, log);
}

async function runPipelineStages(
  options: ScheduledRunOptions,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
): Promise<void> {
  await runGitStep(options.dataRoot, ["remote", "get-url", "origin"]);
  await pullWhenClean(options.dataRoot, runGitStep, log);

  if (options.lintFull === true) {
    const timeoutMs = options.lintFullTimeoutMs ?? DEFAULT_LINT_FULL_TIMEOUT_MS;
    const runLintFull =
      options.runLintFull ??
      (async (lintArgs: readonly string[]) => {
        await spawnRepoScript(options.repoRoot, "wiki-lint", lintArgs, log);
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
      await spawnRepoScript(options.repoRoot, "wiki-sync", syncArgs, log);
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

/** Stream one child pipe into the log without tearing lines
 *  (issue #244): a chunk can end mid-line, so each pipe
 *  buffers its own tail and only complete `\n`-terminated lines are
 *  recorded; a final fragment without a newline is flushed at end. */
function streamChildLines(source: Readable, log: (line: string) => void): void {
  let pending = "";

  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    pending += chunk;
    const cut = pending.lastIndexOf("\n");

    if (cut === -1) {
      return;
    }

    const complete = pending.slice(0, cut);
    pending = pending.slice(cut + 1);

    for (const line of complete.split("\n")) {
      if (line !== "") {
        log(line);
      }
    }
  });
  source.on("end", () => {
    if (pending !== "") {
      log(pending);
      pending = "";
    }
  });
}

/** The weekly full sweep's default budget (issue #359): two hours,
 *  a per-invocation override — the cycles' 1800 s default never
 *  moves. */
export const DEFAULT_LINT_FULL_TIMEOUT_MS = 7_200_000;

/** Run one of the repo's bin/ scripts as a child with the scheduled
 *  env, streaming its stdout and stderr into the log. */
export async function spawnRepoScript(
  repoRoot: string,
  name: string,
  args: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  const env = buildScheduledEnv(
    process.env.HOME ?? homedir(),
    process.execPath,
  );
  const child = spawn(
    process.execPath,
    [join(repoRoot, "bin", name), ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  streamChildLines(child.stdout, log);
  streamChildLines(child.stderr, log);

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", resolveCode);
  });

  if (code !== 0) {
    // code is null exactly when a signal killed the child — name it
    // instead of reporting "exited null" (issue #244).
    throw new Error(
      child.signalCode === null
        ? `${name} exited ${code}`
        : `${name} exited by signal ${child.signalCode}`,
    );
  }
}

/** The log file for this machine: `~/Library/Logs/k-wiki/` on macOS
 *  (the only scheduled platform today), the XDG state dir elsewhere. */
export function scheduledLogPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "darwin"
    ? join(home, "Library", "Logs", "k-wiki", "scheduled-run.log")
    : join(home, ".local", "state", "k-wiki", "logs", "scheduled-run.log");
}

/** Rotate the log at 5 MiB: one previous generation (`.1`) is kept,
 *  older ones dropped — enough history for a personal wiki, no growth
 *  beyond ~10 MiB. */
export async function rotateLogIfNeeded(
  logPath: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<void> {
  const size = await stat(logPath).then(
    (info) => info.size,
    () => 0,
  );

  if (size >= maxBytes) {
    await rename(logPath, `${logPath}.1`).catch(() => {});
  }
}

/** Append one line to the run log, rotating first. Best-effort: a
 *  failed log write reports to stderr and never fails the cycle. */
export async function appendLog(logPath: string, line: string): Promise<void> {
  try {
    await rotateLogIfNeeded(logPath);
    await mkdir(dirname(logPath), { recursive: true });
    await appendFileLine(logPath, line);
  } catch (error) {
    console.error(`scheduled-run: log write failed — ${errorMessage(error)}`);
  }
}

/** The run's serialized log writer (issue #244): one append in
 *  flight, every line recorded in arrival order. */
export interface RunLogWriter {
  readonly log: (line: string) => void;
  readonly flush: () => Promise<void>;
}

/** Serialize log appends through one queue: fire-and-forget appends
 *  raced each other and the rotation (two concurrent appends can both
 *  pass the 5 MiB check and both rename — one generation is lost),
 *  and interleaved opens recorded lines out of order. The queue
 *  keeps exactly one appendLog in flight and orders the rest; flush
 *  settles when the last line is on disk. */
export function createRunLog(
  logPath: string,
  append: (logPath: string, line: string) => Promise<void> = appendLog,
): RunLogWriter {
  let tail: Promise<void> = Promise.resolve();

  return {
    log: (line: string): void => {
      tail = tail.then(() => append(logPath, line));
    },
    flush: (): Promise<void> => tail,
  };
}

async function appendFileLine(logPath: string, line: string): Promise<void> {
  const handle = await open(logPath, "a");

  await handle.writeFile(`${line}\n`);
  await handle.close();
}

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
