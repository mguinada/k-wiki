/**
 * The leased tenure's precondition and acquisition steps (issue
 * #390), split out of the coordinator so the state machine and the
 * steps each stay readable: the fetch into the canonical named ref
 * (issue #464), the wrong-branch/dirty/ahead/diverged refusals —
 * all before any source scan, agent invocation, or `raw/` mutation —
 * and step 5's acquire-or-take-over with the last-known tree
 * publication. The coordinator owns the order.
 */

import { terminalColors } from "../cli/colors.ts";
import { refuseDirtyWorkingTree } from "./cycle-steps.ts";
import {
  classifyPosition,
  currentBranch,
  fetchCanonicalBranch,
  type GitRunner,
  lsRemoteOid,
} from "./git-remote.ts";
import {
  describeLease,
  leaseExpired,
  type ObservedLease,
  observeLease,
} from "./lease.ts";
import {
  acquireLease,
  fetchedTreeOid,
  renewLease,
  takeOverExpiredLease,
} from "./lease-ops.ts";
import { reportMaintenance } from "./maintenance-log.ts";
import { canonicalRefFor, type SharedWriterMarker } from "./marker.ts";
import type { KnownTree, SharedCycleOptions } from "./options.ts";
import { noteRefusedTick } from "./recovery.ts";

/** Steps 2–4 of the state machine, in order: fetch, refuse a wrong
 *  checkout, refuse a dirty tree, refuse ahead/diverged history —
 *  all before any source scan, agent invocation, or `raw/` mutation.
 *  Undefined means every precondition holds. */
export async function preconditionRefusal(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  branchRef: string,
  holder: string,
): Promise<string | undefined> {
  const { run } = options;

  await fetchCanonicalBranch(
    git,
    marker.remote,
    branchRef,
    canonicalRefFor(marker.leaseRef),
  );

  const checkedOut = await currentBranch(git);

  if (checkedOut !== marker.branch) {
    return `shared-writer mode runs on ${marker.branch} — this checkout is on ${checkedOut ?? "a detached HEAD"}`;
  }

  // The issue #400 auto-recovery door: count this tick against the
  // recorded surface and, past the threshold with the lease lapsed,
  // discard it — the dirty refusal below then passes and the cycle
  // proceeds as usual. With nothing recorded this is one file read.
  const recovered = await noteRefusedTick({
    git,
    marker,
    now: run.now,
    holder,
    log: run.onProgress,
  });

  if (recovered) {
    run.onProgress(
      "shared-writer: auto-recovery discarded the recorded fix surface — proceeding",
    );
  }

  const dirty = await refuseDirtyWorkingTree(git);

  if (dirty !== undefined) {
    return dirty;
  }

  const remoteOid = await lsRemoteOid(git, marker.remote, branchRef);

  if (remoteOid === undefined) {
    return `remote ${marker.remote} has no ${branchRef} — nothing canonical to fast-forward to`;
  }

  const position = await classifyPosition(git, remoteOid);

  if (position === "ahead") {
    return "local history is ahead of the remote — a shared writer never pushes unshared commits; resolve manually";
  }

  if (position === "diverged") {
    return "local history has diverged from the remote — a shared writer never merges or rebases derived wiki content; resolve manually";
  }

  run.onProgress("shared-writer: preconditions hold (clean, current branch)");

  return undefined;
}

/** Step 5: acquire the absent lease, or take over an expired one by
 *  exact OID. A live lease refuses with holder and expiry; an
 *  unparseable one throws before anything mutates (fail closed). The
 *  baseline tree read anchors on the canonical ref the precondition
 *  fetched (issue #464) and publishes to the tenure's last-known
 *  tree. */
export async function acquireOrTakeOver(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
  branchRef: string,
  tree: KnownTree,
): Promise<ObservedLease> {
  const { run } = options;
  const observed = await observeLease(git, marker.remote, marker.leaseRef);

  if (observed !== undefined && !leaseExpired(observed.body, run.now)) {
    throw new Error(
      `shared-writer lease is live — ${describeLease(observed)}; a writer never touches raw/ or wiki/ under another writer's lease`,
    );
  }

  const startedAt = performance.now();
  const treeOid = await fetchedTreeOid(git, canonicalRefFor(marker.leaseRef));
  tree.set(treeOid);
  const base = await requireBaseOid(git, marker, branchRef);
  const outcome =
    observed === undefined
      ? await acquireLease({
          git,
          remote: marker.remote,
          leaseRef: marker.leaseRef,
          treeOid,
          base,
          now: run.now,
          holder,
        })
      : await takeOverExpiredLease({
          git,
          remote: marker.remote,
          leaseRef: marker.leaseRef,
          observed,
          treeOid,
          base,
          now: run.now,
          holder,
        });

  if (outcome.status === "refused") {
    throw new Error(`shared-writer lease unavailable — ${outcome.reason}`);
  }

  if (observed !== undefined) {
    await reportMaintenance(git, {
      onProgress: run.onProgress,
      dim: (message) => terminalColors(run.env).dim(message),
      obs: {
        verb: "take-over",
        ref: marker.leaseRef,
        oid: observed.oid,
        treeRead: "ok",
        durationMs: performance.now() - startedAt,
      },
    });
    run.onProgress(
      `shared-writer: took over the expired lease of ${observed.body.holder}`,
    );
  }

  return outcome.lease;
}

/** The remote branch OID, observed live — the lease's base. */
async function requireBaseOid(
  git: GitRunner,
  marker: SharedWriterMarker,
  branchRef: string,
): Promise<string> {
  const oid = await lsRemoteOid(git, marker.remote, branchRef);

  if (oid === undefined) {
    throw new Error(
      `remote ${marker.remote} lost ${branchRef} while the cycle started — fail closed`,
    );
  }

  return oid;
}

/** A renewal step: same token, new expiry, renewals+1, exact-OID
 *  fence — a lost race aborts before the next stage or the final
 *  push (issue #390's failure table). `getSession` reads the
 *  tenure's live session; `setSession` publishes each renewal. The
 *  tree read anchors on the canonical ref this path fetched (issue
 *  #464) and refreshes the tenure's last-known tree. */
export function makeRenewer(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
  advanced: { readonly headOid: string },
  tree: KnownTree,
  getSession: () => ObservedLease,
  setSession: (next: ObservedLease) => void,
): (when: string) => Promise<void> {
  const { run } = options;

  return async (when: string) => {
    const startedAt = performance.now();
    const treeOid = await fetchedTreeOid(git, canonicalRefFor(marker.leaseRef));
    tree.set(treeOid);
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
    await reportMaintenance(git, {
      onProgress: run.onProgress,
      dim: (message) => terminalColors(run.env).dim(message),
      obs: {
        verb: "renew",
        ref: marker.leaseRef,
        oid: next.oid,
        treeRead: "ok",
        durationMs: performance.now() - startedAt,
      },
    });
    run.onProgress(
      `shared-writer: lease renewed ${when} (${next.body.renewals})`,
    );
  };
}
