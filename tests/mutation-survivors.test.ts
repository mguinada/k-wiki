import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { actionableLines } from "../scripts/mutation-survivors.ts";

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
  "../scripts/mutation-survivors.ts",
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
    expect(result.err).toBe("");
    expect(result.out).toContain("Usage: mutation-survivors");
  });
});
