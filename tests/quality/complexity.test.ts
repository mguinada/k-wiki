import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CYCLOMATIC_LIMIT,
  CYCLOMATIC_WARN,
  type EngineReport,
  gateChanged,
  parseEngineReport,
  renderDebtReport,
  renderGateReport,
  runEngine,
} from "../../src/quality/complexity.ts";
import {
  collectChangedFiles,
  type FileDiff,
  type GitText,
} from "../../src/quality/mutation-scope.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const realGit: GitText = (args) =>
  execFileSync("git", args, { encoding: "utf8", cwd: repoRoot });

/** Paths the engine suppresses by omission — the files.exclude list the
 *  engine itself reads from .complexityguard.json. */
function excludedPaths(): Set<string> {
  const config = JSON.parse(
    readFileSync(join(repoRoot, ".complexityguard.json"), "utf8"),
  ) as { files?: { exclude?: string[] } };

  return new Set(config.files?.exclude ?? []);
}

/** Engine JSON shaped exactly like `complexity-guard -f json` output. */
const ENGINE_JSON = `{
  "version": "0.10.0",
  "files": [
    {
      "path": "src/a.ts",
      "functions": [
        { "name": "legacyBig", "start_line": 10, "end_line": 50, "cyclomatic": 30 },
        { "name": "smallTouched", "start_line": 60, "end_line": 70, "cyclomatic": 3 }
      ]
    },
    {
      "path": "src/b.ts",
      "functions": [
        { "name": "overNew", "start_line": 5, "end_line": 9, "cyclomatic": 11 },
        { "name": "warnTier", "start_line": 12, "end_line": 16, "cyclomatic": 9 },
        { "name": "atLimit", "start_line": 20, "end_line": 24, "cyclomatic": 10 }
      ]
    }
  ]
}`;

const REPORT: EngineReport = parseEngineReport(ENGINE_JSON);

/** A new file (ranges null) plus a legacy file touched at one hunk. */
const CHANGED: readonly FileDiff[] = [
  { path: "src/a.ts", ranges: [{ start: 60, end: 60 }] },
  { path: "src/b.ts", ranges: null },
];

describe("parseEngineReport", () => {
  it("reads name, line extent, and cyclomatic score per function", () => {
    const fn = parseEngineReport(ENGINE_JSON).files[0]?.functions[0];

    expect(fn).toEqual({
      name: "legacyBig",
      start_line: 10,
      end_line: 50,
      cyclomatic: 30,
    });
  });

  it("yields no files for empty engine output", () => {
    expect(parseEngineReport('{"files": []}').files).toEqual([]);
  });

  it("throws when a function's cyclomatic score is missing", () => {
    const drifted = ENGINE_JSON.replace('"cyclomatic": 30', '"cyclo": 30');

    expect(() => parseEngineReport(drifted)).toThrow(
      /shape not recognized/,
    );
  });

  it("throws when the report carries no files array", () => {
    expect(() => parseEngineReport("{}")).toThrow(/shape not recognized/);
  });

  it("throws when a file entry carries no functions array", () => {
    const json = '{"files": [{"path": "src/a.ts"}]}';

    expect(() => parseEngineReport(json)).toThrow(/shape not recognized/);
  });

  it("throws when a function's line extent is missing", () => {
    const drifted = ENGINE_JSON.replace(
      '"name": "legacyBig", "start_line": 10, "end_line": 50, ',
      '"name": "legacyBig", ',
    );

    expect(() => parseEngineReport(drifted)).toThrow(
      /function legacyBig in src\/a\.ts/,
    );
  });
});

describe("gateChanged", () => {
  it("passes a legacy over-limit function whose lines the change does not touch", () => {
    expect(gateChanged(REPORT, CHANGED).violations).toEqual([
      {
        path: "src/b.ts",
        line: 5,
        name: "overNew",
        cyclomatic: 11,
      },
    ]);
  });

  it("fails an over-limit function whose extent intersects a changed hunk", () => {
    const changed: readonly FileDiff[] = [
      { path: "src/a.ts", ranges: [{ start: 48, end: 52 }] },
    ];

    expect(gateChanged(REPORT, changed).violations.map((v) => v.name)).toEqual([
      "legacyBig",
    ]);
  });

  it("gates a new or untracked file whole", () => {
    const changed: readonly FileDiff[] = [{ path: "src/b.ts", ranges: null }];

    expect(gateChanged(REPORT, changed).functionsGated).toBe(3);
  });

  it("passes a function at exactly the limit", () => {
    const changed: readonly FileDiff[] = [
      { path: "src/b.ts", ranges: [{ start: 20, end: 24 }] },
    ];

    expect(gateChanged(REPORT, changed).violations).toEqual([]);
  });

  it("reports a changed function above the warning tier as a warning, not a violation", () => {
    const changed: readonly FileDiff[] = [
      { path: "src/b.ts", ranges: [{ start: 12, end: 16 }] },
    ];
    const result = gateChanged(REPORT, changed);

    expect(`${result.violations.length}|${result.warnings[0]?.name}`).toBe(
      "0|warnTier",
    );
  });

  it("counts only changed files and only gated functions in the summary", () => {
    const result = gateChanged(REPORT, [
      { path: "src/a.ts", ranges: [{ start: 60, end: 60 }] },
    ]);

    expect(`${result.filesChecked}|${result.functionsGated}`).toBe("1|1");
  });
});

describe("renderGateReport", () => {
  const result = gateChanged(REPORT, CHANGED);
  const text = renderGateReport(result);

  it("names path:line, function, score, and limit for each violation", () => {
    expect(text).toContain("src/b.ts:5  overNew  cyclomatic 11 > 10");
  });

  it("states the refactor instruction, not a suppression hint", () => {
    expect(text).toContain("Refactor overNew");
  });

  it("prints the per-run summary with files, functions, and counts", () => {
    expect(text).toContain("checked 2 files, 4 functions gated");
  });

  it("prints clean and green when no violation exists", () => {
    const clean = gateChanged(REPORT, [
      { path: "src/a.ts", ranges: [{ start: 60, end: 60 }] },
    ]);

    expect(renderGateReport(clean)).toContain("complexity gate: clean");
  });
});

describe("renderDebtReport", () => {
  it("lists functions worst-first", () => {
    const lines = renderDebtReport(REPORT).split("\n");

    expect(lines[1]).toContain("legacyBig");
  });

  it("counts functions over the limit and over the warning tier", () => {
    expect(renderDebtReport(REPORT)).toContain(
      "5 functions, 2 over 10, 4 over 8",
    );
  });
});

describe("complexity gate (live)", () => {
  it("the engine reports the repository's own quality library", () => {
    expect(
      runEngine([join("src", "quality", "complexity.ts")]).files.length,
    ).toBe(1);
  });

  it("changed code adds no function over the cyclomatic limit", ({ skip }) => {
    const changed = collectChangedFiles(realGit);

    if (changed.length === 0) {
      skip();

      return;
    }

    const report = runEngine(changed.map((file) => file.path));
    const result = gateChanged(report, changed);
    const text = renderGateReport(result);

    if (result.violations.length === 0) {
      console.log(text);
    }

    expect(result.violations, text).toEqual([]);
  });

  it("the engine reports every changed file the config does not exclude", ({ skip }) => {
    const changed = collectChangedFiles(realGit);

    if (changed.length === 0) {
      skip();

      return;
    }

    const report = runEngine(changed.map((file) => file.path));
    const reported = new Set(report.files.map((file) => file.path));
    const excluded = excludedPaths();
    const missing = changed
      .map((file) => file.path)
      .filter((path) => !excluded.has(path) && !reported.has(path));

    expect(
      missing,
      `engine omitted changed files (path drift?): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it.skipIf(process.env.COMPLEXITY_FULL !== "1")(
    "full-repo advisory debt report always passes",
    () => {
      console.log(renderDebtReport(runEngine([join("src", "")])));

      expect(CYCLOMATIC_LIMIT).toBe(CYCLOMATIC_WARN + 2);
    },
  );
});
