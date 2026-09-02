import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared runtime helpers: generic primitives with no domain of their
 * own, imported across module boundaries. They live in the cli
 * directory — the repo's shared layer, whose edges the campaign's
 * cross-domain counter deliberately exempts — as the refactor
 * campaign's helper home (epic #242); the fs micro-helper
 * consolidation lands here too.
 */

/** This repository's root, derived from this module's own location.
 *  Every src/ module sits exactly two levels below it (src/<area>/),
 *  so the one derivation serves every default path that anchors at
 *  the repo root (issue #255, dedup D-14). */
export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** The path's stats, or undefined when the stat fails (missing path,
 *  a parent that is a regular file, no permission). The one stat
 *  predicate — existence and type checks derive from it (issue #255,
 *  dedup D-15). */
export async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** Whether the path exists — a successful stat on anything: file,
 *  directory, symlink to an existing target. A failed stat — missing,
 *  or a parent that is a regular file (a linked worktree's `.git`) —
 *  reads as false. */
export async function pathExists(path: string): Promise<boolean> {
  return (await statIfExists(path)) !== undefined;
}

/** Assert the path is an accessible directory, naming the noun in
 *  the error; `displayPath` (default: `path`) is what the message
 *  shows — the input the operator typed, when it differs from the
 *  resolved path. */
export async function assertDirectory(
  noun: string,
  path: string,
  displayPath = path,
): Promise<void> {
  const info = await statIfExists(path);

  if (info === undefined) {
    throw new Error(`${noun} does not exist: ${displayPath}`);
  }

  if (!info.isDirectory()) {
    throw new Error(`${noun} is not a directory: ${displayPath}`);
  }
}

/** Read a text file if it exists; undefined when it does not.
 *  Any other read error propagates. */
export async function readTextIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/** Whether the value is a non-array, non-null object. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names that would corrupt plain-object bookkeeping as keys. */
export const RESERVED_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** What `listFiles` skips and reports while walking. */
export interface ListFilesOptions {
  /** Directory names never descended, at any depth. */
  readonly skipDirs?: ReadonlySet<string>;
  /** Directory names never descended at the walk root only. */
  readonly skipRootDirs?: ReadonlySet<string>;
  /** File names never collected. */
  readonly skipFiles?: ReadonlySet<string>;
  /** When set, only regular files are collected — symlinked and
   *  other non-directory entries are skipped. The default collects
   *  every entry that is not a directory, so health checks can flag
   *  stray symlinks as orphans. */
  readonly regularFilesOnly?: boolean | undefined;
  /** When set, only file names ending in this extension are collected. */
  readonly extension?: string;
  /** Receives the running count of directories read, for a progress
   *  heartbeat. */
  readonly onDir?: ((visited: number) => void) | undefined;
}

/** Recursively list every file under `dir`, as `/`-separated paths
 *  relative to it — the one directory walker (issue #255): the
 *  vault scan, the repo-adapter allowlist walk, and the publish
 *  stage's two-sided copy all funnel through it, each declaring
 *  its own skip sets. Skipped directories are never read, so their
 *  subtrees never enter the candidate set. */
export async function listFiles(
  dir: string,
  prefix = "",
  options: ListFilesOptions = {},
): Promise<string[]> {
  const files: string[] = [];

  await walkInto(dir, prefix, options, files, { visited: 0 });

  return files;
}

/** Running state of one walk: how many directories were read. */
interface WalkState {
  visited: number;
}

async function walkInto(
  dir: string,
  prefix: string,
  options: ListFilesOptions,
  files: string[],
  state: WalkState,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  state.visited++;
  options.onDir?.(state.visited);

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      if (shouldDescend(entry, prefix, options)) {
        await walkInto(join(dir, entry.name), rel, options, files, state);
      }
    } else if (shouldCollect(entry, options)) {
      files.push(rel);
    }
  }
}

/** Whether the walk descends into this directory entry: never into
 *  a skipDirs name, and at the walk root not into a skipRootDirs
 *  name either. */
function shouldDescend(
  entry: Dirent,
  prefix: string,
  options: ListFilesOptions,
): boolean {
  if (options.skipDirs?.has(entry.name) === true) {
    return false;
  }

  return prefix !== "" || options.skipRootDirs?.has(entry.name) !== true;
}

/** Whether the walk collects this file entry: not a skipFiles
 *  name, a regular file when the walk is regular-files-only, and
 *  matching the extension filter when set. */
function shouldCollect(entry: Dirent, options: ListFilesOptions): boolean {
  if (options.skipFiles?.has(entry.name) === true) {
    return false;
  }

  if (options.regularFilesOnly === true && !entry.isFile()) {
    return false;
  }

  return (
    options.extension === undefined || entry.name.endsWith(options.extension)
  );
}

/** Lowercase hex SHA-256 digest of the given bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
