import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared helpers for the quality guards that scan the real `src/`
 * tree: the Stryker sandbox detector (issue #276) and the recursive
 * .ts collector. Stryker's dry run executes against an instrumented
 * copy, not the real tree, so tree-shape assertions must skip
 * (`ctx.skip`) inside it.
 */
export function insideStrykerSandbox(): boolean {
  return (
    import.meta.url.includes(".stryker-tmp") || "__stryker__" in globalThis
  );
}

/** Recursively collect repo-relative .ts paths under `root`. */
export async function collectTsFiles(
  root: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(join(root, entry.name), rel)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(rel);
    }
  }

  return files.sort();
}
