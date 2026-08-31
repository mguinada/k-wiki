import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main, mergeReports } from "../../src/quality/mutation-merge.ts";

const script = realpathSync("bin/mutation-merge.ts");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const chunkReport = (file: string, status: string) => ({
  schemaVersion: "1.1",
  thresholds: { high: 80, low: 60 },
  framework: { name: "stryker" },
  files: {
    [file]: {
      language: "ts",
      source: "const a = 1;",
      mutants: [
        {
          mutatorName: "EqualityOperator",
          status,
          location: { start: { line: 1 } },
        },
      ],
    },
  },
});

describe("mergeReports", () => {
  it("merges the files of disjoint reports into one", () => {
    const merged = JSON.parse(
      mergeReports([
        JSON.stringify(chunkReport("src/a.ts", "Killed")),
        JSON.stringify(chunkReport("src/b.ts", "Survived")),
      ]),
    );

    expect(Object.keys(merged.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps every mutant from every chunk", () => {
    const merged = JSON.parse(
      mergeReports([
        JSON.stringify(chunkReport("src/a.ts", "Killed")),
        JSON.stringify(chunkReport("src/b.ts", "Survived")),
      ]),
    );

    const statuses = ["src/a.ts", "src/b.ts"].flatMap(
      (file) => merged.files[file].mutants.map((mutant) => mutant.status),
    );

    expect(statuses).toEqual(["Killed", "Survived"]);
  });

  it("carries the first report's non-files keys unchanged", () => {
    const merged = JSON.parse(
      mergeReports([
        JSON.stringify(chunkReport("src/a.ts", "Killed")),
        JSON.stringify(chunkReport("src/b.ts", "Survived")),
      ]),
    );

    expect({
      schemaVersion: merged.schemaVersion,
      thresholds: merged.thresholds,
      framework: merged.framework,
    }).toEqual({
      schemaVersion: "1.1",
      thresholds: { high: 80, low: 60 },
      framework: { name: "stryker" },
    });
  });

  it("passes a single report through with its files intact", () => {
    const merged = JSON.parse(
      mergeReports([JSON.stringify(chunkReport("src/a.ts", "Killed"))]),
    );

    expect(merged.files["src/a.ts"].mutants[0].status).toBe("Killed");
  });

  it("throws naming both schema versions on a mismatch", () => {
    const other = {
      ...chunkReport("src/b.ts", "Killed"),
      schemaVersion: "9.9",
    };

    expect(() =>
      mergeReports([
        JSON.stringify(chunkReport("src/a.ts", "Killed")),
        JSON.stringify(other),
      ]),
    ).toThrow(/1.1.*9.9|9.9.*1.1/);
  });

  it("throws naming the file mutated by two chunks", () => {
    expect(() =>
      mergeReports([
        JSON.stringify(chunkReport("src/a.ts", "Killed")),
        JSON.stringify(chunkReport("src/a.ts", "Survived")),
      ]),
    ).toThrow(/src\/a\.ts/);
  });

  it("throws naming the offending input on invalid JSON", () => {
    expect(() => mergeReports(["{"])).toThrow(/input 1/);
  });

  it("throws on an input without a files map", () => {
    expect(() => mergeReports(["{}"])).toThrow(/unexpected shape/);
  });

  it("throws when no report is given", () => {
    expect(() => mergeReports([])).toThrow(/at least one report/);
  });
});

function runCli(args: readonly string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      const child = spawn(process.execPath, [script, ...args]);

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

async function writeChunkReports() {
  const dir = await mkdtemp(join(tmpdir(), "mutation-merge-"));

  tempDirs.push(dir);

  const first = join(dir, "chunk-1.json");
  const second = join(dir, "chunk-2.json");

  await writeFile(first, JSON.stringify(chunkReport("src/a.ts", "Killed")));
  await writeFile(second, JSON.stringify(chunkReport("src/b.ts", "Survived")));

  return { dir, first, second };
}

describe("mutation-merge CLI", () => {
  it("prints the usage line for --help with exit 0", async () => {
    const result = await runCli(["--help"]);

    expect(`${result.stdout}|${result.code}`).toMatch(
      /Usage: mutation-merge[\s\S]*\|0$/,
    );
  });

  it("writes the merged report to the output path", async () => {
    const { dir, first, second } = await writeChunkReports();
    const out = join(dir, "merged.json");

    const result = await runCli([out, first, second]);

    const merged = JSON.parse(await readFile(out, "utf8"));

    expect(`${result.code}|${Object.keys(merged.files).sort().join(",")}`).toBe(
      "0|src/a.ts,src/b.ts",
    );
  });

  it("prints a summary line with the merged counts", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await runCli([join(dir, "merged.json"), first, second]);

    expect(result.stdout).toMatch(/2 mutants.*2 files.*2 reports/);
  });

  it("exits 0 with --expect matching the input count", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await runCli([
      join(dir, "merged.json"),
      first,
      second,
      "--expect",
      "2",
    ]);

    expect(result.code).toBe(0);
  });

  it("exits 1 naming both counts when --expect misses inputs", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await runCli([
      join(dir, "merged.json"),
      first,
      second,
      "--expect",
      "3",
    ]);

    expect(`${result.stderr}|${result.code}`).toMatch(
      /expected 3[\s\S]*\|1$/,
    );
  });

  it("exits 1 naming the output path requirement when no positional is given", async () => {
    const result = await runCli(["--expect", "2"]);

    expect(`${result.stderr}|${result.code}`).toMatch(
      /<out\.json>[\s\S]*\|1$/,
    );
  });
});

describe("mergeReports schema tolerance", () => {
  it("merges when only the first report lacks schemaVersion", () => {
    const { schemaVersion: _first, ...bare } = chunkReport(
      "src/a.ts",
      "Killed",
    );

    const merged = JSON.parse(
      mergeReports([
        JSON.stringify(bare),
        JSON.stringify(chunkReport("src/b.ts", "Survived")),
      ]),
    );

    expect(Object.keys(merged.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("merges when only the second report lacks schemaVersion", () => {
    const { schemaVersion: _second, ...bare } = chunkReport(
      "src/b.ts",
      "Survived",
    );

    const merged = JSON.parse(
      mergeReports([
        JSON.stringify(chunkReport("src/a.ts", "Killed")),
        JSON.stringify(bare),
      ]),
    );

    expect(Object.keys(merged.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names every overlapping file in the error", () => {
    expect(() =>
      mergeReports([
        JSON.stringify({
          ...chunkReport("src/a.ts", "Killed"),
          files: {
            ...chunkReport("src/a.ts", "Killed").files,
            ...chunkReport("src/b.ts", "Killed").files,
          },
        }),
        JSON.stringify({
          ...chunkReport("src/a.ts", "Survived"),
          files: {
            ...chunkReport("src/a.ts", "Survived").files,
            ...chunkReport("src/b.ts", "Survived").files,
          },
        }),
      ]),
    ).toThrow(/src\/a\.ts, src\/b\.ts/);
  });
});

describe("mutation-merge main in-process", () => {
  const run = async (argv: readonly string[]) => {
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
      main(argv);

      return { ...calls, exitCode: process.exitCode };
    } finally {
      log.mockRestore();

      error.mockRestore();

      process.exitCode = undefined;
    }
  };

  it("prints the usage line for -h in-process", async () => {
    const result = await run(["-h"]);

    expect(result.log[0]).toContain("Usage: mutation-merge");
  });

  it("writes the merged report from argv", async () => {
    const { dir, first, second } = await writeChunkReports();
    const out = join(dir, "merged.json");

    const result = await run([out, first, second]);

    const merged = JSON.parse(await readFile(out, "utf8"));

    expect(
      `${Object.keys(merged.files).sort().join(",")}|${result.exitCode}`,
    ).toBe("src/a.ts,src/b.ts|undefined");
  });

  it("exits 1 with the missing-output message for no arguments", async () => {
    const result = await run([]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /missing <out\.json>.*\|1$/,
    );
  });

  it("exits 1 naming an unreadable chunk report", async () => {
    const { dir, first } = await writeChunkReports();

    const result = await run([
      join(dir, "merged.json"),
      first,
      join(dir, "absent.json"),
    ]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /absent\.json.*\|1$/,
    );
  });

  it("exits 1 naming --expect when its value is missing", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await run([
      join(dir, "merged.json"),
      first,
      second,
      "--expect",
    ]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /--expect requires an integer value\|1$/,
    );
  });

  it("exits 1 naming both counts when --expect misses inputs in-process", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await run([
      join(dir, "merged.json"),
      first,
      second,
      "--expect",
      "3",
    ]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /expected 3.*\|1$/,
    );
  });
});

describe("mergeReports overlap across later chunks", () => {
  it("throws when two later chunks mutate the same file", () => {
    expect(() =>
      mergeReports([
        JSON.stringify(chunkReport("src/first.ts", "Killed")),
        JSON.stringify(chunkReport("src/shared.ts", "Killed")),
        JSON.stringify(chunkReport("src/shared.ts", "Survived")),
      ]),
    ).toThrow(/src\/shared\.ts/);
  });
});

describe("mutation-merge --expect in-process", () => {
  const run = async (argv: readonly string[]) => {
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
      main(argv);

      return { ...calls, exitCode: process.exitCode };
    } finally {
      log.mockRestore();

      error.mockRestore();

      process.exitCode = undefined;
    }
  };

  it("exits 1 naming --expect when its value is not an integer", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await run([
      join(dir, "merged.json"),
      first,
      second,
      "--expect",
      "abc",
    ]);

    expect(`${result.error[0]}|${result.exitCode ?? 0}`).toMatch(
      /--expect requires an integer value\|1$/,
    );
  });

  it("merges and prints the summary when --expect matches", async () => {
    const { dir, first, second } = await writeChunkReports();

    const result = await run([
      join(dir, "merged.json"),
      first,
      second,
      "--expect",
      "2",
    ]);

    expect(`${result.log[0]}|${result.exitCode}`).toBe(
      "Merged 2 mutants across 2 files from 2 reports.|undefined",
    );
  });

  it("prints the usage line for --help in-process", async () => {
    const result = await run(["--help"]);

    expect(result.log[0]).toContain("Usage: mutation-merge");
  });
});
