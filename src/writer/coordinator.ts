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

import { errorMessage } from "../cli/colors.ts";
import type { RunContext } from "../cli/run-context.ts";
import { acquireCycleLock } from "../sync/wiki-sync.ts";
import type { GitRunner } from "./git-remote.ts";
import { gitRunnerFor } from "./git-remote.ts";
import { describeLease, leaseHolder, type ObservedLease } from "./lease.ts";
import { leasedCycle } from "./leased-cycle.ts";
import { readSharedWriterMarker, type SharedWriterMarker } from "./marker.ts";
import type {
  KnownTree,
  Phase,
  SharedCycleOptions,
  SharedCycleOutcome,
} from "./options.ts";
import { recordDirtyFailureSurface } from "./recovery-record.ts";
import { releaseIfClean, retainAfterFailure } from "./retention.ts";
import { acquireOrTakeOver, preconditionRefusal } from "./tenure.ts";

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
 *  failure rules in the catch; the last-known canonical tree rides
 *  alongside the session for the retention fallback (issue #464). */
async function runTenure(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  holder: string,
): Promise<SharedCycleOutcome> {
  const { run } = options;
  const branchRef = `refs/heads/${marker.branch}`;
  const ctl: { phase: Phase } = { phase: "prepare" };
  const treeOid: { value: string | undefined } = { value: undefined };
  const tree: KnownTree = {
    get: () => treeOid.value,
    set: (next) => {
      treeOid.value = next;
    },
  };
  let session: ObservedLease | undefined;

  try {
    const refused = await preconditionRefusal(
      options,
      marker,
      git,
      branchRef,
      holder,
    );

    if (refused !== undefined) {
      return { status: "refused", reason: refused };
    }

    session = await acquireOrTakeOver(
      options,
      marker,
      git,
      holder,
      branchRef,
      tree,
    );

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
      tree,
      () => {
        ctl.phase = "cycle";
      },
      () => {
        ctl.phase = "finalize";
      },
    );
  } catch (error) {
    if (session !== undefined) {
      if (!isFinalizePhase(ctl)) {
        await releaseIfClean(options, marker, git, session, tree);

        // The dirty fix surface, recorded while it is fresh (issue
        // #400): the recovery doors — human verb and auto-recovery —
        // operate on exactly this record. A clean-tree failure
        // records nothing, and a recording failure never masks the
        // cycle's own error.
        try {
          await recordDirtyFailureSurface({ git, marker });
        } catch (recordError) {
          run.onProgress(
            `shared-writer: failed to record the fix surface — ${errorMessage(recordError)}`,
          );
        }
      } else {
        // Retention is best effort (issue #464): the tree read falls
        // back to the last-known canonical tree, so it can never fail
        // for read reasons; the original stage error stays the thrown
        // error.
        await retainAfterFailure({
          run,
          marker,
          git,
          current: session,
          tree,
          label: "cycle failed during finalization",
        });
      }
    }

    throw error;
  }
}

/** Read through a helper so control-flow narrowing cannot fold the
 *  callback-driven phase mutations away. */
function isFinalizePhase(ctl: { readonly phase: Phase }): boolean {
  return ctl.phase === "finalize";
}
