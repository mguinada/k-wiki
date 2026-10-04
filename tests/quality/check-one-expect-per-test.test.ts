import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeSource,
  checkTree,
  renderViolation,
  runCheck,
} from "../../src/quality/check-one-expect-per-test.ts";

/**
 * Fixture tests of the one-expectation-per-test gate itself (the
 * checker is a check, not a test — these are its tests): the specced
 * fixture set — clean file, two-expect violation, `it.each` pass,
 * helper-excluded expect, describe-nested its counted per innermost
 * callback — plus the counting semantics and exit codes 0/1/2.
 * Exit-code cases run the real dev launcher as a child process; the
 * counting cases drive the pure analyzer in-process.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(repoRoot, "dev", "check-one-expect-per-test.ts");

/** Temp fixture roots, removed after each case. */
const tempRoots: string[] = [];

afterEach(async () => {
  const roots = tempRoots.splice(0);

  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A fresh async temp dir, cleaned up at afterEach. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "one-expect-gate-"));

  tempRoots.push(root);

  return root;
}

/** A fresh sync temp dir with one fixture file, for launcher runs. */
function fixtureDirSync(name: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), "one-expect-gate-"));

  tempRoots.push(root);
  writeFileSync(join(root, name), source);

  return root;
}

/** Write one fixture file into a fresh temp dir, return the dir. */
async function fixtureDir(name: string, source: string): Promise<string> {
  const root = await tempRoot();

  await writeFile(join(root, name), source);

  return root;
}

/** Run the dev launcher, return [exit status, combined output]. */
function runLauncherCapture(args: string[]): [number, string] {
  try {
    const output = execFileSync(process.execPath, [launcher, ...args], {
      stdio: "pipe",
      encoding: "utf8",
    });

    return [0, output];
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };

    return [
      failure.status ?? -1,
      `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    ];
  }
}

describe("analyzeSource counting", () => {
  it("a clean single-expect file yields no violation", () => {
    const blocks = analyzeSource(
      `import { it, expect } from "vitest";\nit("rejects a malformed invoice", () => {\n  expect(parse("")).toBeNull();\n});\n`,
    );

    expect(blocks.map((block) => block.expectLines.length)).toEqual([1]);
  });

  it("a two-expect block is one violation naming both expect lines", () => {
    const blocks = analyzeSource(
      `it("loads the board", () => {\n  const board = load();\n  expect(board).toBeDefined();\n  expect(board.rows).toHaveLength(3);\n});\n`,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.expectLines).toEqual([3, 4]);
    expect(blocks[0]?.line).toBe(1);
  });

  it("an expect chain with several links counts once", () => {
    const blocks = analyzeSource(
      `it("chains", () => {\n  expect(name("x")).toBe("x").toMatch(/^x$/u);\n});\n`,
    );

    expect(blocks[0]?.expectLines).toHaveLength(1);
  });

  it("an expect static passed as a matcher argument is not a second expectation", () => {
    const blocks = analyzeSource(
      `it("matches", () => {\n  expect(list).toContainEqual(expect.stringMatching(/^x/u));\n});\n`,
    );

    expect(blocks[0]?.expectLines).toHaveLength(1);
  });

  it("an it.each body with one expect passes — one case, one behavior", () => {
    const blocks = analyzeSource(
      `it.each([1, 2, 3])("accepts %s", (n) => {\n  expect(accept(n)).toBe(true);\n});\n`,
    );

    expect(blocks[0]?.expectLines).toHaveLength(1);
  });

  it("an it.each body with two expects violates — counted per generated case", () => {
    const blocks = analyzeSource(
      `it.each([1, 2])("checks %s", (n) => {\n  expect(accept(n)).toBe(true);\n  expect(n).toBeGreaterThan(0);\n});\n`,
    );

    expect(blocks[0]?.expectLines).toHaveLength(2);
  });

  it("an expect inside a locally-defined helper is out of scope", () => {
    const blocks = analyzeSource(
      `it("delegates to the helper", () => {\n  const check = (value: number) => {\n    expect(value).toBeGreaterThan(0);\n  };\n  check(1);\n  expect(1).toBe(1);\n});\n`,
    );

    expect(blocks[0]?.expectLines).toHaveLength(1);
  });

  it("describe-nested its are counted per innermost callback", () => {
    const blocks = analyzeSource(
      `describe("board", () => {\n  it("loads", () => {\n    expect(load()).toBeDefined();\n  });\n  it("rejects a stale token", () => {\n    expect(load("stale")).toBeNull();\n  });\n});\n`,
    );

    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.expectLines.length)).toEqual([1, 1]);
  });

  it("a nested it callback's expects stay out of the parent's count", () => {
    const blocks = analyzeSource(
      `it("outer", () => {\n  expect(1).toBe(1);\n  it("inner", () => {\n    expect(2).toBe(2);\n  });\n});\n`,
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.expectLines).toHaveLength(1);
    expect(blocks[1]?.expectLines).toHaveLength(1);
  });

  it("a block without a callback body counts zero expectations", () => {
    const blocks = analyzeSource(`it.todo("implements rejection");\n`);

    expect(blocks[0]?.expectLines).toHaveLength(0);
  });

  it("a template-literal title is kept, a dynamic one reads as <dynamic>", () => {
    const blocks = analyzeSource(
      "it(`loads the board`, () => {\n  expect(load()).toBeDefined();\n});\nit(title(3), () => {\n  expect(load()).toBeDefined();\n  expect(load()).toBeDefined();\n});\n",
    );

    expect(blocks[0]?.title).toBe("loads the board");
    expect(blocks[1]?.title).toBe("<dynamic>");
  });
});

describe("checkTree and rendering", () => {
  it("a directory with one clean file reports zero violations", async () => {
    const report = await checkTree(
      await fixtureDir(
        "clean.test.ts",
        `it("works", () => {\n  expect(1).toBe(1);\n});\n`,
      ),
    );

    expect(report.violations).toEqual([]);
    expect(report.files).toBe(1);
  });

  it("an empty directory is healthy-empty", async () => {
    expect((await checkTree(await tempRoot())).violations).toEqual([]);
  });

  it("the e2e directory is skipped entirely", async () => {
    const root = await tempRoot();

    await writeFile(
      join(root, "deep.test.ts"),
      `it("two behaviors", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n`,
    );
    await mkdir(join(root, "e2e"), { recursive: true });
    await writeFile(
      join(root, "e2e", "journey.e2e.test.ts"),
      `it("journey", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n`,
    );

    const report = await checkTree(root);

    expect(report.files).toBe(1);
    expect(report.violations).toHaveLength(1);
  });

  it("non-test files are not scanned", async () => {
    const root = await tempRoot();

    await writeFile(join(root, "helpers.ts"), "export const x = 1;\n");

    expect((await checkTree(root)).files).toBe(0);
  });

  it("violations sort by file then line and render the locator format", async () => {
    const root = await tempRoot();

    await writeFile(
      join(root, "b-second.test.ts"),
      `it("second file, first block", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n`,
    );
    await writeFile(
      join(root, "a-first.test.ts"),
      `it("alpha", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\nit("beta", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n`,
    );

    const report = await checkTree(root);
    const display = (name: string) => relative(process.cwd(), join(root, name));

    expect(report.violations.map((v) => [v.file, v.line])).toEqual([
      [display("a-first.test.ts"), 1],
      [display("a-first.test.ts"), 5],
      [display("b-second.test.ts"), 1],
    ]);
    expect(renderViolation(report.violations[0]!)).toBe(
      `VIOLATION ${display("a-first.test.ts")}:1 it "alpha": 2 expects (2,3); standard 1`,
    );
  });

  it("the locator line matches the specced format byte for byte", () => {
    expect(
      renderViolation({
        file: "tests/board-triage.test.ts",
        line: 12,
        kind: "it",
        title: "loads board",
        expectCount: 3,
        expectLines: [14, 18, 22],
      }),
    ).toBe(
      'VIOLATION tests/board-triage.test.ts:12 it "loads board": 3 expects (14,18,22); standard 1',
    );
  });

  it("runCheck prints the prescription once and returns 1 on violations", async ({
    onTestFinished,
  }) => {
    const root = await fixtureDir(
      "broken.test.ts",
      `it("loads the board", () => {\n  expect(load()).toBeDefined();\n  expect(load().rows).toHaveLength(3);\n});\n`,
    );

    onTestFinished(() => {
      delete process.env.NO_COLOR;
    });

    process.env.NO_COLOR = "1";

    expect(await runCheck(root)).toBe(1);
  });
});

describe("exit codes through the launcher", () => {
  it("a clean tree exits 0 and prints one ok line", () => {
    const dir = fixtureDirSync(
      "clean.test.ts",
      `it("works", () => {\n  expect(1).toBe(1);\n});\n`,
    );

    const [status, output] = runLauncherCapture([dir]);

    expect(status).toBe(0);
    expect(output.replace(/\u001b\[\d+m/gu, "")).toMatch(
      /^ok: 1 test blocks across 1 file/u,
    );
  });

  it("a two-expect violation exits 1 with the locator and the prescription once", () => {
    const dir = fixtureDirSync(
      "broken.test.ts",
      `it("loads the board", () => {\n  expect(load()).toBeDefined();\n  expect(load().rows).toHaveLength(3);\n});\n`,
    );

    const [status, output] = runLauncherCapture([dir]);
    const plain = output.replace(/\u001b\[\d+m/gu, "");

    expect(status).toBe(1);
    expect(plain).toContain(
      'broken.test.ts:1 it "loads the board": 2 expects (2,3); standard 1',
    );
    expect(plain.match(/WHY /gu)).toHaveLength(1);
    expect(plain).toContain("keep EVERY assert");
    expect(plain).toContain("re-run until clean");
  });

  it("an unknown flag is a bad invocation — exit 2", () => {
    expect(runLauncherCapture(["--nope"])[0]).toBe(2);
  });

  it("a missing scan directory is a bad invocation — exit 2", () => {
    expect(
      runLauncherCapture([join(tmpdir(), "one-expect-gate-missing")])[0],
    ).toBe(2);
  });

  it("a file that does not parse fails the checker — exit 2", () => {
    const dir = fixtureDirSync("unparseable.test.ts", `it("broken", () => {\n`);

    const [status, output] = runLauncherCapture([dir]);

    expect(status).toBe(2);
    expect(output).toContain("unparseable.test.ts");
  });

  it("--help exits 0 and states the standard, scope, and exit codes", () => {
    const [status, output] = runLauncherCapture(["--help"]);

    expect(status).toBe(0);
    expect(output).toContain("one expectation per test block");
    expect(output).toContain("tests/e2e/");
    expect(output).toContain("Exit 2");
  });
});
