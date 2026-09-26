/**
 * The failed-cycle fix surface's recovery (issue #400): the one
 * executor behind both doors — the `recover-fix-surface` verb (show
 * and recover) and the coordinator's bounded auto-recovery. A
 * recovery discards exactly the recorded paths and settles the lease
 * by exact-OID replace; any divergence between the live dirty set
 * and the record is a refusal, so a human edit made after the
 * failure is never eaten. The record itself is the sibling
 * `recovery-record.ts` module's subject.
 */

import { errorMessage } from "../cli/colors.ts";
import { surfaceEntries } from "./cycle-steps.ts";
import { type GitRunner, lsRemoteOid } from "./git-remote.ts";
import {
  FAILED_CYCLE_LEASE_TTL_MS,
  leaseExpired,
  type ObservedLease,
} from "./lease.ts";
import { fetchedTreeOid, replaceLease } from "./lease-ops.ts";
import type { SharedWriterMarker } from "./marker.ts";
import {
  clearRecord,
  divergenceMessage,
  divergenceOf,
  evaluateSurface,
  type RecoveryRecord,
  readRecoveryRecord,
  writeRecord,
} from "./recovery-record.ts";

/**
 * The refused ticks one recorded surface accumulates before the
 * coordinator recovers it itself (issue #400): three ticks are about
 * ninety minutes at the default 30-minute interval — the same window
 * the watchdog allows before it alerts — so a recoverable block
 * self-heals exactly when the operator would be alerted, and no
 * faster: three quiet intervals are the falsification of "a human
 * will look at it".
 */
export const AUTO_RECOVERY_REFUSED_TICKS = 3;

const NOTHING_RECORDED =
  "nothing to recover — no failed-cycle surface is recorded";

/** Undo the recorded surface, scoped to exactly the recorded paths:
 *  tracked files restore from HEAD (staged and worktree together),
 *  staged adds unstage and clean away, untracked files clean away —
 *  never a repo-wide reset or clean. */
async function discardSurface(
  git: GitRunner,
  paths: readonly string[],
): Promise<void> {
  const wanted = new Set(paths);
  const entries = (await surfaceEntries(git)).filter(
    (entry) =>
      wanted.has(entry.path) ||
      (entry.origin !== undefined && wanted.has(entry.origin)),
  );
  const tracked = entries
    .filter((entry) => !entry.untracked && !entry.code.includes("A"))
    .flatMap((entry) =>
      entry.origin === undefined ? [entry.path] : [entry.path, entry.origin],
    );
  const added = entries
    .filter((entry) => !entry.untracked && entry.code.includes("A"))
    .map((entry) => entry.path);
  const untracked = [
    ...entries.filter((entry) => entry.untracked).map((entry) => entry.path),
    ...added,
  ];

  if (tracked.length > 0) {
    await git([
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...tracked,
    ]);
  }

  if (added.length > 0) {
    await git(["rm", "-f", "--cached", "--quiet", "--", ...added]);
  }

  if (untracked.length > 0) {
    await git(["clean", "-f", "--", ...untracked]);
  }
}

/** What a recovery did. */
export interface RecoveryOutcome {
  readonly cycleId: string;
  readonly discarded: readonly string[];
  /** The fresh lease that replaced the recorded one, when a live
   *  lease was retaken; null when the lane was left free. */
  readonly replacement: ObservedLease | null;
}

/** The record a recovery operates on, or the standing refusal. */
async function requireRecord(git: GitRunner): Promise<RecoveryRecord> {
  const record = await readRecoveryRecord(git);

  if (record === undefined) {
    throw new Error(NOTHING_RECORDED);
  }

  return record;
}

/** The safety gates every recovery passes before the first write:
 *  no path divergence, no lease moved off its recorded OID, and —
 *  for the cycle door — a lapsed lease. */
function assertRecoverable(options: {
  readonly record: RecoveryRecord;
  readonly evaluation: Awaited<ReturnType<typeof evaluateSurface>>;
  readonly requireExpired: boolean;
  readonly now: () => Date;
}): void {
  const divergence = divergenceOf(options.evaluation);

  if (divergence.length > 0) {
    throw new Error(divergenceMessage(divergence));
  }

  const { lease } = options.evaluation;

  if (
    lease !== undefined &&
    options.record.lease !== null &&
    lease.oid !== options.record.lease.oid
  ) {
    throw new Error(
      `the recorded lease ${options.record.lease.ref} moved off ${options.record.lease.oid.slice(0, 8)} — someone intervened; resolve by hand`,
    );
  }

  if (
    options.requireExpired &&
    lease !== undefined &&
    !leaseExpired(lease.body, options.now)
  ) {
    throw new Error(
      `recovery deferred — the retained lease is still live (expires ${lease.body.expires})`,
    );
  }
}

/** The lease's settled state after a recovery: the fresh retake
 *  under the short dead-man window, or a free lane. */
async function settleLease(
  options: {
    readonly git: GitRunner;
    readonly marker: SharedWriterMarker;
    readonly now: () => Date;
    readonly holder: string;
    readonly retakeLease?: boolean;
  },
  record: RecoveryRecord,
  lease: ObservedLease | undefined,
): Promise<ObservedLease | null> {
  if (options.retakeLease !== true || lease === undefined) {
    return null;
  }

  return await retakeRecordedLease(
    options.git,
    options.marker,
    record,
    options,
  );
}

/** Discard the recorded surface and settle the lease. Refuses on any
 *  divergence between the live dirty set and the record, and on a
 *  lease that moved off its recorded OID; the paths are discarded
 *  only after every check passed. */
export async function recoverRecordedSurface(options: {
  readonly git: GitRunner;
  readonly marker: SharedWriterMarker;
  readonly now: () => Date;
  readonly holder: string;
  /** Refuse while the recorded lease is still live (the cycle door
   *  never touches a live lease; the human verb may run anytime). */
  readonly requireExpired?: boolean;
  /** Retake a live recorded lease by exact OID under the short
   *  dead-man window (the human verb keeps the lane serialized). */
  readonly retakeLease?: boolean;
  readonly log?: (line: string) => void;
}): Promise<RecoveryOutcome> {
  const record = await requireRecord(options.git);
  const evaluation = await evaluateSurface({
    git: options.git,
    marker: options.marker,
    record,
  });

  if (evaluation.livePaths.length === 0) {
    // The surface resolved itself (a human cleaned it up): there is
    // nothing to discard and the record is stale.
    await clearRecord(options.git);
    options.log?.(
      `fix surface of cycle ${record.cycleId} was already clean — cleared the stale record`,
    );

    return { cycleId: record.cycleId, discarded: [], replacement: null };
  }

  assertRecoverable({
    record,
    evaluation,
    requireExpired: options.requireExpired === true,
    now: options.now,
  });

  await discardSurface(options.git, record.paths);

  const replacement = await settleLease(options, record, evaluation.lease);

  await clearRecord(options.git);
  options.log?.(
    `auto-recovered fix surface from cycle ${record.cycleId}: ${record.paths.join(", ")}`,
  );

  return { cycleId: record.cycleId, discarded: record.paths, replacement };
}

/** The exact-OID retake: fresh recovery lease, short dead-man TTL,
 *  never release-then-acquire. */
async function retakeRecordedLease(
  git: GitRunner,
  marker: SharedWriterMarker,
  record: RecoveryRecord,
  timings: { readonly now: () => Date; readonly holder: string },
): Promise<ObservedLease> {
  if (record.lease === null) {
    throw new Error("no recorded lease to retake — the lane is already free");
  }

  await git([
    "fetch",
    "--force",
    marker.remote,
    `${marker.leaseRef}:refs/k-wiki/lease-observed`,
  ]);
  const base = await lsRemoteOid(
    git,
    marker.remote,
    `refs/heads/${marker.branch}`,
  );

  if (base === undefined) {
    throw new Error(
      `remote ${marker.remote} has no refs/heads/${marker.branch} — cannot anchor a recovery lease; fail closed`,
    );
  }

  return await replaceLease({
    git,
    remote: marker.remote,
    leaseRef: marker.leaseRef,
    expectedOid: record.lease.oid,
    treeOid: await fetchedTreeOid(git, "refs/k-wiki/lease-observed"),
    base,
    now: timings.now,
    holder: timings.holder,
    ttlMs: FAILED_CYCLE_LEASE_TTL_MS,
  });
}

/** The coordinator's per-tick hook: count this refusal toward
 *  auto-recovery and, past the threshold with the lease lapsed (or
 *  the lane free), run the recovery. Returns true when the surface
 *  was auto-recovered — the caller's dirty check then passes. A
 *  divergence disables auto-recovery permanently for this surface
 *  and escalates once; a record whose surface resolved itself is
 *  stale and quietly cleared. */
export async function noteRefusedTick(options: {
  readonly git: GitRunner;
  readonly marker: SharedWriterMarker;
  readonly now: () => Date;
  readonly holder: string;
  readonly log: (line: string) => void;
}): Promise<boolean> {
  const record = await readRecoveryRecord(options.git);

  if (record === undefined || record.autoDisabled === true) {
    return false;
  }

  const evaluation = await evaluateSurface({
    git: options.git,
    marker: options.marker,
    record,
  });

  if (evaluation.livePaths.length === 0) {
    // The surface resolved itself (a human cleaned it up): the
    // record is stale, and the next dirty check passes anyway.
    await clearRecord(options.git);

    return false;
  }

  const divergence = divergenceOf(evaluation);

  if (divergence.length > 0) {
    await writeRecord(options.git, { ...record, autoDisabled: true });
    options.log(
      `ALERT: auto-recovery aborted permanently for cycle ${record.cycleId} — ${divergenceMessage(divergence)}; resolve by hand`,
    );

    return false;
  }

  const refusedTicks = record.refusedTicks + 1;
  const leaseLapsed =
    evaluation.lease === undefined ||
    leaseExpired(evaluation.lease.body, options.now);

  if (refusedTicks < AUTO_RECOVERY_REFUSED_TICKS || !leaseLapsed) {
    await writeRecord(options.git, { ...record, refusedTicks });

    return false;
  }

  try {
    await recoverRecordedSurface({
      ...options,
      requireExpired: true,
      retakeLease: false,
    });
  } catch (error) {
    // A recovery refusal (a lease race, a moved ref) never crashes
    // the tick: it stays a refusal the operator can see.
    options.log(`auto-recovery refused — ${errorMessage(error)}`);

    return false;
  }

  return true;
}
