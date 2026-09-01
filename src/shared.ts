import { readFile } from "node:fs/promises";

/**
 * Shared runtime helpers: generic primitives with no domain of their
 * own, imported across module boundaries. The refactor campaign's
 * shared home (epic #242) — the fs micro-helper consolidation lands
 * here too.
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
