import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Vault walker: collects every markdown file below the vault root as a
 * POSIX-style relative path, pruning vault noise (guide §26 operating
 * rules 5): `.obsidian/`, `.trash/`, and `.DS_Store` never enter the
 * candidate set.
 */

const SKIPPED_DIRECTORIES = new Set([".obsidian", ".trash"]);
const SKIPPED_FILES = new Set([".DS_Store"]);
const MARKDOWN_EXTENSION = ".md";

/**
 * Every markdown file under root, outside the noise paths, as sorted
 * POSIX-style relative paths. `onDir` receives the running count of
 * directories visited, for a progress heartbeat.
 */
export async function scanVault(
  root: string,
  onDir?: (visited: number) => void,
): Promise<string[]> {
  const files: string[] = [];

  await walk(root, "", files, onDir, { visited: 0 });

  files.sort();

  return files;
}

interface WalkState {
  visited: number;
}

async function walk(
  dir: string,
  prefix: string,
  files: string[],
  onDir: ((visited: number) => void) | undefined,
  state: WalkState,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  state.visited++;
  onDir?.(state.visited);

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(join(dir, entry.name), rel, files, onDir, state);
      }
    } else if (
      entry.isFile() &&
      !SKIPPED_FILES.has(entry.name) &&
      entry.name.endsWith(MARKDOWN_EXTENSION)
    ) {
      files.push(rel);
    }
  }
}
