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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/** Biome-formatted comment lines: `// …`, `* …`, `/* …`. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();

  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

const MAIN_INVOCATION = /^\s*(?:await\s+)?main\s*\(|=\s*(?:await\s+)?main\s*\(/;
const MAIN_DEFINITION = /\bfunction\s+main\s*\(/;
const QUOTED_BIN_PATH = /["'][^"']*\/?bin\//;
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
          if (
            !isCommentLine(line) &&
            MAIN_INVOCATION.test(line) &&
            !MAIN_DEFINITION.test(line)
          ) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no src/ module imports from bin/", async () => {
    const offenders: string[] = [];

    for (const file of await collectTsFiles(join(repoRoot, "src"), "src")) {
      const lines = (await readFile(join(repoRoot, file), "utf8")).split("\n");

      lines.forEach((line, index) => {
        if (!isCommentLine(line) && QUOTED_BIN_PATH.test(line)) {
          if (IMPORT_SYNTAX.test(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("every npm node script runs an existing bin launcher whose import resolves to a main module", async () => {
    const pkg = await readPackageJson();
    const problems: string[] = [];

    for (const target of nodeScriptTargets(pkg)) {
      if (!target.startsWith("bin/")) {
        problems.push(`${target}: npm node script does not point into bin/`);

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

      const modulePath = resolve(join(repoRoot, "bin"), imported);

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

  it("every bin launcher is committed 100755 with a node shebang and referenced by package.json or scripts/mutation-changed.sh", async () => {
    const binFiles = await collectTsFiles(join(repoRoot, "bin"), "bin");
    const pkg = await readPackageJson();
    const shell = await readFile(
      join(repoRoot, "scripts", "mutation-changed.sh"),
      "utf8",
    );

    const referenced = new Set<string>([
      ...nodeScriptTargets(pkg),
      ...[...shell.matchAll(/(bin\/[\w.-]+\.ts)/g)].map((m) => m[1] ?? ""),
    ]);

    // Under Stryker the test tree is the sandbox (an untracked copy
    // inside .stryker-tmp/); resolve the enclosing git worktree so the
    // index lookup sees the committed modes, sandbox or not.
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    const modes = new Map<string, string>(
      execFileSync("git", ["ls-files", "-s", "--", "bin"], {
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

    for (const file of binFiles) {
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
