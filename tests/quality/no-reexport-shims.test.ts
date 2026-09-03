import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * G3 — the no-re-export-shim guard (issue #260): `src/` and `scripts/`
 * modules never re-export another module's symbols — one canonical
 * import path per symbol (the repo's no-compatibility-layer rule). A
 * re-export shim spawns duplicated coverage and stale import paths —
 * the H-1 finding class. The scan reads the real tree and skips
 * inside the Stryker sandbox (issue #276); the detector table runs
 * everywhere.
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
 * Biome-formatted comment lines: `// …`, `* …`, `/* …`. Same per-line
 * heuristic as the bin-structure scan: it can only over-flag, never
 * skip real code lines.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();

  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

const RE_EXPORT = /^export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s*from\s/;

/** Whether a non-comment line re-exports another module's symbols. */
function isReExportLine(line: string): boolean {
  return !isCommentLine(line) && RE_EXPORT.test(line);
}

describe("re-export shim detector (G3, issue #260)", () => {
  const regressionForms = [
    'export { checkCrossWikiLinks } from "../src/wiki/crosslinks.ts";',
    'export * from "./colors.ts";',
    'export type { Foo } from "./types.ts";',
    'export { canAnimate, terminalColors } from "./colors.ts";',
  ];

  const benignForms = [
    'import { checkWikiFidelity } from "../src/wiki/fidelity.ts";',
    "export { stem };",
    "export function main(): Promise<void> {",
    'export const script = "bin/check-fidelity.ts";',
    ' * export { checkCrossWikiLinks } from "../src/wiki/crosslinks.ts";',
    '// export * from "./colors.ts";',
  ];

  for (const line of regressionForms) {
    it(`flags the shim form: ${line}`, () => {
      expect(isReExportLine(line)).toBe(true);
    });
  }

  for (const line of benignForms) {
    it(`ignores the benign line: ${line}`, () => {
      expect(isReExportLine(line)).toBe(false);
    });
  }
});

describe("no re-export shims (G3, issue #260)", () => {
  it("no src/ or scripts/ module re-exports another module's symbols", async ({
    skip,
  }) => {
    if (
      import.meta.url.includes(".stryker-tmp") ||
      "__stryker__" in globalThis
    ) {
      skip(
        "Stryker sandbox instruments the tree; the shim scan reads the real src/ (issue #276)",
      );

      return;
    }

    const offenders: string[] = [];

    for (const root of ["src", "scripts"]) {
      for (const file of await collectTsFiles(join(repoRoot, root), root)) {
        const lines = (await readFile(join(repoRoot, file), "utf8")).split(
          "\n",
        );

        lines.forEach((line, index) => {
          if (isReExportLine(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
