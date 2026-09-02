import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The convention guard for process.chdir() in code the Stryker dry
 * run loads in-process (issue #193): @stryker-mutator/vitest-runner
 * executes the unit suite in worker threads, where process.chdir()
 * throws — a single call anywhere in that code killed every mutation
 * dry run before one mutant was tested (the #190 regression this
 * guard makes impossible to reintroduce). Mock process.cwd() or
 * spawn a real child process instead. Line-anchored approximation
 * with the same over-flag trade-off as the bin-structure scan: a
 * string literal naming a call is flagged too, and that is the safe
 * direction for a guard.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Recursively collect repo-relative .ts paths under `root`. */
async function collectTsFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    // cli-spawn and data:init stage transient launcher copies here
    // (`.*-import-staging`) while this scan may be walking tests/ in
    // parallel; skipping the staging directories kills the
    // read-vs-delete race (ENOENT) outright.
    if (entry.isDirectory() && entry.name.endsWith("-import-staging")) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(join(root, entry.name), rel)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(rel);
    }
  }

  return files.sort();
}

/**
 * Biome-formatted comment lines: `// …`, `* …`, `/* …`. Same
 * per-line heuristic as the bin-structure scan: it can only
 * over-flag, never skip real code lines.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();

  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

const CHDIR_CALL = /\bprocess\s*\.\s*chdir\s*\(/;

/** Whether a non-comment line calls process.chdir(). */
function isChdirCallLine(line: string): boolean {
  return !isCommentLine(line) && CHDIR_CALL.test(line);
}

describe("process.chdir() call detector (issue #193 guard)", () => {
  const regressionForms = [
    "    process.chdir(dir);",
    "await process.chdir(dir);",
    "process . chdir ( dir );",
  ];

  const benignForms = [
    "// process.chdir(dir);",
    " * process.chdir throws in the worker threads",
    "/* process.chdir(dir); */",
    'const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);',
  ];

  for (const line of regressionForms) {
    it(`flags the regression form: ${line.trim()}`, () => {
      expect(isChdirCallLine(line)).toBe(true);
    });
  }

  for (const line of benignForms) {
    it(`ignores the benign line: ${line.trim()}`, () => {
      expect(isChdirCallLine(line)).toBe(false);
    });
  }
});

describe("process.chdir() scan (issue #193)", () => {
  it("no test or src file calls process.chdir()", async () => {
    const offenders: string[] = [];

    for (const root of ["src", "scripts", "tests"]) {
      for (const file of await collectTsFiles(join(repoRoot, root), root)) {
        // This scan's own detector table quotes the flagged forms as
        // string literals; they are the documentation, not the hazard.
        if (file === "tests/quality/no-process-chdir.test.ts") {
          continue;
        }
        const lines = (await readFile(join(repoRoot, file), "utf8")).split(
          "\n",
        );

        lines.forEach((line, index) => {
          if (isChdirCallLine(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
