/**
 * The failed-cycle fix surface's record (issue #400): one exact,
 * per-machine run record connects a retained remote lease to the
 * dirty paths its cycle left behind. The record lives under the data
 * repo's git dir (`<git-dir>/k-wiki/recovery-fix-surface.json`) —
 * invisible to status, commits, and cleans by construction, like
 * the lease's scratch ref. This module owns the record's schema,
 * persistence, and the live-surface comparison (path set plus
 * per-path content hashes) both recovery doors share; the recovery
 * executor and the coordinator's tick hook live in the sibling
 * `recovery.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "../cli/shared.ts";
import { surfaceEntries } from "./cycle-steps.ts";
import type { GitRunner } from "./git-remote.ts";
import { type ObservedLease, observeLease } from "./lease.ts";
import type { SharedWriterMarker } from "./marker.ts";

/** The lease identity a recovery retakes or defers to. */
export interface LeaseSnapshot {
  readonly ref: string;
  readonly oid: string;
  readonly holder: string;
  readonly expires: string;
}

/** The recorded fix surface of one failed cycle. */
export interface RecoveryRecord {
  readonly cycleId: string;
  readonly recordedAt: string;
  /** Every dirty path at failure time — targets and rename origins. */
  readonly paths: readonly string[];
  /** SHA-256 per recorded path ("absent" when gone), so a human
   *  re-edit of an already-recorded path is a mismatch too. */
  readonly hashes: Readonly<Record<string, string>>;
  /** The retained lease at recording time; null when none was live. */
  readonly lease: LeaseSnapshot | null;
  readonly refusedTicks: number;
  /** Set permanently when the live surface ever diverged from the
   *  record: auto-recovery never runs on a drifted surface. */
  readonly autoDisabled?: boolean;
}

/** The record's path under the data repo's git dir. */
export async function recoveryRecordPath(git: GitRunner): Promise<string> {
  const { stdout } = await git(["rev-parse", "--absolute-git-dir"]);

  return join(stdout.trim(), "k-wiki", "recovery-fix-surface.json");
}

/** Write the record atomically (tmp + rename): a torn write can
 *  never read as a recorded surface. */
export async function writeRecord(
  git: GitRunner,
  record: RecoveryRecord,
): Promise<void> {
  const path = await recoveryRecordPath(git);
  const temporary = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Read the record; undefined when none was recorded. A present but
 *  malformed record throws — fail closed, never recover blind. */
export async function readRecoveryRecord(
  git: GitRunner,
): Promise<RecoveryRecord | undefined> {
  let text: string;

  try {
    text = await readFile(await recoveryRecordPath(git), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  let parsed: RecoveryRecord;

  try {
    parsed = JSON.parse(text) as RecoveryRecord;
  } catch {
    throw new Error(
      "recovery fix-surface record is malformed — failing closed",
    );
  }

  const hashes = parsed.hashes ?? {};

  if (
    typeof parsed.cycleId !== "string" ||
    !Array.isArray(parsed.paths) ||
    parsed.paths.some((path) => typeof path !== "string") ||
    Object.values(hashes).some((hash) => typeof hash !== "string")
  ) {
    throw new Error(
      "recovery fix-surface record is malformed — failing closed",
    );
  }

  return { ...parsed, hashes };
}

/** Remove the record — the surface was recovered or resolved. */
export async function clearRecord(git: GitRunner): Promise<void> {
  await rm(await recoveryRecordPath(git), { force: true });
}

/** The recorded path set of a surface: entry paths plus rename
 *  origins, deduplicated and sorted. */
export function surfacePaths(
  entries: readonly { path: string; origin: string | undefined }[],
): string[] {
  const paths = new Set<string>();

  for (const entry of entries) {
    paths.add(entry.path);

    if (entry.origin !== undefined) {
      paths.add(entry.origin);
    }
  }

  return [...paths].sort();
}

/** A recorded path's disk bytes, undefined when the file is gone. */
async function repoFileBytes(
  git: GitRunner,
  path: string,
): Promise<Uint8Array | undefined> {
  const root = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();

  try {
    return new Uint8Array(await readFile(join(root, path)));
  } catch {
    return undefined;
  }
}

/** SHA-256 per recorded path ("absent" when gone) — the guardrails'
 *  hash discipline, so a human re-edit of a recorded path is caught. */
async function hashSurface(
  git: GitRunner,
  paths: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const hashes: Record<string, string> = {};

  for (const path of paths) {
    const bytes = await repoFileBytes(git, path);

    hashes[path] = bytes === undefined ? "absent" : sha256(bytes);
  }

  return hashes;
}

/** Record the current dirty surface as one failed cycle's fix
 *  surface, binding it to the lease now live on the remote. A clean
 *  tree records nothing (a clean-tree failure has no fix surface);
 *  an existing record is overwritten — the newest failure is the
 *  actionable one. */
export async function recordDirtyFailureSurface(options: {
  readonly git: GitRunner;
  readonly marker: SharedWriterMarker;
}): Promise<void> {
  const paths = surfacePaths(await surfaceEntries(options.git));

  if (paths.length === 0) {
    return;
  }

  const lease = await observeLease(
    options.git,
    options.marker.remote,
    options.marker.leaseRef,
  );

  await writeRecord(options.git, {
    cycleId: randomUUID(),
    recordedAt: new Date().toISOString(),
    paths,
    hashes: await hashSurface(options.git, paths),
    lease:
      lease === undefined
        ? null
        : {
            ref: options.marker.leaseRef,
            oid: lease.oid,
            holder: lease.body.holder,
            expires: lease.body.expires,
          },
    refusedTicks: 0,
  });
}

/** The live surface checked against the record: the live path set,
 *  the recorded paths that vanished, the ones a human re-edited, and
 *  the paths that appeared since the failure. */
export interface SurfaceEvaluation {
  readonly livePaths: readonly string[];
  readonly missing: readonly string[];
  readonly reedited: readonly string[];
  readonly added: readonly string[];
  readonly lease: ObservedLease | undefined;
}

/** Compare the live surface with the record: one status parse, one
 *  lease observation, per-path hashes over the recorded set. */
export async function evaluateSurface(options: {
  readonly git: GitRunner;
  readonly marker: SharedWriterMarker;
  readonly record: RecoveryRecord;
}): Promise<SurfaceEvaluation> {
  const livePaths = surfacePaths(await surfaceEntries(options.git));
  const recorded = new Set(options.record.paths);
  const live = new Set(livePaths);
  const missing = options.record.paths.filter((path) => !live.has(path));
  const added = livePaths.filter((path) => !recorded.has(path));
  const reedited: string[] = [];

  for (const [path, hash] of Object.entries(options.record.hashes)) {
    const bytes = await repoFileBytes(options.git, path);

    if (bytes !== undefined && sha256(bytes) !== hash) {
      reedited.push(path);
    }
  }

  const lease = await observeLease(
    options.git,
    options.marker.remote,
    options.marker.leaseRef,
  );

  return { livePaths, missing, reedited, added, lease };
}

/** Every path whose live state diverged from the record, sorted —
 *  the refusal names them. */
export function divergenceOf(evaluation: SurfaceEvaluation): string[] {
  return [...evaluation.missing, ...evaluation.reedited, ...evaluation.added]
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort();
}

/** The divergence refusal's one message, naming the differing paths. */
export function divergenceMessage(paths: readonly string[]): string {
  return `the live dirty set differs from the recorded fix surface (a human edit after the failure is never eaten): ${paths.join(", ")}`;
}
