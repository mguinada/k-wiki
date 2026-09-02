import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared runtime helpers: generic primitives with no domain of their
 * own, imported across module boundaries. They live in the cli
 * directory — the repo's shared layer, whose edges the campaign's
 * cross-domain counter deliberately exempts — as the refactor
 * campaign's helper home (epic #242); the fs micro-helper
 * consolidation lands here too.
 */

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
      const skipped = options.skipDirs?.has(entry.name) === true;
      const skippedAtRoot =
        prefix === "" && options.skipRootDirs?.has(entry.name) === true;

      if (!skipped && !skippedAtRoot) {
        await walkInto(join(dir, entry.name), rel, options, files, state);
      }
    } else if (
      entry.isFile() &&
      options.skipFiles?.has(entry.name) !== true &&
      (options.extension === undefined ||
        entry.name.endsWith(options.extension))
    ) {
      files.push(rel);
    }
  }
}

/** Lowercase hex SHA-256 digest of the given bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
