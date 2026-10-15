/**
 * The failure-rule lease retention and conditional release (issue
 * #390): a clean-tree failure releases only the exact owned lease; a
 * dirty fix surface retains it — a bounded availability pause, never
 * a guess. Split from the cycle-step module so each stays readable;
 * the retention's canonical-tree read degrades per issue #464, so a
 * retention can never fail for read reasons.
 */

import { errorMessage, terminalColors } from "../cli/colors.ts";
import type { RunContext } from "../cli/run-context.ts";
import { workingTreeClean } from "./cycle-steps.ts";
import type { GitRunner } from "./git-remote.ts";
import type { ObservedLease } from "./lease.ts";
import {
  fetchedTreeOid,
  releaseOwnLease,
  retainFailedCycleLease,
} from "./lease-ops.ts";
import { reportMaintenance } from "./maintenance-log.ts";
import { canonicalRefFor, type SharedWriterMarker } from "./marker.ts";
import type { KnownTree, SharedCycleOptions } from "./options.ts";

/** The failure-rule decision (issue #390's table): a clean tree
 *  releases only the exact owned lease; a dirty fix surface retains
 *  it. A release failure is never allowed to mask the original
 *  error. */
export async function releaseIfClean(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  current: ObservedLease,
  tree: KnownTree,
): Promise<void> {
  const { run } = options;

  if (!(await workingTreeClean(run.dataRoot, run.env))) {
    await retainAfterFailure({
      run,
      marker,
      git,
      current,
      tree,
      label: "failure left a dirty fix surface",
    });

    return;
  }

  const startedAt = performance.now();

  try {
    run.onProgress(
      await releaseOwnLease({
        git,
        remote: marker.remote,
        leaseRef: marker.leaseRef,
        ownOid: current.oid,
      }),
    );
    await reportMaintenance(git, {
      onProgress: run.onProgress,
      dim: (message) => terminalColors(run.env).dim(message),
      obs: {
        verb: "release",
        ref: marker.leaseRef,
        oid: current.oid,
        treeRead: "ok",
        durationMs: performance.now() - startedAt,
      },
    });
  } catch (releaseError) {
    run.onProgress(
      `shared-writer: lease release failed — retained: ${errorMessage(releaseError)}`,
    );
  }
}

/** Retention's canonical-tree read (issue #464), best effort: the
 *  canonical ref when resolvable, else the last-known tree the
 *  tenure held. Success never throws; the caller only sees the
 *  degraded verdict when the read had to fall back. */
async function retentionTree(
  git: GitRunner,
  marker: SharedWriterMarker,
  fallback: string | undefined,
): Promise<{ treeOid: string | undefined; degraded: boolean }> {
  try {
    return {
      treeOid: await fetchedTreeOid(git, canonicalRefFor(marker.leaseRef)),
      degraded: false,
    };
  } catch {
    return { treeOid: fallback, degraded: true };
  }
}

/** The failure-rule retention step, shared by the coordinator's
 *  finalize-phase catch and the dirty-tree refusal retention (issue
 *  #390). The tree read degrades (issue #464): on failure the lease
 *  is retained on the last-known canonical tree and the skip is
 *  logged — retention can never fail from a tree read, so the
 *  "failed to shorten" path stays unreachable for read reasons and
 *  the original stage error alone surfaces. Only a push failure
 *  prints the shorten-failed warning. */
export async function retainAfterFailure(options: {
  readonly run: RunContext;
  readonly marker: SharedWriterMarker;
  readonly git: GitRunner;
  readonly current: ObservedLease;
  readonly tree: KnownTree;
  /** The progress phrase naming where the retention comes from. */
  readonly label: string;
}): Promise<void> {
  const { run, marker, git, current, tree, label } = options;
  const startedAt = performance.now();
  const read = await retentionTree(git, marker, tree.get());

  if (read.treeOid === undefined) {
    run.onProgress(
      `shared-writer: ${label} — canonical tree unavailable, skipping lease retention`,
    );

    return;
  }

  try {
    const retained = await retainFailedCycleLease({
      git,
      remote: marker.remote,
      leaseRef: marker.leaseRef,
      current,
      treeOid: read.treeOid,
      now: run.now,
    });

    await reportMaintenance(git, {
      onProgress: run.onProgress,
      dim: (message) => terminalColors(run.env).dim(message),
      obs: {
        verb: "retain",
        ref: marker.leaseRef,
        oid: current.oid,
        treeRead: read.degraded ? "degraded" : "ok",
        durationMs: performance.now() - startedAt,
      },
    });
    run.onProgress(
      `shared-writer: ${label} — retained lease expires ${retained.body.expires}`,
    );
  } catch (retentionError) {
    run.onProgress(
      `shared-writer: failed to shorten retained lease — ${errorMessage(retentionError)}`,
    );
  }
}
