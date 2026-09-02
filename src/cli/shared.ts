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

/** Recursively list every file under `dir`, as `/`-separated paths
 *  relative to it. */
export async function listFiles(
  dir: string,
  prefix = "",
  files: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await listFiles(join(dir, entry.name), rel, files);
    } else {
      files.push(rel);
    }
  }

  return files;
}

/** Lowercase hex SHA-256 digest of the given bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
