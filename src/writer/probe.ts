/**
 * The remote capability probe (issue #390): `enable-shared-writer`
 * must prove the configured remote accepts custom refs under
 * `refs/k-wiki/` and the conditional atomic finalization the lease
 * protocol needs — before any marker is written. The probe runs the
 * protocol's real lifecycle against uniquely named disposable probe
 * refs: a compare-and-swap create, a compare-and-swap replace by
 * exact OID, then the atomic update of a disposable probe ref while
 * deleting the exact probe lease. Every step verifies its remote
 * state; an unsupported capability refuses enablement with no
 * marker; uncertain cleanup names the exact retained ref and fails
 * loud. Nothing here assumes a host — the actual configured remote
 * is the subject under test.
 */

import { randomBytes } from "node:crypto";
import { terminalColors } from "../cli/colors.ts";
import { type GitRunner, gitRun, lsRemoteOid } from "./git-remote.ts";
import { casPush, createLeaseCommit, newLeaseBody } from "./lease.ts";

/** The outcome of one probe run: pass/fail plus the recorded result
 *  lines (the live evidence the enable output and the two-Mac
 *  acceptance script carry). */
export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: readonly string[];
  /** Probe refs the remote may still hold — cleanup could not be
   *  proven; the operator must delete them by hand. */
  readonly retained: readonly string[];
}

/** The probe ref names for one run: unique per attempt, so a
 *  concurrent enable or a stale previous probe can never collide. */
function probeRefs(): { lease: string; head: string } {
  const suffix = randomBytes(4).toString("hex");

  return {
    lease: `refs/k-wiki/probe/lease-${suffix}`,
    head: `refs/k-wiki/probe/head-${suffix}`,
  };
}

/** Verify the remote reports exactly the expected OID for a ref;
 *  undefined expectations demand absence. */
async function expectRemoteOid(
  git: GitRunner,
  remote: string,
  ref: string,
  expected: string | undefined,
): Promise<boolean> {
  return (await lsRemoteOid(git, remote, ref)) === expected;
}

/** Delete one probe ref best-effort; return whether the remote is
 *  verifiably clean of it afterwards. */
async function cleanupProbeRef(
  git: GitRunner,
  remote: string,
  ref: string,
  expectedOid: string | undefined,
): Promise<boolean> {
  try {
    if (expectedOid === undefined) {
      await gitRun(git, ["push", remote, `:${ref}`]);
    } else {
      await casPush(git, remote, [{ ref, deleted: true, expectedOid }]);
    }
  } catch {
    // Fall through to the verification: the delete may have landed
    // despite a noisy failure.
  }

  return await expectRemoteOid(git, remote, ref, undefined);
}

/**
 * Run the full probe lifecycle against `remote`. `treeOid` seeds the
 * synthetic probe commits (the fetched branch tree, as the real
 * lease would use). Throws only on unexpected local failures —
 * capability gaps are results, not errors.
 */
export async function probeRemoteCapabilities(options: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly treeOid: string;
  readonly now: () => Date;
  readonly holder: string;
  readonly onProgress: (message: string) => void;
}): Promise<ProbeResult> {
  const { git, remote, treeOid, now, holder, onProgress } = options;
  const refs = probeRefs();
  const detail: string[] = [];
  const retained: string[] = [];
  const first = newLeaseBody(treeOid, now, holder);
  const firstOid = await createLeaseCommit(git, treeOid, first);

  // 1. Compare-and-swap create of the absent probe lease.
  try {
    await casPush(git, remote, [{ ref: refs.lease, oid: firstOid }]);
  } catch (error) {
    return {
      ok: false,
      detail: [
        ...detail,
        `custom-ref create refused — ${String((error as Error).message).slice(0, 200)}`,
      ],
      retained: [],
    };
  }

  if (!(await expectRemoteOid(git, remote, refs.lease, firstOid))) {
    retained.push(refs.lease);
    return {
      ok: false,
      detail: [...detail, "custom-ref create did not verify"],
      retained,
    };
  }

  detail.push(`probe lease created at ${refs.lease}`);

  // 2. Compare-and-swap replace by exact old OID.
  const secondOid = await createLeaseCommit(
    git,
    treeOid,
    newLeaseBody(treeOid, now, holder),
  );

  try {
    await casPush(git, remote, [
      { ref: refs.lease, oid: secondOid, expectedOid: firstOid },
    ]);
  } catch (error) {
    retained.push(...(await cleanupOutcome(git, remote, refs, firstOid)));
    return {
      ok: false,
      detail: [
        ...detail,
        `exact-OID replace refused — ${String((error as Error).message).slice(0, 200)}`,
      ],
      retained,
    };
  }

  if (!(await expectRemoteOid(git, remote, refs.lease, secondOid))) {
    retained.push(...(await cleanupOutcome(git, remote, refs, secondOid)));
    return {
      ok: false,
      detail: [...detail, "exact-OID replace did not verify"],
      retained,
    };
  }

  detail.push("probe lease replaced by exact OID");

  // 3. The atomic finalize shape: update the disposable probe ref
  //    while deleting the exact fenced lease, one atomic push.
  try {
    await casPush(
      git,
      remote,
      [
        { ref: refs.head, oid: secondOid },
        { ref: refs.lease, deleted: true, expectedOid: secondOid },
      ],
      true,
    );
  } catch (error) {
    retained.push(...(await cleanupOutcome(git, remote, refs, secondOid)));
    return {
      ok: false,
      detail: [
        ...detail,
        `atomic finalize refused — ${String((error as Error).message).slice(0, 200)}`,
      ],
      retained,
    };
  }

  const atomicVerified =
    (await expectRemoteOid(git, remote, refs.head, secondOid)) &&
    (await expectRemoteOid(git, remote, refs.lease, undefined));

  if (!atomicVerified) {
    retained.push(...(await cleanupOutcome(git, remote, refs, secondOid)));
    return {
      ok: false,
      detail: [...detail, "atomic finalize did not verify"],
      retained,
    };
  }

  detail.push("atomic finalize verified (ref update + fenced delete)");

  // 4. Verified: scrub both disposable refs. A ref that survives
  //    scrubbing is named for manual deletion — never silent.
  for (const [ref, oid] of [
    [refs.head, secondOid],
    [refs.lease, undefined],
  ] as const) {
    if (!(await cleanupProbeRef(git, remote, ref, oid))) {
      retained.push(ref);
    }
  }

  onProgress(
    `shared-writer: probe refs ${refs.lease}, ${refs.head} verified and removed`,
  );

  return { ok: true, detail, retained };
}

/** Best-effort scrub of both probe refs after a failed step; refs
 *  that survive scrubbing are reported for manual deletion. */
async function cleanupOutcome(
  git: GitRunner,
  remote: string,
  refs: { lease: string; head: string },
  leaseOid: string,
): Promise<string[]> {
  const retained: string[] = [];
  const headOid = await lsRemoteOid(git, remote, refs.head);

  if (!(await cleanupProbeRef(git, remote, refs.head, headOid))) {
    retained.push(refs.head);
  }

  if (!(await cleanupProbeRef(git, remote, refs.lease, leaseOid))) {
    retained.push(refs.lease);
  }

  return retained;
}

/** Echo a probe result for the operator's transcript: the recorded
 *  step lines dim, any retained probe refs as loud warnings. */
export function reportProbe(probe: ProbeResult): void {
  const dim = terminalColors().dim;

  for (const line of probe.detail) {
    console.error(dim(`enable-shared-writer: ${line}`));
  }

  for (const ref of probe.retained) {
    console.error(
      terminalColors().yellow(
        `enable-shared-writer: WARNING — probe ref ${ref} could not be verified removed; delete it by hand`,
      ),
    );
  }
}
