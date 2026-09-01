import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { collectMetrics, main } from "../../src/quality/refactor-metrics.ts";

const run = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const launcher = join(repoRoot, "dev", "refactor-metrics.ts");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, recursiveRmOptions())));
});

function recursiveRmOptions() {
  return { recursive: true, force: true } as const;
}

/** A `.ts` file body of exactly `lines` newline-terminated lines. */
function lineFile(lines: number, header = "// filler"): string {
  return `${Array<string>(lines).fill(header).join("\n")}\n`;
}

/**
 * A synthetic src-like tree exercising every counter: oversized files,
 * cross-domain imports (same-domain, cross-domain, cli-excluded,
 * package-ignored), and each duplication idiom at a known count.
 */
async function makeFixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-refactor-metrics-"));

  tempDirs.push(root);

  const files: Record<string, string> = {
    // Size counters: 820 > 800; 820 and 520 > 500; 820, 520, 360 > 350.
    "alpha/big.ts": lineFile(820),
    "alpha/mid.ts": lineFile(520),
    "alpha/small.ts": lineFile(360),
    "alpha/tiny.ts": lineFile(10),
    // Import edges: one.ts -> beta (cross), two.ts -> alpha and edge
    // (cross), edge.ts -> alpha twice (cross). The two cli-endpoint
    // imports, same-domain imports, and package imports do not count.
    "alpha/one.ts": [
      'import { a } from "./tiny.ts";',
      'import { b } from "../beta/two.ts";',
      'import { c } from "../cli/shared.ts";',
      "",
    ].join("\n"),
    "beta/two.ts": [
      'import { basename } from "node:path";',
      'import { colors } from "picocolors";',
      'import { a } from "../alpha/one.ts";',
      'import { e } from "../edge.ts";',
      "",
    ].join("\n"),
    "cli/shared.ts": 'import { a } from "../alpha/one.ts";\n',
    "edge.ts": [
      'import { a } from "./alpha/one.ts";',
      'import { t } from "./alpha/tiny.ts";',
      "",
    ].join("\n"),
    // Duplication counters, each at a known count.
    "dup/a.ts": [
      "function parseArgs(args: readonly string[]): void {}",
      "function walk(dir: string): void {}",
      "",
    ].join("\n"),
    "dup/b.ts": [
      "function parseCliArgs(args: readonly string[]): void {}",
      "function walkFiles(root: string): void {}",
      "",
    ].join("\n"),
    "dup/c.ts": [
      "function unquote(path: string): string {",
      '  return path.replace(/^"|"$/g, "");',
      "}",
      'const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");',
      'refuseDirectExecution(import.meta.url, "c");',
      "",
    ].join("\n"),
    "dup/d.ts": [
      "function unquote(value: string): string {",
      "  return value;",
      "}",
      "const defaultRepoRoot = resolve(",
      "  dirname(fileURLToPath(import.meta.url)),",
      '  "../..",',
      ");",
      "",
    ].join("\n"),
    "dup/sig.ts": [
      "function f(env: NodeJS.ProcessEnv): void {}",
      "function g(",
      "  dataRoot: string,",
      "  env: NodeJS.ProcessEnv,",
      "): void {}",
      "const h = (env: NodeJS.ProcessEnv = process.env) => {};",
      "function i(dataRoot: string): void {}",
      "",
    ].join("\n"),
    "dup/dir.ts": [
      "const dataRoot = dirname(rawDir);",
      "const wikiDir = join(",
      "  dirname(options.rawDir),",
      '  "wiki",',
      ");",
      "",
    ].join("\n"),
  };

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(file)), { recursive: true });
    await writeFile(join(root, file), content);
  }

  return root;
}

describe("collectMetrics (fixture tree)", () => {
  let metrics: Awaited<ReturnType<typeof collectMetrics>>;

  it("computes every counter for a fixture tree", async () => {
    metrics = await collectMetrics(await makeFixtureTree());

    expect(metrics).toEqual({
      filesOver800: 1,
      filesOver500: 2,
      filesOver350: 3,
      maxFileLines: 820,
      crossDomainEdges: 5,
      parseArgsCopies: 2,
      directoryWalkers: 2,
      repoRootDerivations: 2,
      unquoteDefinitions: 2,
      envSignatures: 3,
      envSignatureFiles: 1,
      dataRootEnvPairs: 1,
      dirnameRawDirDerivations: 2,
    });
  });
});

describe("main (in-process)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("prints the counter table for a scanned root", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main([await makeFixtureTree()]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("cross-domain edges (excl. cli): 5"),
    );
  });

  it("prints JSON keyed by counter name with --json", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--json", await makeFixtureTree()]);

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? "")).toMatchObject({
      crossDomainEdges: 5,
      maxFileLines: 820,
    });
  });

  it("prints help before validating anything else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--help", "--not-a-real-switch"]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Usage: refactor-metrics"),
    );
  });

  it("scans this repository's src/ by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main([]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("files >800 lines:"),
    );
  });

  it("exits 1 with an error line for an unexpected argument", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--bogus"]);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("unexpected argument: --bogus"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 with an error line for a second positional argument", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["first-root", "second-root"]);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("unexpected argument: second-root"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 with an error line for an unreadable scan root", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main([join(tmpdir(), "k-wiki-refactor-metrics-absent")]);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("refactor-metrics:"),
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("CLI (dev/refactor-metrics.ts)", () => {
  it("--help exits 0 and prints the usage line", async () => {
    const { stdout } = await run(process.execPath, [launcher, "--help"]);

    expect(stdout).toContain("Usage: refactor-metrics");
  });
});
