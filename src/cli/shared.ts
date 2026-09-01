import { readFile } from "node:fs/promises";

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
