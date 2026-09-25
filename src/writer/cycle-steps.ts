/**
 * One shared-writer cycle's precondition steps (issue #390), split
 * out of the coordinator so each stays readable: the dirty-tree
 * refusal (per-machine artifacts stay allowed state), the ingest
 * snapshot's canonical re-baseline after a bootstrap or
 * fast-forward, and the removal-receipt gate that refuses before any
 * `raw/` mutation until a human confirms the candidate set. All are
 * pure steps over an injected git runner — the coordinator owns the
 * order and the lease tenure.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import type { RunContext } from "../cli/run-context.ts";
import { readTextIfExists } from "../cli/shared.ts";
import { parseStatus, tryGit } from "../data/git.ts";
import { SNAPSHOT_FILENAME } from "../ingest/snapshot.ts";
import { parseManifest, writeManifest } from "../sync/manifest.ts";
import type { VaultRemovalPlan } from "../sync/projection.ts";
import type { GitRunner } from "./git-remote.ts";
import { releaseOwnLease } from "./lease-ops.ts";
import type { SharedWriterMarker } from "./marker.ts";
import type { SharedCycleOptions } from "./options.ts";
import {
  buildReceipt,
  describeReceipt,
  ensureReceiptIgnored,
  matchReceipt,
  type RemovalReceipt,
  writeReceipt,
} from "./receipts.ts";

/** Untracked per-machine artifacts the refusal ignores: the shared
 *  run lock lives at the data repo root, outside every commit
 *  pathspec, and is never repo content. */
const ALLOWED_UNTRACKED = new Set([".scheduled-run.lock"]);

/** The first five offending paths — enough to act on, not a wall. */
function listLimited(entries: readonly string[]): string {
  return entries
    .slice(0, 5)
    .map((entry) => JSON.stringify(entry))
    .join(", ");
}

/** Refuse a dirty working tree before any source scan (issue #390
 *  step 3): tracked modifications, staged changes, and untracked
 *  content all refuse — only the run lock is allowed state. Returns
 *  undefined when clean, the refusal reason otherwise. */
export async function refuseDirtyWorkingTree(
  git: GitRunner,
): Promise<string | undefined> {
  const { stdout } = await git(["status", "--porcelain"]);
  const offending = parseStatus(stdout)
    .map((entry) => entry.path)
    .filter((path) => !ALLOWED_UNTRACKED.has(path));

  return offending.length === 0
    ? undefined
    : `data repo is dirty — resolve before a shared cycle (no automatic merge/rebase/reset): ${listLimited(offending)}`;
}

/** The ingest snapshot's path for a data repo. */
export function snapshotPathFor(dataRoot: string): string {
  return join(dataRoot, "outputs", SNAPSHOT_FILENAME);
}

/** Re-baseline the ingest snapshot from the checked-out canonical
 *  `raw/manifest.json` (issue #390 step 7): after a bootstrap (no
 *  snapshot) or a successful remote fast-forward, the snapshot is
 *  rewritten stamped for this data root and anchored to the checked-
 *  out canonical commit — so a fresh clone does not re-ingest what
 *  another machine already processed, and a reset-away snapshot is
 *  never trusted. A cycle that starts from the current head keeps
 *  its snapshot (a failed cycle's retry semantics ride it). */
export async function baselineSnapshot(options: {
  readonly run: RunContext;
  readonly headOid: string;
  readonly fastForwarded: boolean;
}): Promise<void> {
  const { run, headOid, fastForwarded } = options;
  const path = snapshotPathFor(run.dataRoot);
  const existing = await readTextIfExists(path);

  if (existing !== undefined && !fastForwarded) {
    return;
  }

  const manifestText = await readTextIfExists(
    join(run.rawDir, "manifest.json"),
  );
  const manifest = parseManifest(manifestText ?? "{}\n", "raw/manifest.json");

  await mkdir(dirname(path), { recursive: true });
  await writeManifest(path, manifest, {
    snapshotFor: run.dataRoot,
    committedHead: headOid,
  });

  run.onProgress(
    `shared-writer: ${existing === undefined ? "bootstrapped" : "re-baselined"} the ingest snapshot from the canonical tree at ${headOid.slice(0, 8)}`,
  );
}

/** The gate's outcome: pass (matching receipt or nothing to remove)
 *  or refuse — the exact reason, with the receipt already written
 *  and the confirmation command named. */
export type RemovalGate =
  | { readonly status: "pass" }
  | { readonly status: "refuse"; readonly reason: readonly string[] };

/** Plan the candidate removal/rename set and hold the cycle against
 *  it (issue #390, source-vault removal safety): nothing to remove
 *  passes; a matching receipt passes; anything else writes the
 *  receipt, prints it, and refuses — before `raw/` was touched. */
export async function gateRemovals(options: {
  readonly run: RunContext;
  readonly base: string;
  readonly plans: readonly VaultRemovalPlan[];
  readonly receipt: RemovalReceipt | undefined;
}): Promise<RemovalGate> {
  const { run, base, plans, receipt } = options;
  const candidates = plans.filter(
    (plan) => plan.removals.length > 0 || plan.renames.length > 0,
  );

  if (candidates.length === 0) {
    return { status: "pass" };
  }

  const planned = buildReceipt(base, plans);

  if (receipt === undefined) {
    await ensureReceiptIgnored(run.dataRoot, run.onProgress);
    const path = await writeReceipt(run.dataRoot, planned);

    return {
      status: "refuse",
      reason: [
        `source removals/renames need a human confirmation receipt (receipt written: ${path}); a scheduled run must not expunge — confirm manually from any current Mac:`,
        ...describeReceipt(planned),
      ],
    };
  }

  const match = matchReceipt(receipt, base, plans);

  if (!match.ok) {
    await ensureReceiptIgnored(run.dataRoot, run.onProgress);
    await writeReceipt(run.dataRoot, planned);

    return {
      status: "refuse",
      reason: [
        `removal receipt rejected — ${match.reason}`,
        ...describeReceipt(planned),
      ],
    };
  }

  run.onProgress(
    "shared-writer: removal receipt verified against the canonical state — proceeding",
  );

  return { status: "pass" };
}

/** Whether git porcelain reports the working tree clean (tracked and
 *  untracked alike; the run lock is untracked-but-allowed, this
 *  check tolerates it for the post-failure release decision). */
export async function workingTreeClean(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const stdout = await tryGit(dataRoot, ["status", "--porcelain"], env);

  if (stdout === undefined) {
    return false;
  }

  return parseStatus(stdout).every((entry) =>
    ALLOWED_UNTRACKED.has(entry.path),
  );
}

/** The failure-rule decision (issue #390's table): a clean tree
 *  releases only the exact owned lease; a dirty fix surface retains
 *  it. A release failure is never allowed to mask the original
 *  error. */
export async function releaseIfClean(
  options: SharedCycleOptions,
  marker: SharedWriterMarker,
  git: GitRunner,
  ownOid: string,
): Promise<void> {
  const { run } = options;

  if (!(await workingTreeClean(run.dataRoot, run.env))) {
    run.onProgress(
      "shared-writer: failure left a dirty fix surface — retaining the lease until expiry or writer-lease takeover",
    );

    return;
  }

  try {
    run.onProgress(
      await releaseOwnLease({
        git,
        remote: marker.remote,
        leaseRef: marker.leaseRef,
        ownOid,
      }),
    );
  } catch (releaseError) {
    run.onProgress(
      `shared-writer: lease release failed — retained: ${errorMessage(releaseError)}`,
    );
  }
}
