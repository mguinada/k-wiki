import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  collectMetrics,
  collectOffenders,
  main,
  matchLine,
  metricsOfOffenders,
} from "../../src/quality/refactor-metrics.ts";

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
    // Layering inversion: an import from the data domain into the
    // sync domain — the dataToSyncEdges counter counts it, and it
    // also crosses domains for crossDomainEdges (six edges total).
    "data/db.ts": 'import { sha } from "../sync/hash.ts";\n',
    "sync/hash.ts": "export const sha = 1;\n",
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
    "dup/arrow.ts": [
      "const parseArgs = (args: readonly string[]): void => {};",
      "const walkTree = async (dir: string): Promise<void> => {};",
      "const unquote = (value: string): string => value;",
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
      crossDomainEdges: 6,
      dataToSyncEdges: 1,
      parseArgsCopies: 3,
      directoryWalkers: 3,
      repoRootDerivations: 2,
      unquoteDefinitions: 3,
      envSignatures: 3,
      envSignatureFiles: 1,
      dataRootEnvPairs: 1,
      dirnameRawDirDerivations: 2,
    });
  });
});

describe("metricsOfOffenders (fixture tree)", () => {
  it("counts a site without a line count as zero for the maximum", async () => {
    const offenders = await collectOffenders(await makeFixtureTree());
    const metrics = metricsOfOffenders({
      ...offenders,
      maxFileLines: [...offenders.maxFileLines, { path: "ghost.ts" }],
    });

    expect(metrics.maxFileLines).toBe(820);
  });
});

describe("collectOffenders (exact sites, issue #240 kill batch)", () => {
  /** A small tree whose offender sites are asserted exactly:
   *  one cross-domain import on line 2 (after a comment), one
   *  root-escaping import, one data→data edge, one 500-line file
   *  exactly at the >500 band boundary, and a file without a
   *  trailing newline. */
  async function makeSitesTree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-rm-sites-"));

    tempDirs.push(root);

    const files: Record<string, string> = {
      "dom1/a.ts": 'import { x } from "../dom2/b.ts";\n',
      "dom2/b.ts": "export const x = 1;\n",
      "dom1/c.ts": [
        "// comment line holds the import at line 2",
        'import { y } from "../dom2/b.ts";',
        "",
      ].join("\n"),
      "dom1/escape.ts": 'import { z } from "../../outside.ts";\n',
      "data/inner.ts": 'import { q } from "./q.ts";\n',
      "data/q.ts": "export const q = 1;\n",
      "band/b500.ts": lineFile(500),
    };

    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(root, dirname(file)), { recursive: true });
      await writeFile(join(root, file), content);
    }

    return root;
  }

  it("attributes cross-domain sites with the import's 1-based line", async () => {
    const offenders = await collectOffenders(await makeSitesTree());

    expect(offenders.crossDomainEdges).toEqual([
      { path: "dom1/a.ts", line: 1 },
      { path: "dom1/c.ts", line: 2 },
    ]);
  });

  it("excludes a data→data edge from data→sync sites", async () => {
    const offenders = await collectOffenders(await makeSitesTree());

    expect(offenders.dataToSyncEdges).toEqual([]);
  });

  it("keeps every file out of a band its line count only reaches, not exceeds", async () => {
    const metrics = await collectMetrics(await makeSitesTree());

    expect(metrics).toMatchObject({
      filesOver500: 0,
      filesOver350: 1,
      maxFileLines: 500,
    });
  });
});

describe("collectMetrics (whitespace-tolerant idioms, issue #240 kill batch)", () => {
  /** One file per regex nuance the duplication counters must
   *  tolerate: runs of spaces after `function`, zero or doubled
   *  spaces around `=` and after `async`. */
  async function makeIdiomTree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-rm-idioms-"));

    tempDirs.push(root);

    const files: Record<string, string> = {
      "rx/imp.ts": 'import { q } from    "../other/q.ts";\n',
      "other/q.ts": "export const q = 1;\n",
      "rx/main.ts": 'import { z } from "../../outside.ts";\n',
      "rx/sig.ts": "function  deep(env: NodeJS.ProcessEnv): void {}\n",
      "rx/name.ts": "function  xenv(y: number): void {}\n",
      "rx/pa.ts": "function  parseCliArgs(args: readonly string[]): void {}\n",
      "rx/wa.ts": "function  walkFiles(root: string): void {}\n",
      "rx/uq.ts": [
        "function  unquote(value: string): string {",
        "  return value;",
        "}",
        "",
      ].join("\n"),
      "rx/dirname.ts": 'const parent = dirname(rawDir + "/wiki");\n',
      "rx/arrow.ts":
        "const parseArgs=async(args: readonly string[]): Promise<void> => {};\n",
      "rx/arrow2.ts": "const walk3=async(dir: string): Promise<void> => {};\n",
      "rx/arrow3.ts": "const unquote=(value: string): string => value;\n",
      "rx/arrow4.ts":
        "const envHolder =  (env: NodeJS.ProcessEnv): void => {};\n",
      "rx/arrow5.ts": "const env2=(env: NodeJS.ProcessEnv): void => {};\n",
      "rx/arrow6.ts": "const  env3=(env: NodeJS.ProcessEnv): void => {};\n",
      "rx/arrow7.ts": "const xenv=(y: number): void => {};\n",
    };

    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(root, dirname(file)), { recursive: true });
      await writeFile(join(root, file), content);
    }

    return root;
  }

  it("counts every idiom form across flexible whitespace", async () => {
    expect(await collectMetrics(await makeIdiomTree())).toEqual({
      filesOver800: 0,
      filesOver500: 0,
      filesOver350: 0,
      maxFileLines: 3,
      crossDomainEdges: 1,
      dataToSyncEdges: 0,
      parseArgsCopies: 2,
      directoryWalkers: 2,
      repoRootDerivations: 0,
      unquoteDefinitions: 2,
      envSignatures: 4,
      envSignatureFiles: 4,
      dataRootEnvPairs: 0,
      dirnameRawDirDerivations: 1,
    });
  });
});

describe("collectMetrics (file-shape edges, issue #240 kill batch)", () => {
  it("counts the last line of a file without a trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-rm-nl-"));

    tempDirs.push(root);
    await writeFile(join(root, "only.ts"), "a\nb");

    expect((await collectMetrics(root)).maxFileLines).toBe(2);
  });

  it("counts zero lines for an empty file", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-rm-empty-"));

    tempDirs.push(root);
    await writeFile(join(root, "only.ts"), "");

    expect((await collectMetrics(root)).maxFileLines).toBe(0);
  });

  it("skips a symlinked .ts file outside the scan root", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-rm-link-"));

    tempDirs.push(root);
    await mkdir(join(root, "tree"), { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "real.ts"), lineFile(5));
    await symlink(
      join(root, "outside", "real.ts"),
      join(root, "tree", "link.ts"),
    );

    expect((await collectMetrics(join(root, "tree"))).maxFileLines).toBe(0);
  });

  it("ignores non-.ts files even when they are larger", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-rm-ext-"));

    tempDirs.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "b.md"), lineFile(3));

    expect((await collectMetrics(root)).maxFileLines).toBe(1);
  });
});

describe("rendered output (issue #240 kill batch)", () => {
  it("prints the exact counter table, one labeled line per counter", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main([await makeFixtureTree()]);

      expect(log).toHaveBeenCalledWith(
        [
          "files >800 lines: 1",
          "files >500 lines: 2",
          "files >350 lines: 3",
          "max file lines: 820",
          "cross-domain edges (excl. cli): 6",
          "data→sync edges: 1",
          "parseArgs copies: 3",
          "directory walkers: 3",
          "repoRoot derivations: 2",
          "unquote definitions: 3",
          "env: signatures: 3",
          "env: signature files: 1",
          "(dataRoot, env) pairs: 1",
          "dirname derivations of rawDir: 2",
        ].join("\n"),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("prints JSON with every counter key, in table order", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["--json", await makeFixtureTree()]);

      expect(Object.keys(JSON.parse(log.mock.calls[0]?.[0] ?? ""))).toEqual([
        "filesOver800",
        "filesOver500",
        "filesOver350",
        "maxFileLines",
        "crossDomainEdges",
        "dataToSyncEdges",
        "parseArgsCopies",
        "directoryWalkers",
        "repoRootDerivations",
        "unquoteDefinitions",
        "envSignatures",
        "envSignatureFiles",
        "dataRootEnvPairs",
        "dirnameRawDirDerivations",
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("prints the exact usage error line with its prefix", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    process.exitCode = 0;

    try {
      await main(["first-root", "second-root"]);

      expect(error).toHaveBeenCalledWith(
        "refactor-metrics: unexpected argument: second-root",
      );
    } finally {
      error.mockRestore();
      process.exitCode = 0;
    }
  });
});

describe("matchLine", () => {
  it("treats a match without an index as line one", () => {
    const match = ["x"] as unknown as RegExpMatchArray;

    expect(matchLine("a\nb", match)).toBe(1);
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
      expect.stringContaining("cross-domain edges (excl. cli): 6"),
    );
  });

  it("prints JSON keyed by counter name with --json", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--json", await makeFixtureTree()]);

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? "")).toMatchObject({
      crossDomainEdges: 6,
      dataToSyncEdges: 1,
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
      expect.stringContaining('unknown option "--bogus"'),
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

  it("--help explains every counter and says lower is better", async () => {
    const { stdout } = await run(process.execPath, [launcher, "--help"]);
    const missing = [
      "files >800",
      "max file lines",
      "cross-domain edges",
      "data\u2192sync edges",
      "parseArgs copies",
      "directory walkers",
      "repoRoot derivations",
      "unquote definitions",
      "env: signatures",
      "(dataRoot, env) pairs",
      "dirname derivations of rawDir",
      "lower is better",
    ].filter((phrase) => !stdout.includes(phrase));

    expect(missing).toEqual([]);
  });
});
