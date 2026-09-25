/**
 * The shared-writer coordinator (issue #390): one state machine every
 * marker-enabled data repo runs — manual `wiki-sync` and
 * `scheduled-run` alike — serializing through the remote lease and
 * never auto-merging, rebasing, or resetting derived wiki content.
 *
 *   local run lock → fetch → refuse wrong branch/dirty/ahead/diverged
 *   → acquire (or expire-take-over) the lease → the leased tenure
 *   (leased-cycle.ts) → atomic finalize or conditional release.
 *
 * Failure rules (issue #390's table): a clean-tree failure releases
 * only the exact owned lease; a dirty fix surface or a finalize-push
 * failure retains it — a bounded availability pause, never a guess.
 */

import type { RunContext } from "../cli/run-context.ts";
import { acquireCycleLock } from "../sync/wiki-sync.ts";
import { refuseDirtyWorkingTree, releaseIfClean } from "./cycle-steps.ts";
import {
  classifyPosition,
  currentBranch,
  fetchRefspec,
  type GitRunner,
  gitRunnerFor,
  lsRemoteOid,
} from "./git-remote.ts";
import {
  describeLease,
  leaseExpired,
  leaseHolder,
  type ObservedLease,
  observeLease,
} from "./lease.ts";
import {
  acquireLease,
  fetchedTreeOid,
  takeOverExpiredLease,
} from "./lease-ops.ts";
import { leasedCycle } from "./leased-cycle.ts";
import { readSharedWriterMarker, type SharedWriterMarker } from "./marker.ts";
import type {
  Phase,
  SharedCycleOptions,
  SharedCycleOutcome,
} from "./options.ts";

/** The whole state machine. Unexpected internal failures throw after
 *  the failure-rule lease decision; precondition failures come back
 *  as `refused`. */
export async function runSharedCycle(
  options: SharedCycleOptions,
): Promise<SharedCycleOutcome> {
  const { run } = options;
  const marker = await readMarkerOrFail(run);
  const git = options.git ?? gitRunnerFor({ dir: run.dataRoot, env: run.env });
  const holder = options.holder ?? leaseHolder();
  const release = await acquireCycleLock(run);

  try {
    return await runTenure(options, marker, git, holder);
  } finally {
    await release();
  }
}

/** The marker read with its fail-closed verdict: invalid refuses the
 *  run before any source scan (issue #390's failure table); absent
 *  is a caller bug — the CLI dispatches on the marker first. */
async function readMarkerOrFail(run: RunContext): Promise<SharedWriterMarker> {
  const read = await readSharedWriterMarker(run.dataRoot);

  if (read.kind === "invalid") {
    throw new Error(
      `shared-writer marker is invalid — failing closed before source scan: ${read.reason}`,
    );
  }

  if (read.kind !== "enabled") {
    throw new Error(
      "shared-writer marker absent — run enable-shared-writer first",
    );
  }

  return read.marker;
}

/** The leased tenure: everything between the local lock and its
 *  release. The phase controller and the live session drive the
 *  failure rules in the catch. */
async function runTenure(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
): Promise<SharedCycleOutcome> {
  const { run } = options;
  const branchRef = `refs/heads/${marker.branch}`;
  const ctl: { phase: Phase } = { phase: "prepare" };
  let session: ObservedLease | undefined;

  try {
    const refused = await preconditionRefusal(options, marker, git, branchRef);

    if (refused !== undefined) {
      return { status: "refused", reason: refused };
    }

    session = await acquireOrTakeOver(options, marker, git, holder, branchRef);

    run.onProgress(
      `shared-writer: lease ${session.oid.slice(0, 8)} acquired — ${describeLease(session)}`,
    );

    return await leasedCycle(
      options,
      marker,
      git,
      holder,
      branchRef,
      session,
      (next) => {
        session = next;
      },
      () => {
        ctl.phase = "cycle";
      },
      () => {
        ctl.phase = "finalize";
      },
    );
  } catch (error) {
    if (!isFinalizePhase(ctl) && session !== undefined) {
      await releaseIfClean(options, marker, git, session.oid);
    }

    throw error;
  }
}

/** Read through a helper so control-flow narrowing cannot fold the
 *  callback-driven phase mutations away. */
function isFinalizePhase(ctl: { readonly phase: Phase }): boolean {
  return ctl.phase === "finalize";
}

/** Steps 2–4 of the state machine, in order: fetch, refuse a wrong
 *  checkout, refuse a dirty tree, refuse ahead/diverged history —
 *  all before any source scan, agent invocation, or `raw/` mutation.
 *  Undefined means every precondition holds. */
async function preconditionRefusal(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  branchRef: string,
): Promise<string | undefined> {
  const { run } = options;

  await fetchRefspec(git, marker.remote, `refs/heads/${marker.branch}`);

  const checkedOut = await currentBranch(git);

  if (checkedOut !== marker.branch) {
    return `shared-writer mode runs on ${marker.branch} — this checkout is on ${checkedOut ?? "a detached HEAD"}`;
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
 *  unparseable one throws before anything mutates (fail closed). */
async function acquireOrTakeOver(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
  branchRef: string,
): Promise<ObservedLease> {
  const { run } = options;
  const observed = await observeLease(git, marker.remote, marker.leaseRef);

  if (observed !== undefined && !leaseExpired(observed.body, run.now)) {
    throw new Error(
      `shared-writer lease is live — ${describeLease(observed)}; a writer never touches raw/ or wiki/ under another writer's lease`,
    );
  }

  const treeOid = await fetchedTreeOid(git);
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
