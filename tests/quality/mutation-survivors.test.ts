import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  actionableLines,
  main,
  parseReport,
  printSurvivors,
} from "../../src/quality/mutation-survivors.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const report = {
  files: {
    "src/sync/config.ts": {
      mutants: [
        {
          mutatorName: "EqualityOperator",
          status: "Killed",
          location: { start: { line: 10 } },
        },
        {
          mutatorName: "StringLiteral",
          status: "Survived",
          location: { start: { line: 42 } },
        },
        {
          mutatorName: "ConditionalExpression",
          status: "Survived",
          location: { start: { line: 7 } },
        },
      ],
    },
    "src/sync/scan.ts": {
      mutants: [
        {
          mutatorName: "MethodExpression",
          status: "NoCoverage",
          location: { start: { line: 3 } },
        },
        {
          mutatorName: "ArrowFunction",
          status: "Timeout",
          location: { start: { line: 9 } },
        },
      ],
    },
  },
};

describe("parseReport", () => {
  it("parses a well-formed report into its files map", () => {
    const parsed = parseReport(JSON.stringify(report));

    expect(Object.keys(parsed.files)).toEqual([
      "src/sync/config.ts",
      "src/sync/scan.ts",
    ]);
  });

  it("throws a named shape error for a valid-JSON report whose shape drifted", () => {
    expect(() => parseReport('{"config": {}}')).toThrow(/unexpected shape/);
  });

  it("throws the shape error when a file entry lacks its mutants array", () => {
    expect(() => parseReport('{"files": {"src/a.ts": {}}}')).toThrow(
      /unexpected shape/,
    );
  });
});

describe("actionableLines", () => {
  it("lists exactly the survived and no-coverage mutants as file:line entries sorted by file and line", () => {
    expect(actionableLines(report)).toEqual([
      "Survived  src/sync/config.ts:7  ConditionalExpression",
      "Survived  src/sync/config.ts:42  StringLiteral",
      "NoCoverage  src/sync/scan.ts:3  MethodExpression",
    ]);
  });
});

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../bin/mutation-survivors.ts",
);

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<RunResult> {
  const child = spawn(process.execPath, [realpathSync(script), ...args], {
    stdio: "pipe",
    cwd,
  });

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("mutation-survivors CLI", () => {
  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: mutation-survivors \[-h \| --help\]/,
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runNode(["-h"])).out).toBe((await runNode(["--help"])).out);
  });

  it("prints help before reading the report, even with no report present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutsurv-"));
    const result = await runNode(["--help"], dir);

    tempDirs.push(dir);

    expect(result.code).toBe(0);
  });

  it("warns nothing for --help with no report present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutsurv-"));
    const result = await runNode(["--help"], dir);

    tempDirs.push(dir);

    expect(result.err).toBe("");
  });

  it("prints usage with no report present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutsurv-"));
    const result = await runNode(["--help"], dir);

    tempDirs.push(dir);

    expect(result.out).toContain("Usage: mutation-survivors");
  });

  it("exits 1 naming the drifted shape when the report is valid JSON but not a Stryker report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutsurv-"));

    tempDirs.push(dir);
    await mkdir(join(dir, "reports", "mutation"), { recursive: true });
    await writeFile(
      join(dir, "reports", "mutation", "mutation.json"),
      '{"config": {}}',
    );

    const result = await runNode([], dir);

    expect(result.code).toBe(1);
  });

  it("names the drifted shape in the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutsurv-"));

    tempDirs.push(dir);
    await mkdir(join(dir, "reports", "mutation"), { recursive: true });
    await writeFile(
      join(dir, "reports", "mutation", "mutation.json"),
      '{"config": {}}',
    );

    const result = await runNode([], dir);

    expect(result.err).toContain("unexpected shape");
  });
});

describe("parseReport shape edges", () => {
  it("rejects a null report root naming the missing files", () => {
    expect(() => parseReport("null")).toThrow(
      "mutation report has an unexpected shape (no files)",
    );
  });

  it("rejects a primitive report root naming the missing files", () => {
    expect(() => parseReport("42")).toThrow(
      "mutation report has an unexpected shape (no files)",
    );
  });

  it("rejects a report whose files value is null", () => {
    expect(() => parseReport('{"files": null}')).toThrow(
      "mutation report has an unexpected shape (no files)",
    );
  });

  it("rejects a report whose files value is not an object", () => {
    expect(() => parseReport('{"files": "x"}')).toThrow(
      "mutation report has an unexpected shape (no files)",
    );
  });

  it("rejects a file entry that is null", () => {
    expect(() => parseReport('{"files": {"src/a.ts": null}}')).toThrow(
      "mutation report has an unexpected shape (a file entry lacks its mutants array)",
    );
  });

  it("rejects a file entry that is not an object", () => {
    expect(() => parseReport('{"files": {"src/a.ts": 42}}')).toThrow(
      "mutation report has an unexpected shape (a file entry lacks its mutants array)",
    );
  });

  it("rejects a file entry whose mutants is not an array", () => {
    expect(() =>
      parseReport('{"files": {"src/a.ts": {"mutants": "x"}}}'),
    ).toThrow(
      "mutation report has an unexpected shape (a file entry lacks its mutants array)",
    );
  });
});

describe("printSurvivors", () => {
  it("prints the shape-drift hint and exits 1 for a valid-JSON non-report", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) =>
        errors.push(parts.join(" ")),
      );

    process.exitCode = undefined;

    try {
      printSurvivors('{"config": {}}');
      expect(errors[0]).toContain("unexpected shape");
    } finally {
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("exits 1 for a drifted-shape report", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      printSurvivors('{"config": {}}');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("prints the missing-report hint for text that is not valid JSON", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) =>
        errors.push(parts.join(" ")),
      );

    process.exitCode = undefined;

    try {
      printSurvivors("{not json");
      expect(errors[0]).toContain("No report at");
    } finally {
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("exits 1 for text that is not valid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      printSurvivors("{not json");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("prints the missing-report hint and exits 1 without a report text", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) =>
        errors.push(parts.join(" ")),
      );

    process.exitCode = undefined;

    try {
      printSurvivors(undefined);
      expect(errors[0]).toContain("No report at");
    } finally {
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("exits 1 without a report text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      printSurvivors(undefined);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("prints the actionable lines and keeps the exit code unset for a healthy report", () => {
    const out: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

    process.exitCode = undefined;

    try {
      printSurvivors(
        JSON.stringify({
          files: {
            "src/a.ts": {
              mutants: [
                {
                  mutatorName: "StringLiteral",
                  status: "Survived",
                  location: { start: { line: 3 } },
                },
              ],
            },
          },
        }),
      );
      expect(out.join("\n")).toContain("Survived  src/a.ts:3  StringLiteral");
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("keeps the exit code unset for a healthy report", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      printSurvivors(
        JSON.stringify({
          files: {
            "src/a.ts": {
              mutants: [
                {
                  mutatorName: "StringLiteral",
                  status: "Survived",
                  location: { start: { line: 3 } },
                },
              ],
            },
          },
        }),
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("prints the nothing-actionable line for a report whose mutants are all killed", () => {
    const out: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

    process.exitCode = undefined;

    try {
      printSurvivors(
        JSON.stringify({
          files: {
            "src/a.ts": {
              mutants: [
                {
                  mutatorName: "StringLiteral",
                  status: "Killed",
                  location: { start: { line: 3 } },
                },
              ],
            },
          },
        }),
      );
      expect(out.join("\n")).toContain(
        "No actionable mutants — nothing survived, nothing uncovered.",
      );
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("keeps the exit code unset for a report whose mutants are all killed", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      printSurvivors(
        JSON.stringify({
          files: {
            "src/a.ts": {
              mutants: [
                {
                  mutatorName: "StringLiteral",
                  status: "Killed",
                  location: { start: { line: 3 } },
                },
              ],
            },
          },
        }),
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });
});

describe("actionableLines file grouping", () => {
  it("orders same-file mutants by ascending line", () => {
    const lines = actionableLines({
      files: {
        "src/a.ts": {
          mutants: [
            {
              mutatorName: "Second",
              status: "Survived",
              location: { start: { line: 20 } },
            },
            {
              mutatorName: "First",
              status: "Survived",
              location: { start: { line: 5 } },
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      "Survived  src/a.ts:5  First",
      "Survived  src/a.ts:20  Second",
    ]);
  });

  it("orders files by ascending path regardless of insertion order", () => {
    const lines = actionableLines({
      files: {
        "src/z.ts": {
          mutants: [
            {
              mutatorName: "Zed",
              status: "Survived",
              location: { start: { line: 1 } },
            },
          ],
        },
        "src/a.ts": {
          mutants: [
            {
              mutatorName: "Ay",
              status: "Survived",
              location: { start: { line: 1 } },
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      "Survived  src/a.ts:1  Ay",
      "Survived  src/z.ts:1  Zed",
    ]);
  });
});

describe("mutation-survivors main in-process", () => {
  const withTempCwd = async (
    plantReport: (dir: string) => Promise<void>,
    run: () => void,
  ): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutsurv-cwd-"));

    // Faked, not chdir'd: process.chdir throws in the worker threads
    // Stryker's vitest runner uses, which killed every mutation dry
    // run once this suite landed.
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

    tempDirs.push(dir);
    await plantReport(dir);

    try {
      run();
    } finally {
      cwdSpy.mockRestore();
    }

    return dir;
  };

  it("reads and prints the report from the working directory for a bare run", async () => {
    const out: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const argv = process.argv;

    process.argv = [...argv.slice(0, 2)];
    process.exitCode = undefined;

    try {
      await withTempCwd(
        (dir) =>
          mkdir(join(dir, "reports", "mutation"), { recursive: true }).then(
            () =>
              writeFile(
                join(dir, "reports", "mutation", "mutation.json"),
                JSON.stringify(report),
              ),
          ),
        () => main(),
      );
      expect(out.join("\n")).toContain(
        "Survived  src/sync/config.ts:7  ConditionalExpression",
      );
    } finally {
      process.argv = argv;
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("prints the missing-report hint and exits 1 for a bare run without a report", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) =>
        errors.push(parts.join(" ")),
      );
    const argv = process.argv;

    process.argv = [...argv.slice(0, 2)];
    process.exitCode = undefined;

    try {
      await withTempCwd(
        async () => {},
        () => main(),
      );
      expect(`${errors[0]}|${process.exitCode}`).toMatch(/No report at.*\|1$/);
    } finally {
      process.argv = argv;
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });

  it("prints help for --help without reading any report", () => {
    const argv = process.argv;
    const out: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

    process.argv = [...argv.slice(0, 2), "--help"];
    process.exitCode = undefined;

    try {
      main();
      expect(out[0]).toContain("Usage: mutation-survivors");
    } finally {
      process.argv = argv;
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("leaves the exit code unset for --help", () => {
    const argv = process.argv;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.argv = [...argv.slice(0, 2), "--help"];
    process.exitCode = undefined;

    try {
      main();
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.argv = argv;
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });
});
