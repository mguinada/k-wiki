import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../cli/colors.ts";
import { flagValueError, readFlagValues } from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { runGit } from "../data/git.ts";
import { loadSyncConfig } from "../sync/config.ts";

/**
 * scheduled-run: the unattended wrapper the scheduler runs on a fixed
 * interval (issue #14, guide §18). One portable Node file — identical
 * on macOS/Linux/Windows; only the scheduler registration differs.
 *
 *   lockfile → git pull --rebase → wiki-sync (gates + commit) → git push
 *
 * Overlap guard (issue #14 decision 3): an atomic `O_EXCL` lockfile
 * with PID + timestamp at the data repo root — outside wiki-sync's
 * wiki/raw/outputs commit pathspecs, so the sync can never commit or
 * stage it — same-machine overlap is *prevented*; a lock older than
 * LOCK_STALE_MS is taken over (a killed run must never wedge the
 * schedule). Cross-
 * machine overlap is not prevented but made recoverable: the pre-run
 * `pull --rebase` and the push's rejection → pull --rebase → retry
 * -once → alert sequence keep any slipped-through overlap visible
 * instead of silently diverged (decisions 4–5). A lease lock as a
 * git ref is the known upgrade path if a second machine ever runs
 * scheduled syncs — deferred until then.
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

/** A lock older than this is stale and taken over (a full cycle —
 *  two agent stages at a 30-min timeout each — stays well inside it). */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/** The parsed contents of a lockfile: PID + ISO timestamp. */
export interface LockFileData {
  readonly pid: number;
  readonly takenAt: string;
}

/** Parse a lockfile's contents; undefined when unreadable or
 *  incomplete (a crash between create and write leaves a partial
 *  file — treated as stale, never trusted). */
export function lockData(raw: string): LockFileData | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pid" in parsed) ||
      !("takenAt" in parsed) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.takenAt !== "string"
    ) {
      return undefined;
    }

    return { pid: parsed.pid, takenAt: parsed.takenAt };
  } catch {
    return undefined;
  }
}

export interface AcquireLockOptions {
  /** Clock for staleness; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Age past which an existing lock is taken over. */
  readonly staleMs?: number;
  /** The PID recorded in the lock; defaults to process.pid. */
  readonly pid?: number;
}

/** The outcome of one lock acquisition attempt. */
export type LockOutcome = "acquired" | "took-over" | "busy";

/**
 * Atomically acquire the run lock: `open(..., "wx")` — the O_EXCL
 * create fails when the file exists, so two concurrent acquirers
 * cannot both win. An existing lock older than the stale timeout (or
 * unreadable) is taken over; a fresh one reports busy.
 */
export async function acquireLock(
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<LockOutcome> {
  const now = options.now ?? (() => new Date());
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const pid = options.pid ?? process.pid;

  const handle = await open(lockPath, "wx").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    return undefined;
  });

  if (handle !== undefined) {
    await handle.writeFile(
      `${JSON.stringify({ pid, takenAt: now().toISOString() })}\n`,
    );
    await handle.close();

    return "acquired";
  }

  const existing = lockData(await readFile(lockPath, "utf8").catch(() => ""));
  const fresh =
    existing !== undefined &&
    now().getTime() - Date.parse(existing.takenAt) < staleMs;

  if (fresh) {
    return "busy";
  }

  await rm(lockPath, { force: true });
  const reacquired = await acquireLock(lockPath, options);

  return reacquired === "busy" ? "busy" : "took-over";
}

/** Release the lock only when the recorded pid is this process's,
 *  and delete it by atomic claim (issue #244): the lock is first
 *  renamed to a private path, so the unlink can never hit a
 *  successor's fresh lock — a run outliving LOCK_STALE_MS whose
 *  lock was taken over would otherwise rm by path and delete the
 *  successor's lock in the read-to-delete window, breaking mutual
 *  exclusion exactly in the long-run scenario. A claim that raced
 *  such a takeover is given back; an absent or foreign lock is
 *  never touched. */
export async function releaseLock(
  lockPath: string,
  pid: number = process.pid,
): Promise<void> {
  const existing = lockData(await readFile(lockPath, "utf8").catch(() => ""));

  if (existing?.pid !== pid) {
    return;
  }

  const claimed = `${lockPath}.releasing.${pid}`;

  await rename(lockPath, claimed).catch(() => undefined);

  const claim = lockData(await readFile(claimed, "utf8").catch(() => ""));

  if (claim?.pid === pid) {
    await rm(claimed, { force: true });

    return;
  }

  await restoreClaimedLock(claimed, lockPath);
}

/** Give a claimed-but-foreign lock back: the hard link lands only
 *  while the lock path is free — an EEXIST means another run
 *  already re-holds the path, and the claim is dropped instead. */
async function restoreClaimedLock(
  claimed: string,
  lockPath: string,
): Promise<void> {
  await link(claimed, lockPath).catch(() => undefined);
  await rm(claimed, { force: true });
}

/** The PATH a scheduled run gets: node's bin dir first (the wrapper
 *  and any sibling CLIs), then the standard install locations — the
 *  agent CLI resolves with no interactive shell env (issue #14).
 *  ponytail: unix PATH layout; revisit when a Windows scheduler
 *  backend lands (issue #14 follow-up) — delimiter and dirs differ. */
export function buildScheduledEnv(
  home: string,
  execPath: string,
): NodeJS.ProcessEnv {
  const nodeBin = dirname(execPath);

  return {
    HOME: home,
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
  /** Log sink; default: silent (the CLI main wires the log file). */
  readonly log?: (line: string) => void;
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
   *  repo's bin/wiki-sync.ts. Injected in tests. */
  readonly runSync?: (args: readonly string[]) => Promise<void>;
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

  const fail = async (error: string): Promise<CycleOutcome> => {
    log(`scheduled-run: ALERT ${error}`);

    await releaseLock(options.lockPath, pid);

    return { status: "failed", error };
  };

  await mkdir(dirname(options.lockPath), { recursive: true });

  const lock = await acquireLock(options.lockPath, { now, pid });

  if (lock === "busy") {
    return {
      status: "skipped",
      reason: "another run holds the lock (fresh) — skipping this tick",
    };
  }

  log(
    `scheduled-run: ${stamp()} — ${lock === "took-over" ? "took over a stale lock; " : ""}starting cycle`,
  );

  try {
    await runPipelineStages(options, runGitStep, log);
  } catch (error) {
    return await fail(errorMessage(error));
  }

  try {
    await pushWithRetry(options.dataRoot, runGitStep, log);
  } catch (error) {
    return await fail(errorMessage(error));
  }

  await releaseLock(options.lockPath, pid);
  log(`scheduled-run: ${stamp()} — cycle complete`);

  return { status: "ok" };
}

/** The pre-push stages: verify origin, pull --rebase, wiki-sync. Any
 *  failure throws — wiki-sync's guardrails and verification have
 *  already reverted their agent runs, so the wiki stays at the last
 *  good commit and the next interval is the recovery. */
async function runPipelineStages(
  options: ScheduledRunOptions,
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>,
  log: (line: string) => void,
): Promise<void> {
  await runGitStep(options.dataRoot, ["remote", "get-url", "origin"]);
  await pullWhenClean(options.dataRoot, runGitStep, log);
  log("scheduled-run: wiki-sync starting");

  const runSync =
    options.runSync ??
    (async (syncArgs: readonly string[]) => {
      await spawnWikiSync(options.repoRoot, syncArgs, log);
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

/** True when the path exists; a failed stat — missing, or a parent
 *  that is a regular file (a linked worktree's `.git`) — reads as
 *  false. */
async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
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

/** Run bin/wiki-sync.ts as a child with the scheduled env, streaming
 *  its stdout and stderr into the log. */
async function spawnWikiSync(
  repoRoot: string,
  args: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  const env = buildScheduledEnv(
    process.env.HOME ?? homedir(),
    process.execPath,
  );
  const child = spawn(
    process.execPath,
    [join(repoRoot, "bin", "wiki-sync.ts"), ...args],
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
        ? `wiki-sync exited ${code}`
        : `wiki-sync exited by signal ${child.signalCode}`,
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: scheduled-run [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]

Run one unattended pipeline cycle — the command the
launchd job executes every interval. The wrapper is portable Node:
lockfile → git pull --rebase → wiki-sync (sync → ingest → lint →
crosslinks → verification → commit) → git push. wiki-sync stays
commit-only; the push happens here and only here.

  --settings <path>  Forwarded to wiki-sync. Default: the repo's
                     settings.yml.
  --outputs <dir>    Forwarded to wiki-sync (ingest digest location).
                     Default: the repo's outputs/.
  --timeout <secs>   Forwarded to wiki-sync. Default: 1800.
  -h, --help         Print this help and exit; no side effects.
  <config>           Forwarded to wiki-sync. Default: the repo's
                     sync.json.
  <raw-dir>          Forwarded to wiki-sync. Default: <dataRoot>/raw.

Behavior, failure mode by failure mode:
  - Overlap (same machine): an O_EXCL lockfile at
    <dataRoot>/.scheduled-run.lock (PID + timestamp) prevents
    concurrent runs; a lock older than two hours is taken over, so a
    killed run never wedges the schedule. The file lives at the data
    repo root — outside wiki-sync's wiki/raw/outputs commit
    pathspecs — so the sync can never commit or stage it.
  - Overlap (across machines): not prevented — recovered. The pre-run
    git pull --rebase keeps the run on a fresh base; a push rejection
    gets one pull --rebase + retry; a second failure logs an ALERT
    line and exits 1. A conflicted pull --rebase leaves the repo
    mid-rebase; the next tick aborts it (git rebase --abort before
    each pull site) and retries with the tree actionable — divergent
    content stays for the operator to resolve manually.
  - No origin: the data repo must have an origin remote (the push
    stage needs one); the wrapper fails loud without running.
  - wiki-sync failure: the guardrails and verification have already
    reverted the run — the wiki stays at the last good commit, the
    error and digest land in the log, exit 1. The next interval is
    the recovery (no retry/backoff, guide §26).
  - Dirty tree: a failed or killed sync leaves its edits uncommitted
    on purpose (the fix surface). The next tick skips its pre-run
    pull — a rebase refuses a dirty tree — so that recovery stays
    reachable; the push-rejection path owns any divergence that
    follows.
  - Logs: ~/Library/Logs/k-wiki/scheduled-run.log (rotated at 5 MiB,
    one previous generation kept); wiki-sync's digest and progress
    stream into the same file. KWIKI_SCHEDULED_LOG overrides the log
    path (tests and multi-instance setups).

Exits 0 on a completed or skipped cycle, 1 on failure.`;

/** Print one usage error to stderr. */
function fail(message: string): void {
  console.error(`scheduled-run: ${message}`);
}

/** The parsed command line, or the first usage error. */
interface ParsedArgs {
  readonly error: string | undefined;
  readonly positional: readonly string[];
  readonly values: Map<string, string | undefined>;
}

/** Same flag set and positional rules as wiki-sync — the wrapper
 *  forwards everything verbatim and uses the flags to resolve the
 *  same data repo for its lock, pull, and push. */
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

/** The data repo for the cycle — the same one wiki-sync resolves
 *  for the forwarded arguments: dirname(<raw-dir>) when the raw-dir
 *  positional is passed, else the config's expanded dataRoot.
 *  undefined after printing the fail-loud reason (no config, no
 *  dataRoot). */
export async function resolveDataRoot(
  configPath: string,
  rawDir: string | undefined,
): Promise<string | undefined> {
  if (rawDir !== undefined) {
    return dirname(rawDir);
  }

  let config: Awaited<ReturnType<typeof loadSyncConfig>>;

  try {
    config = await loadSyncConfig(configPath, homedir());
  } catch (error) {
    fail(errorMessage(error));

    return undefined;
  }

  if (config.dataRoot === undefined) {
    fail(
      `no dataRoot in ${configPath} — the scheduled run's pull, push, and lock stage needs a data repo`,
    );

    return undefined;
  }

  return config.dataRoot;
}

/** Exit-code and stderr handling for one outcome. */
function reportOutcome(outcome: CycleOutcome): void {
  if (outcome.status === "failed") {
    fail(outcome.error);
    process.exitCode = 1;

    return;
  }

  if (outcome.status === "skipped") {
    console.log(`scheduled-run: skipped — ${outcome.reason}`);
  }
}

/** scheduled-run entry point. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseCliArgs(args);

  if (parsed.error !== undefined) {
    fail(parsed.error);
    process.exitCode = 1;

    return;
  }

  const flagError = flagValueError(parsed.values);

  if (flagError !== undefined) {
    fail(flagError);
    process.exitCode = 1;

    return;
  }

  const dataRoot = await resolveDataRoot(
    parsed.positional[0] ?? join(repoRoot, "sync.json"),
    parsed.positional[1],
  );

  if (dataRoot === undefined) {
    process.exitCode = 1;

    return;
  }

  const logPath = process.env.KWIKI_SCHEDULED_LOG ?? scheduledLogPath();
  const runLog = createRunLog(logPath);
  const outcome = await runScheduledCycle({
    dataRoot,
    repoRoot,
    lockPath: join(dataRoot, ".scheduled-run.lock"),
    args,
    log: runLog.log,
  });

  // Flush the log before reporting: an exit must never outrun its own
  // audit trail.
  await runLog.flush();
  reportOutcome(outcome);
}

/* v8 ignore next: covered only under direct `node src/schedule/scheduled-run.ts` runs */
refuseDirectExecution(import.meta.url, "scheduled-run");
