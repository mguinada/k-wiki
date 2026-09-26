/**
 * Lease lifecycle operations (issue #390): acquire, renew, retain
 * a failed cycle's lease, take over, finalize, and conditionally
 * release — each a compare-and-swap push over the lease ref, each
 * failing closed when its expected OID no longer matches. Acquire creates the absent ref with a plain
 * push (a racing creator loses the non-fast-forward check); renewal
 * and takeover replace by exact OID; finalize is the single atomic
 * push that advances the branch and deletes the owned lease together;
 * a no-op release deletes only the exact owned lease after fresh
 * observation. Branch updates in finalize are never forced — a
 * non-fast-forward branch advance must refuse, never overwrite.
 */

import type { GitRunner } from "./git-remote.ts";
import { gitOut, lsRemoteOid } from "./git-remote.ts";
import {
  casPush,
  createLeaseCommit,
  describeLease,
  FAILED_CYCLE_LEASE_TTL_MS,
  type LeaseBody,
  leaseExpired,
  newLeaseBody,
  type ObservedLease,
  observeLease,
} from "./lease.ts";

/** The outcome of an acquire attempt against a live remote. */
export type AcquireOutcome =
  | { readonly status: "acquired"; readonly lease: ObservedLease }
  | { readonly status: "refused"; readonly reason: string };

/** Create a new tree-less-parent lease commit and CAS-create the
 *  absent lease ref. A refused attempt names the live holder and
 *  expiry when the winning lease is parseable — the fail-loud text
 *  the state machine reports before touching `raw/` or `wiki/`. */
export async function acquireLease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly leaseRef: string;
  /** The remote branch's tree OID (`<remote-branch>^{tree}`), from
   *  the fetch the caller already did. */
  readonly treeOid: string;
  /** The remote branch OID the writer is based on. */
  readonly base: string;
  readonly now: () => Date;
  readonly holder: string;
  readonly token?: string;
}): Promise<AcquireOutcome> {
  const { git, remote, leaseRef, treeOid, base, now, holder } = options;
  const body = newLeaseBody(
    base,
    now,
    holder,
    options.token === undefined ? {} : { token: options.token },
  );
  const oid = await createLeaseCommit(git, treeOid, body);

  try {
    await casPush(git, remote, [{ ref: leaseRef, oid }]);

    return { status: "acquired", lease: { oid, body } };
  } catch (error) {
    const live = await observeLease(git, remote, leaseRef);

    if (live === undefined) {
      throw error;
    }

    return {
      status: "refused",
      reason: `lease ${leaseRef} ${describeLease(live)}`,
    };
  }
}

/** The fresh lease a replacement writes: new expiry, bumped renewal
 *  count for a renewal; a takeover restarts the sequence under a new
 *  token. */
function replacementBody(
  previous: LeaseBody | undefined,
  base: string,
  now: () => Date,
  holder: string,
  ttlMs?: number,
): LeaseBody {
  const fresh = newLeaseBody(
    base,
    now,
    holder,
    ttlMs === undefined ? {} : { ttlMs },
  );

  if (previous === undefined) {
    return fresh;
  }

  return {
    ...fresh,
    token: previous.token,
    renewals: previous.renewals + 1,
  };
}

/** Replace the lease by exact expected OID — the shared mechanics of
 *  renewal (same token, renewals+1) and takeover (new token,
 *  renewals 0). A compare-and-swap loss throws, naming the ref. */
export async function replaceLease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly leaseRef: string;
  readonly expectedOid: string;
  /** The current live lease being replaced (renewal), undefined for
   *  a takeover. */
  readonly previous?: LeaseBody;
  readonly treeOid: string;
  readonly base: string;
  readonly now: () => Date;
  readonly holder: string;
  /** Override the normal lease TTL for terminal-failure retention. */
  readonly ttlMs?: number;
}): Promise<ObservedLease> {
  const { git, remote, leaseRef, expectedOid, previous } = options;
  const body = replacementBody(
    previous,
    options.base,
    options.now,
    options.holder,
    options.ttlMs,
  );
  const oid = await createLeaseCommit(git, options.treeOid, body);

  await casPush(git, remote, [{ ref: leaseRef, oid, expectedOid }]);

  return { oid, body };
}

/** Renew the caller's own lease before or after a long agent stage:
 *  same token, expiry extended, renewals+1, exact-OID fence. A lost
 *  race must abort the caller before its final push (issue #390). */
export async function renewLease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly leaseRef: string;
  readonly current: ObservedLease;
  readonly treeOid: string;
  readonly base: string;
  readonly now: () => Date;
  readonly holder: string;
}): Promise<ObservedLease> {
  return await replaceLease({
    ...options,
    expectedOid: options.current.oid,
    previous: options.current.body,
  });
}

/** Replace a failed cycle's lease with the short dead-man window. The
 *  exact current OID remains the fence, so there is no release gap. */
export async function retainFailedCycleLease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly leaseRef: string;
  readonly current: ObservedLease;
  readonly treeOid: string;
  readonly now: () => Date;
}): Promise<ObservedLease> {
  return await replaceLease({
    git: options.git,
    remote: options.remote,
    leaseRef: options.leaseRef,
    expectedOid: options.current.oid,
    previous: options.current.body,
    treeOid: options.treeOid,
    base: options.current.body.base,
    now: options.now,
    holder: options.current.body.holder,
    ttlMs: FAILED_CYCLE_LEASE_TTL_MS,
  });
}

/** Take over an expired observed lease — the only automatic
 *  takeover. Refuses (does not throw past the caller) when the
 *  observed lease is still live: availability never beats safety
 *  here. */
export async function takeOverExpiredLease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly leaseRef: string;
  readonly observed: ObservedLease;
  readonly treeOid: string;
  readonly base: string;
  readonly now: () => Date;
  readonly holder: string;
}): Promise<AcquireOutcome> {
  if (!leaseExpired(options.observed.body, options.now)) {
    return {
      status: "refused",
      reason: `lease ${options.leaseRef} is not expired — ${describeLease(options.observed)}`,
    };
  }

  const lease = await replaceLease({
    ...options,
    expectedOid: options.observed.oid,
  });

  return { status: "acquired", lease };
}

/** The atomic finalize (issue #390 step 9): advance the branch to
 *  the new content head and delete the exact owned lease in one
 *  atomic push, the deletion fenced by the owner's lease OID. The
 *  branch update is a normal (never forced) update — a remote
 *  advance refuses it. Returns git's report only after verifying the
 *  remote branch head reads back as the pushed OID. */
export async function finalizeWithLeaseRelease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly branchRef: string;
  readonly leaseRef: string;
  readonly newBranchOid: string;
  readonly leaseOid: string;
}): Promise<string> {
  const { git, remote, branchRef, leaseRef, newBranchOid, leaseOid } = options;

  await casPush(
    git,
    remote,
    [
      { ref: branchRef, oid: newBranchOid },
      { ref: leaseRef, deleted: true, expectedOid: leaseOid },
    ],
    true,
  );

  const remoteHead = await lsRemoteOid(git, remote, branchRef);

  if (remoteHead !== newBranchOid) {
    throw new Error(
      `finalize push reported success but ${branchRef} reads ${remoteHead ?? "absent"}, expected ${newBranchOid} — fail closed`,
    );
  }

  return `finalized ${branchRef} at ${newBranchOid.slice(0, 8)} and released ${leaseRef}`;
}

/** Conditionally release the exact owned lease after fresh
 *  verification (issue #390 step 10): re-observe, refuse to touch a
 *  ref that is not verbatim ours, delete fenced, verify absence. */
export async function releaseOwnLease(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly leaseRef: string;
  readonly ownOid: string;
}): Promise<string> {
  const { git, remote, leaseRef, ownOid } = options;
  const live = await lsRemoteOid(git, remote, leaseRef);

  if (live === undefined) {
    return `lease ${leaseRef} already absent`;
  }

  if (live !== ownOid) {
    throw new Error(
      `lease ${leaseRef} is no longer ours (${live.slice(0, 8)}, own ${ownOid.slice(0, 8)}) — not releasing`,
    );
  }

  await casPush(git, remote, [
    { ref: leaseRef, deleted: true, expectedOid: ownOid },
  ]);

  const after = await lsRemoteOid(git, remote, leaseRef);

  if (after !== undefined) {
    throw new Error(
      `lease ${leaseRef} still present after release — fail closed`,
    );
  }

  return `released ${leaseRef}`;
}

/** The remote branch's tree OID, from the explicit fetch the caller
 *  already performed (`FETCH_HEAD` names the fetched branch head). */
export async function fetchedTreeOid(
  git: GitRunner,
  refish = "FETCH_HEAD",
): Promise<string> {
  return await gitOut(git, ["rev-parse", "--verify", `${refish}^{tree}`]);
}
