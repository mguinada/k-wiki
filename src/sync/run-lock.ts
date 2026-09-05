import { link, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The run lock (issues #14, #313): one atomic `O_EXCL` lockfile per
 * data repo — `<dataRoot>/.scheduled-run.lock` — held across one
 * sync cycle by whoever runs it. Both cycle owners share it:
 * `scheduled-run` acquires it around its whole wrapper cycle (pull →
 * wiki-sync → push), and a manual `wiki-sync` acquires it at cycle
 * start — so a manual cycle in progress makes the next scheduled
 * firing skip (redundant work; launchd re-fires), while a scheduled
 * cycle in progress makes a manual run fail loud naming the holder
 * (an explicit human request is never silently dropped). The file
 * lives at the data repo root — outside wiki-sync's wiki/raw/outputs
 * commit pathspecs, so the sync can never commit or stage it.
 *
 * The wrapper-held case: when `scheduled-run` spawns `bin/wiki-sync`
 * as a child, the child must not re-acquire its parent's fresh lock —
 * the wrapper's env (`buildScheduledEnv`) carries
 * `KWIKI_RUN_LOCK_HELD=1` and the child skips the tenure.
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

/** The run lock's path for a data repo — one lock per instance, so
 *  engineering and meta cycles never contend on the same file. */
export function runLockPath(dataRoot: string): string {
  return join(dataRoot, ".scheduled-run.lock");
}

/** The current holder of a lockfile, or undefined when unreadable
 *  (absent, racing, or a partial crash leftover). */
export async function readLockHolder(
  lockPath: string,
): Promise<LockFileData | undefined> {
  return lockData(await readFile(lockPath, "utf8").catch(() => ""));
}

/** The holder line every skip/refusal message shares:
 *  "in progress since HH:MM (PID N)" — local time, the clock a human
 *  reads at the terminal. */
export function holderDescription(holder: LockFileData): string {
  const taken = new Date(holder.takenAt);

  return `in progress since ${String(taken.getHours()).padStart(2, "0")}:${String(taken.getMinutes()).padStart(2, "0")} (PID ${holder.pid})`;
}

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
