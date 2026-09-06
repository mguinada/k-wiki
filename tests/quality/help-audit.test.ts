import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The help audit (issue #334): AGENTS.md mandates that every
 * launcher — each `main()` entry point — responds to both `-h` and
 * `--help`, exiting 0 without side effects, and the two spellings
 * print the same help. Audited by execution, not assumption: every
 * file in `bin/` (extensionless launchers) and every `dev/*.ts`
 * (its `.sh` scripts are not node-run CLIs) runs as a child process
 * under both spellings. A launcher that hangs or exits non-zero
 * lands in the offenders list naming it.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = promisify(execFile);
const LAUNCHER_DIRS = ["bin", "dev"] as const;

/** Every node-run launcher in `dir`: all of bin/, the .ts of dev/. */
async function collectLaunchers(dir: "bin" | "dev"): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), {
    withFileTypes: true,
  });

  return entries
    .filter(
      (entry) =>
        entry.isFile() && (dir === "bin" || entry.name.endsWith(".ts")),
    )
    .map((entry) => join(repoRoot, dir, entry.name))
    .sort();
}

/** One launcher run under one help spelling, as `path: exit-code`. */
async function runHelp(
  launcher: string,
  flag: "-h" | "--help",
): Promise<string> {
  try {
    await run(process.execPath, [launcher, flag], { timeout: 30_000 });

    return "";
  } catch {
    return `${launcher} ${flag}`;
  }
}

describe("help audit (issue #334)", () => {
  it("every bin/ and dev/*.ts launcher exits 0 for -h and --help", async () => {
    const launchers = (
      await Promise.all(LAUNCHER_DIRS.map(collectLaunchers))
    ).flat();
    const offenders = await Promise.all(
      launchers.flatMap((launcher) =>
        (["-h", "--help"] as const).map((flag) => runHelp(launcher, flag)),
      ),
    );

    expect(offenders.filter((failure) => failure !== "")).toEqual([]);
  });

  it("every launcher prints the same help for -h as for --help", async () => {
    const launchers = (
      await Promise.all(LAUNCHER_DIRS.map(collectLaunchers))
    ).flat();
    const outputs = await Promise.all(
      launchers.map(async (launcher) => {
        const short = await run(process.execPath, [launcher, "-h"], {
          encoding: "utf8",
          timeout: 30_000,
        });
        const long = await run(process.execPath, [launcher, "--help"], {
          encoding: "utf8",
          timeout: 30_000,
        });

        return short.stdout === long.stdout ? "" : launcher;
      }),
    );

    expect(outputs.filter((difference) => difference !== "")).toEqual([]);
  });
});
