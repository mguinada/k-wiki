/**
 * The leased tenure's cycle (issue #390): everything between holding
 * the remote lease and its finalization — the second fetch and
 * fast-forward-only advance, the ingest snapshot's canonical
 * re-baseline, the removal-receipt gate, the full-lint sweep, the
 * ordinary cycle with lease renewals at every agent-stage boundary,
 * and the fenced atomic finalize (or the no-op conditional release).
 * Split from the coordinator so the state machine and the tenure
 * each stay readable; the coordinator owns order and failure rules.
 */

import { nothingToDoLine, planRemovals, runWikiSync } from "../sync/wiki-sync.ts";
import {
  baselineSnapshot,
  gateRemovals,
  releaseIfClean,
} from "./cycle-steps.ts";
import type { GitRunner } from "./git-remote.ts";
import {
  classifyPosition,
  fetchRefspec,
  lsRemoteOid,
  mergeFfOnly,
  revParseOid,
} from "./git-remote.ts";
import type { ObservedLease } from "./lease.ts";
import {
  fetchedTreeOid,
  finalizeWithLeaseRelease,
  releaseOwnLease,
  renewLease,
} from "./lease-ops.ts";
import type { SharedWriterMarker } from "./marker.ts";
import type { SharedCycleOptions, SharedCycleOutcome } from "./options.ts";
import { readReceipt } from "./receipts.ts";

/** The cycle while leased. Returns normally on completion or a
 *  refused gate; throws on failures (the tenure's catch applies the
 *  failure rules). The `setSession` callback publishes each renewal
 *  to the tenure's failure-rule state; the phase callbacks mark when
 *  the run's mutation surface begins and when the finalize push
 *  starts. */
export async function leasedCycle(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
  branchRef: string,
  session: ObservedLease,
  setSession: (next: ObservedLease) => void,
  phaseToCycle: () => void,
  phaseToFinalize: () => void,
): Promise<SharedCycleOutcome> {
  const { run } = options;

  // The tenure's live lease: every renewal replaces it, and the
  // finalize fence quotes the latest OID.
  let current = session;

  // Step 6: fetch again while holding the lease; fast-forward only.
  const advanced = await fetchAndFastForward(marker, git, branchRef, run);

  // Step 7: the ingest snapshot's canonical re-baseline.
  await baselineSnapshot({
    run,
    headOid: advanced.headOid,
    fastForwarded: advanced.fastForwarded,
  });

  // The removal gate runs before any stage, while the tree is still
  // exactly the canonical checkout: nothing has mutated yet.
  const gate = await gateRemovalsForCycle(options, advanced.headOid);

  if (gate.status === "refuse") {
    // A clean pre-write refusal: release only the exact owned lease.
    await releaseIfClean(options, marker, git, current.oid);

    return { status: "refused", reason: gate.reason.join("\n") };
  }

  const renew = makeRenewer(
    options,
    marker,
    git,
    holder,
    advanced,
    () => current,
    (next) => {
      current = next;
      setSession(next);
    },
  );

  await renew("before the stages");

  if (options.runSweep !== undefined) {
    phaseToCycle();
    run.onProgress(
      "shared-writer: running the full-lint sweep inside the lease tenure",
    );
    await options.runSweep();
    await renew("after the sweep");
  }

  phaseToCycle();

  // Step 8: the ordinary cycle — same stages, same guardrails — with
  // lease renewals at every agent-stage boundary. The cycle skips
  // its own lock acquisition: the coordinator holds the tenure.
  const result = await runWikiSync({
    configPath: options.configPath,
    config: options.config,
    run: { ...run, env: { ...run.env, KWIKI_RUN_LOCK_HELD: "1" } },
    settingsPath: options.settingsPath,
    outputsDir: options.outputsDir,
    promptsDir: options.promptsDir,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    ...(options.runAgent !== undefined && { runAgent: options.runAgent }),
    deferIngestSnapshot: true,
    onAgentBoundary: async () => {
      await renew("an agent stage");
    },
  });

  // Step 10: a no-op cycle conditionally releases the exact owned
  // lease after fresh verification.
  if (nothingToDoLine(result) !== undefined) {
    run.onProgress(
      await releaseOwnLease({
        git,
        remote: marker.remote,
        leaseRef: marker.leaseRef,
        ownOid: current.oid,
      }),
    );

    return { status: "completed", result };
  }

  // Step 9: the fenced atomic finalize — branch advance plus exact
  // lease delete, verified remotely.
  phaseToFinalize();
  await renew("before finalization");

  const newHead = await requireHeadOid(git);

  await finalizeOrRecover(options, marker, git, newHead, current.oid);

  return { status: "completed", result };
}

/** Step 6's fetch-and-fast-forward: behind fast-forwards, up-to-date
 *  stands; ahead or diverged (a non-fast-forward remote move under
 *  the lease — a foreign write) fails closed. */
async function fetchAndFastForward(
  marker: SharedWriterMarker,
  git: GitRunner,
  branchRef: string,
  run: SharedCycleOptions["run"],
): Promise<{ readonly headOid: string; readonly fastForwarded: boolean }> {
  await fetchRefspec(git, marker.remote, `refs/heads/${marker.branch}`);

  const remoteOid = await lsRemoteOid(git, marker.remote, branchRef);

  if (remoteOid === undefined) {
    throw new Error(
      `remote ${marker.remote} lost ${branchRef} while the lease was held — fail closed`,
    );
  }

  const position = await classifyPosition(git, remoteOid);

  if (position === "ahead" || position === "diverged") {
    throw new Error(
      `remote ${branchRef} is not a descendant of the local head — fail closed (position: ${position})`,
    );
  }

  if (position === "behind") {
    await mergeFfOnly(git, "FETCH_HEAD");
    run.onProgress(
      `shared-writer: fast-forwarded to the canonical tree ${remoteOid.slice(0, 8)}`,
    );
  }

  const head = await revParseOid(git, "HEAD");

  if (head === undefined) {
    throw new Error("internal: the data repo has no HEAD");
  }

  return { headOid: head, fastForwarded: position === "behind" };
}

/** The gate over the planned candidate removal/rename set, keyed on
 *  the canonical head the lease is held under (every source kind:
 *  per-note removals and renames for vault configs, stale-namespace
 *  expunges for both). */
async function gateRemovalsForCycle(
  options: SharedCycleOptions,
  headOid: string,
): Promise<
  | { readonly status: "pass" }
  | { readonly status: "refuse"; readonly reason: readonly string[] }
> {
  const { run, config } = options;

  const plans = await planRemovals(config, {
    configPath: options.configPath,
    config,
    rawDir: run.rawDir,
    env: run.env,
    onProgress: (progress) => run.onProgress(progress.text),
  });

  if (options.removalReceiptPath === undefined && plans.every(isEmptyPlan)) {
    return { status: "pass" };
  }

  const receipt =
    options.removalReceiptPath === undefined
      ? undefined
      : await readReceipt(options.removalReceiptPath);

  return await gateRemovals({
    run,
    base: headOid,
    plans,
    receipt,
  });
}

/** One vault plan with nothing to confirm. */
function isEmptyPlan(plan: {
  readonly removals: readonly unknown[];
  readonly renames: readonly unknown[];
}): boolean {
  return plan.removals.length === 0 && plan.renames.length === 0;
}

/** A renewal step: same token, new expiry, renewals+1, exact-OID
 *  fence — a lost race aborts before the next stage or the final
 *  push (issue #390's failure table). `getSession` reads the
 *  tenure's live session; `setSession` publishes each renewal. */
function makeRenewer(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
  advanced: { readonly headOid: string },
  getSession: () => ObservedLease,
  setSession: (next: ObservedLease) => void,
): (when: string) => Promise<void> {
  const { run } = options;

  return async (when: string) => {
    const treeOid = await fetchedTreeOid(git);
    const next = await renewLease({
      git,
      remote: marker.remote,
      leaseRef: marker.leaseRef,
      current: getSession(),
      treeOid,
      base: advanced.headOid,
      now: run.now,
      holder,
    });

    setSession(next);
    run.onProgress(
      `shared-writer: lease renewed ${when} (${next.body.renewals})`,
    );
  };
}

/** The local head OID — the finalize push's source. */
async function requireHeadOid(git: GitRunner): Promise<string> {
  const oid = await revParseOid(git, "HEAD");

  if (oid === undefined) {
    throw new Error("internal: the data repo has no HEAD");
  }

  return oid;
}

/** Step 9 with the ambiguous-push recovery: when the atomic push's
 *  outcome is uncertain, fetch and recognize success only when the
 *  expected branch head is remote and the owned lease is absent —
 *  otherwise retain and fail closed. */
async function finalizeOrRecover(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  newHead: string,
  leaseOid: string,
): Promise<void> {
  const { run } = options;

  try {
    run.onProgress(
      await finalizeWithLeaseRelease({
        git,
        remote: marker.remote,
        branchRef: `refs/heads/${marker.branch}`,
        leaseRef: marker.leaseRef,
        newBranchOid: newHead,
        leaseOid,
      }),
    );
  } catch (error) {
    const remoteHead = await lsRemoteOid(
      git,
      marker.remote,
      `refs/heads/${marker.branch}`,
    );
    const lease = await lsRemoteOid(git, marker.remote, marker.leaseRef);

    if (remoteHead === newHead && lease === undefined) {
      run.onProgress(
        "shared-writer: the finalize push's report was lost — the remote verifies as finalized",
      );

      return;
    }

    throw error;
  }
}
