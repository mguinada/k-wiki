import { listFiles } from "../cli/shared.ts";

/**
 * Vault walker: collects every markdown file below the vault root as a
 * POSIX-style relative path, pruning vault noise (guide §26 operating
 * rules 5): `.obsidian/`, `.trash/`, and `.DS_Store` never enter the
 * candidate set. The walk itself is the shared `listFiles` walker
 * (issue #255); only the vault's skip sets live here.
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
  const files = await listFiles(root, "", {
    skipDirs: SKIPPED_DIRECTORIES,
    skipFiles: SKIPPED_FILES,
    extension: MARKDOWN_EXTENSION,
    regularFilesOnly: true,
    onDir,
  });

  files.sort();

  return files;
}
