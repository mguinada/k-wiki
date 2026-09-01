import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The convention guard for the bin/ launcher design (issue #135):
 * `src/` and `scripts/` modules are libraries that never invoke
 * `main()` at module scope, so a Stryker mutant of any mutated file
 * cannot fire a CLI `main()` as an import side effect with live
 * defaults — issue #123's hazard class, eliminated by construction.
 * This scan runs in the normal unit gates, so a future regression of
 * the pattern fails CI (typescript@7 has no AST API; the scan is a
 * line-anchored approximation, total for this codebase's style).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
 * Biome-formatted comment lines: `// …`, `* …`, `/* …`. Deliberately
 * a per-line heuristic, not a comment-span stripper: stripping spans
 * from `/*`-in-a-string or unbalanced markers can silently skip real
 * code lines (false negatives), while this approximation can only
 * over-flag (false positives) — the safe direction for a guard.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();

  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

const MAIN_INVOCATION =
  /^\s*(?:await\s+)?main\s*\(|[=;{)]\s*(?:await\s+)?main\s*\(/;
const MAIN_DEFINITION = /\bfunction\s+main\s*\(/;

/**
 * The scan's per-line verdict: a non-comment line that invokes
 * `main()` in statement position (bare, after `=`, or inside a
 * single-line `if … main()` body) and is not the definition itself.
 */
function isMainInvocationLine(line: string): boolean {
  return (
    !isCommentLine(line) &&
    MAIN_INVOCATION.test(line) &&
    !MAIN_DEFINITION.test(line)
  );
}
const QUOTED_LAUNCHER_PATH = /["'][^"']*\/?(?:bin|dev)\//;
const IMPORT_SYNTAX = /^\s*import[\s(]|\bfrom\s+["']/;
const LAUNCHER_IMPORT = /^import\s+\{[^}]*\}\s+from\s+"(\.[^"]+)";/m;

interface PackageJson {
  scripts: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
}

/** The npm script values that run node against a repo script. */
function nodeScriptTargets(pkg: PackageJson): string[] {
  return Object.values(pkg.scripts)
    .filter((value) => value.startsWith("node "))
    .map((value) => value.slice("node ".length).split(/\s+/)[0] ?? "");
}

describe("module-scope main() detector (issue #135 guard)", () => {
  const regressionForms = [
    "  await main();",
    "  main(process.argv.slice(2));",
    "  if (isMainModule(import.meta.url)) await main();",
    "  if (isMain) { await main(); }",
    "const isMain = main();",
  ];

  const benignForms = [
    "export async function main(): Promise<void> {",
    "lines changed vs origin/main (uncommitted work included): one",
    "// await main();",
    " * await main();",
    "/* await main(); */",
    'const url = "https://example.com/main (docs)";',
  ];

  for (const line of regressionForms) {
    it(`flags the regression form: ${line.trim()}`, () => {
      expect(isMainInvocationLine(line)).toBe(true);
    });
  }

  for (const line of benignForms) {
    it(`ignores the benign line: ${line.trim()}`, () => {
      expect(isMainInvocationLine(line)).toBe(false);
    });
  }
});

describe("bin/ launcher structure (issue #135)", () => {
  it("no main() invocation exists anywhere under src/ or scripts/", async () => {
    const roots = ["src", "scripts"];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of await collectTsFiles(join(repoRoot, root), root)) {
        const lines = (await readFile(join(repoRoot, file), "utf8")).split(
          "\n",
        );

        lines.forEach((line, index) => {
          if (isMainInvocationLine(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no src/ module imports from bin/ or dev/", async () => {
    const offenders: string[] = [];

    for (const file of await collectTsFiles(join(repoRoot, "src"), "src")) {
      const lines = (await readFile(join(repoRoot, file), "utf8")).split("\n");

      lines.forEach((line, index) => {
        if (!isCommentLine(line) && QUOTED_LAUNCHER_PATH.test(line)) {
          if (IMPORT_SYNTAX.test(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("every npm node script runs an existing bin/ or dev/ launcher whose import resolves to a main module", async () => {
    const pkg = await readPackageJson();
    const problems: string[] = [];

    for (const target of nodeScriptTargets(pkg)) {
      if (!target.startsWith("bin/") && !target.startsWith("dev/")) {
        problems.push(
          `${target}: npm node script points into neither bin/ nor dev/`,
        );

        continue;
      }

      const launcherPath = join(repoRoot, target);

      if (
        !(await stat(launcherPath).then(
          () => true,
          () => false,
        ))
      ) {
        problems.push(`${target}: launcher file missing`);

        continue;
      }

      const launcher = await readFile(launcherPath, "utf8");
      const imported = LAUNCHER_IMPORT.exec(launcher)?.[1];

      if (imported === undefined) {
        problems.push(`${target}: no single-import launcher shape`);

        continue;
      }

      const modulePath = resolve(dirname(launcherPath), imported);

      if (
        !(await stat(modulePath).then(
          () => true,
          () => false,
        )) ||
        !/\bexport\s+(async\s+)?function\s+main\b/.test(
          await readFile(modulePath, "utf8"),
        )
      ) {
        problems.push(`${target}: imports no existing main module`);
      }
    }

    expect(problems).toEqual([]);
  });

  it("every main()-exporting module under src/ or scripts/ is imported by some bin/ or dev/ launcher", async () => {
    const launcherFiles = [
      ...(await collectTsFiles(join(repoRoot, "bin"), "bin")),
      ...(await collectTsFiles(join(repoRoot, "dev"), "dev")),
    ];
    const launcherText = await Promise.all(
      launcherFiles.map((file) => readFile(join(repoRoot, file), "utf8")),
    );
    const problems: string[] = [];

    for (const root of ["src", "scripts"]) {
      for (const file of await collectTsFiles(join(repoRoot, root), root)) {
        const text = await readFile(join(repoRoot, file), "utf8");

        if (!/\bexport\s+(async\s+)?function\s+main\b/.test(text)) {
          continue;
        }

        const imported = launcherText.some((launcher) =>
          launcher.includes(`"../${file}"`),
        );

        if (!imported) {
          problems.push(
            `${file}: exports main() but no bin/ or dev/ launcher imports it`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("every bin/ and dev/ launcher is committed 100755 with a node shebang and referenced by package.json or dev/mutation-changed.sh", async () => {
    const launcherFiles = [
      ...(await collectTsFiles(join(repoRoot, "bin"), "bin")),
      ...(await collectTsFiles(join(repoRoot, "dev"), "dev")),
    ];
    const pkg = await readPackageJson();
    const shell = await readFile(
      join(repoRoot, "dev", "mutation-changed.sh"),
      "utf8",
    );

    const referenced = new Set<string>([
      ...nodeScriptTargets(pkg),
      ...[...shell.matchAll(/((?:bin|dev)\/[\w.-]+\.ts)/g)].map(
        (m) => m[1] ?? "",
      ),
    ]);

    // Under Stryker the test tree is the sandbox (an untracked copy
    // inside .stryker-tmp/); resolve the enclosing git worktree so the
    // index lookup sees the committed modes, sandbox or not.
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    const modes = new Map<string, string>(
      execFileSync("git", ["ls-files", "-s", "--", "bin", "dev"], {
        cwd: gitRoot,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line !== "")
        .map((line): [string, string] => {
          const match = /^(\d+)\s+[0-9a-f]+\s+\d+\t(.+)$/.exec(line);

          return match === null ? ["", ""] : [match[2] ?? "", match[1] ?? ""];
        }),
    );

    const problems: string[] = [];

    for (const file of launcherFiles) {
      const firstLine = (await readFile(join(repoRoot, file), "utf8")).split(
        "\n",
        1,
      )[0];

      if (firstLine !== "#!/usr/bin/env node") {
        problems.push(`${file}: missing node shebang`);
      }

      if (modes.get(file) !== "100755") {
        problems.push(`${file}: not committed with mode 100755`);
      }

      if (!referenced.has(file)) {
        problems.push(
          `${file}: referenced by no npm script or mutation-changed.sh`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});

describe("launcher two-class rule (issue #253)", () => {
  /**
   * The wiki runtime interface and the development-lifecycle tooling
   * live in separate launcher classes: `bin/*.ts` launches the wiki
   * runtime (meaningful outside this repo), `dev/*.ts` launches
   * repo-internal development commands whose src domains are
   * quality/, board/, and fixtures/. A launcher in the wrong class
   * blurs the two-context doctrine the split exists to encode.
   */
  const DEV_DOMAIN_IMPORT = /^\.\.\/src\/(?:quality|board|fixtures)\//;

  it("no bin/ launcher imports a dev-only src domain (quality/, board/, fixtures/)", async () => {
    const offenders: string[] = [];

    for (const file of await collectTsFiles(join(repoRoot, "bin"), "bin")) {
      const imported = LAUNCHER_IMPORT.exec(
        await readFile(join(repoRoot, file), "utf8"),
      )?.[1];

      if (imported !== undefined && DEV_DOMAIN_IMPORT.test(imported)) {
        offenders.push(`${file}: imports dev domain ${imported}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every dev/ launcher imports a dev-only src domain (quality/, board/, fixtures/)", async () => {
    const offenders: string[] = [];

    for (const file of await collectTsFiles(join(repoRoot, "dev"), "dev")) {
      const imported = LAUNCHER_IMPORT.exec(
        await readFile(join(repoRoot, file), "utf8"),
      )?.[1];

      if (imported === undefined || !DEV_DOMAIN_IMPORT.test(imported)) {
        offenders.push(
          `${file}: imports no dev domain (${imported ?? "no import"})`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
