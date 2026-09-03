import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * G2 — the mirrored test tree guard (issue #260): every
 * `src/<area>/<mod>.ts` module has its unit tests at
 * `tests/<area>/<mod>.test.ts` (the AGENTS.md mirrored-tree rule), so
 * a module extracted or moved into `src/` can never silently leave
 * its tests behind at the old path — the H-2 finding class. A module
 * that legitimately carries no mirrored test is allowlisted below
 * with a written justification; a stale entry (the module has since
 * gained its mirrored test) fails, so the allowlist cannot rot. The
 * scan reads the real `src/` tree and skips inside the Stryker
 * sandbox, where instrumentation would distort the tree (issue #276).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A src module without a mirrored test, with the written
 *  justification that keeps it out of the scan. An empty or missing
 *  justification string fails the integrity expectation below — an
 *  unjustified gap is exactly what this guard exists to reject. */
const ALLOWLIST: Readonly<Record<string, string>> = {};

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

/** The mirrored test path of a src module: `src/` → `tests/`, and the
 *  `.ts` suffix becomes `.test.ts`. */
function mirroredTestPath(module: string): string {
  return `tests/${module.slice("src/".length, -".ts".length)}.test.ts`;
}

/** The Stryker sandbox detector (issue #276): the dry run executes
 *  against an instrumented copy, not the real tree this guard reads. */
function insideStrykerSandbox(): boolean {
  return (
    import.meta.url.includes(".stryker-tmp") || "__stryker__" in globalThis
  );
}

const skipNote =
  "Stryker sandbox instruments the tree; the mirrored scan reads the real src/ (issue #276)";

describe("mirroredTestPath", () => {
  it("maps an area module to its mirrored test path", () => {
    expect(mirroredTestPath("src/wiki/pages.ts")).toBe(
      "tests/wiki/pages.test.ts",
    );
  });

  it("maps a top-level src file into the tests root", () => {
    expect(mirroredTestPath("src/main.ts")).toBe("tests/main.test.ts");
  });
});

describe("mirrored test tree (G2, issue #260)", () => {
  it("every src/ module has its mirrored test or an allowlisted justification", async ({
    skip,
  }) => {
    if (insideStrykerSandbox()) {
      skip(skipNote);

      return;
    }

    const offenders: string[] = [];

    for (const module of await collectTsFiles(join(repoRoot, "src"), "src")) {
      const mirrored = join(repoRoot, mirroredTestPath(module));

      if (module in ALLOWLIST) {
        continue;
      }

      if (
        !(await stat(mirrored).then(
          () => true,
          () => false,
        ))
      ) {
        offenders.push(
          `${module}: no mirrored test at ${mirroredTestPath(module)}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every allowlist entry names a real unmirrored module and carries a written justification", async ({
    skip,
  }) => {
    if (insideStrykerSandbox()) {
      skip(skipNote);

      return;
    }

    const srcModules = new Set(
      await collectTsFiles(join(repoRoot, "src"), "src"),
    );
    const problems: string[] = [];

    for (const [module, justification] of Object.entries(ALLOWLIST)) {
      if (!srcModules.has(module)) {
        problems.push(`${module}: allowlisted module does not exist`);

        continue;
      }

      if (justification.trim() === "") {
        problems.push(
          `${module}: allowlist entry lacks a written justification`,
        );
      }

      if (
        await stat(join(repoRoot, mirroredTestPath(module))).then(
          () => true,
          () => false,
        )
      ) {
        problems.push(
          `${module}: stale entry — the mirrored test exists, remove the allowlist entry`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});
