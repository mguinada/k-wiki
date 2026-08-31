import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assignChunks,
  collectSrcFiles,
  main,
  type SrcFile,
} from "../../src/quality/mutation-chunk.ts";
import type { GitText } from "../../src/quality/mutation-scope.ts";

const script = realpathSync("bin/mutation-chunk.ts");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function runCli(args: readonly string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: process.cwd(),
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("close", (code) => resolve({ stdout, stderr, code }));
    },
  );
}

const files = (paths: readonly [string, number][]): SrcFile[] =>
  paths.map(([path, size]) => ({ path, size }));

describe("assignChunks", () => {
  it("returns one disjoint bucket per chunk covering every file", () => {
    const buckets = assignChunks(
      files([
        ["src/a.ts", 10],
        ["src/b.ts", 9],
      ]),
      2,
    );

    expect(buckets.flat().sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("balances buckets by assigning each next file to the smallest one", () => {
    const buckets = assignChunks(
      files([
        ["src/big.ts", 10],
        ["src/mid.ts", 9],
        ["src/small.ts", 8],
        ["src/tiny.ts", 7],
      ]),
      2,
    );

    expect(buckets).toEqual([
      ["src/big.ts", "src/tiny.ts"],
      ["src/mid.ts", "src/small.ts"],
    ]);
  });

  it("breaks size ties by path so equal files spread deterministically", () => {
    const buckets = assignChunks(
      files([
        ["src/b.ts", 5],
        ["src/a.ts", 5],
        ["src/c.ts", 5],
        ["src/d.ts", 5],
      ]),
      2,
    );

    expect(buckets).toEqual([
      ["src/a.ts", "src/c.ts"],
      ["src/b.ts", "src/d.ts"],
    ]);
  });

  it("throws when the chunk count exceeds the file count", () => {
    expect(() => assignChunks(files([["src/a.ts", 1]]), 2)).toThrow(
      /fewer files than chunks/,
    );
  });

  it("throws when the chunk count is zero", () => {
    expect(() => assignChunks([], 0)).toThrow(/--total must be at least 1/);
  });
});

describe("collectSrcFiles", () => {
  it("stats every file git lists and carries its byte size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mutation-chunk-"));

    tempDirs.push(dir);

    const one = join(dir, "one.ts");
    const two = join(dir, "two.ts");

    await writeFile(one, "const a = 1;");
    await writeFile(two, "const ab = 22;");

    const git: GitText = () => `${one}\n${two}\n`;

    expect(collectSrcFiles(git)).toEqual([
      { path: one, size: statSync(one).size },
      { path: two, size: statSync(two).size },
    ]);
  });
});

describe("mutation-chunk CLI", () => {
  // In-process with injected seams, never spawned against the real
  // tree: Stryker's dry run executes this suite inside its sandbox,
  // where a spawned child's git ls-files finds no tracked src/ files
  // and the child would fail (#236's own validation run caught it).
  it("prints one chunk's comma-separated file list", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      main(
        ["--index", "1", "--total", "2"],
        () =>
          files([
            ["src/a.ts", 10],
            ["src/b.ts", 9],
          ]),
        () => "",
      );

      expect(log.mock.calls[0]?.[0]).toBe("src/a.ts");
    } finally {
      log.mockRestore();
    }
  });

  it("exits 1 naming --index when it is missing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      main(
        ["--total", "2"],
        () => {
          throw new Error("collect must not run");
        },
        () => "",
      );

      expect(error.mock.calls[0]?.[0]).toContain("--index");
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.stdout).toContain("Usage: mutation-chunk");
    expect(result.code).toBe(0);
  });
});

describe("mutation-chunk argument handling", () => {
  const twoFiles = () =>
    files([
      ["src/a.ts", 10],
      ["src/b.ts", 9],
    ]);

  const run = (argv: readonly string[]) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const calls = { log: [] as string[], error: [] as string[] };

    log.mockImplementation((line: string) => {
      calls.log.push(line);
    });

    error.mockImplementation((line: string) => {
      calls.error.push(line);
    });

    try {
      main(argv, twoFiles, () => "");

      return { ...calls, exitCode: process.exitCode };
    } finally {
      log.mockRestore();

      error.mockRestore();

      process.exitCode = undefined;
    }
  };

  it("prints the single bucket for --total 1", () => {
    const result = run(["--index", "1", "--total", "1"]);

    expect(result.log[0]).toBe("src/a.ts,src/b.ts");
  });

  it("prints the last bucket when --index equals --total", () => {
    const result = run(["--index", "2", "--total", "2"]);

    expect(result.log[0]).toBe("src/b.ts");
  });

  it("exits 1 naming an unexpected argument", () => {
    const result = run(["bogus", "--index", "1"]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /unexpected argument: bogus.*\|1$/,
    );
  });

  it("exits 1 naming the switch when its value is not an integer", () => {
    const result = run(["--index", "abc", "--total", "2"]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /requires an integer value.*\|1$/,
    );
  });

  it("exits 1 naming the switch when its value is missing", () => {
    const result = run(["--index"]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /requires an integer value.*\|1$/,
    );
  });

  it("exits 1 for an --index above --total", () => {
    const result = run(["--index", "3", "--total", "2"]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toBe(
      "--index must be 1..2|1",
    );
  });

  it("exits 1 naming --total when it is missing", () => {
    const result = run(["--index", "1"]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /--total is required.*\|1$/,
    );
  });

  it("prints the usage line for -h in-process", () => {
    const result = run(["-h"]);

    expect(result.log[0]).toContain("Usage: mutation-chunk");
  });

  it("prints the usage line for --help in-process", () => {
    const result = run(["--help"]);

    expect(result.log[0]).toContain("Usage: mutation-chunk");
  });
});

describe("collectSrcFiles git contract", () => {
  it("asks git for exactly the src/*.ts pathspec", () => {
    const seen: string[][] = [];

    collectSrcFiles((args) => {
      seen.push([...args]);

      return "";
    });

    expect(seen).toEqual([["ls-files", "--", "src/*.ts"]]);
  });
});

describe("mutation-chunk direct execution", () => {
  it("refuses a direct node run naming its launcher", async () => {
    const child = spawn(process.execPath, ["src/quality/mutation-chunk.ts"]);

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    expect(stderr).toContain("run bin/mutation-chunk");
    expect(code).toBe(1);
  });
});

describe("mutation-chunk index bounds", () => {
  it("exits 1 for --index 0", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      main(
        ["--index", "0", "--total", "2"],
        () =>
          files([
            ["src/a.ts", 10],
            ["src/b.ts", 9],
          ]),
        () => "",
      );

      expect(error.mock.calls[0]?.[0]).toBe("--index must be 1..2");
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
  });
});
