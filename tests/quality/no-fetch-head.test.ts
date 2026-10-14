import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The no-fetch-head guard (issue #464): the writer runtime never
 * anchors reads on git's shared fetch-head file — any git process
 * touching the repo can rewrite or empty it mid-tenure (a zero-match
 * fetch truncates it to 0 bytes), and the 2026-10-14 incident died at
 * a lease renewal on exactly that read. The guard bans the literal
 * under src/ and scripts/; any new exception needs an allowlist entry
 * here plus a written justification in the PR body (same policy
 * class as Stryker disables). Same enforcement style as the
 * mirrored-tree and no-re-export-shim guards; the scan reads the
 * real tree and skips inside the Stryker sandbox (issue #276).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Recursively collect repo-relative .ts paths under `root`. */
async function collectTsFiles(root: string, prefix = ""): Promise<string[]> {
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

/**
 * The literal is banned verbatim, comments included: a documented
 * FETCH_HEAD read is still a FETCH_HEAD read. line numbers are
 * 1-based, matching editor navigation.
 */
const BANNED = "FETCH_HEAD";

/**
 * Explicit allowlist, empty at fix time (issue #464). The observability
 * module reports only the file's `{exists, size}` state and assembles
 * its name without the literal, so it needs no entry.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map();

describe("no-fetch-head guard (issue #464)", () => {
  it("contains no FETCH_HEAD literal under src/ or scripts/", async ({
    skip,
  }) => {
    if (
      import.meta.url.includes(".stryker-tmp") ||
      "__stryker__" in globalThis
    ) {
      skip(
        "Stryker sandbox instruments the tree; the scan reads the real src/ (issue #276)",
      );

      return;
    }

    const offenders: string[] = [];

    for (const root of ["src", "scripts"]) {
      for (const file of await collectTsFiles(join(repoRoot, root), root)) {
        const exempt = ALLOWLIST.get(file);

        if (exempt !== undefined) {
          continue;
        }

        const lines = (await readFile(join(repoRoot, file), "utf8")).split(
          "\n",
        );

        for (const [index, line] of lines.entries()) {
          if (line.includes(BANNED)) {
            offenders.push(`${file}:${index + 1}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist explicit and at fix-time scope", () => {
    expect(ALLOWLIST.size).toBe(0);
  });
});
