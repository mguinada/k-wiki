import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { terminalColors as colors } from "../cli/colors.ts";
import { repoRoot } from "../cli/shared.ts";
import { type FileDiff, mergeRanges } from "./mutation-scope.ts";

// Cyclomatic complexity gate (issue #178): pure library, no main() and
// no bin/ launcher by design — the gate runs as the vitest test
// tests/quality/complexity.test.ts, so the failing assertion message
// doubles as the agent-facing report. All repo-owned semantics live
// here (diff scoping via mutation-scope, threshold, rendering); the
// engine (complexity-guard) supplies per-function metrics only, so a
// broken or abandoned engine can be swapped without changing the npm
// scripts, the test, or CI shape.

/** Fail when a gated function's cyclomatic complexity exceeds this. */
export const CYCLOMATIC_LIMIT = 10;

/** Printed (non-failing) warning tier: functions above this, at or
 *  under the limit. */
export const CYCLOMATIC_WARN = 8;

/** One function as the engine reports it — the fields the gate uses. */
export interface EngineFunction {
  readonly name: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly cyclomatic: number;
}

export interface EngineReport {
  readonly files: readonly {
    readonly path: string;
    readonly functions: readonly EngineFunction[];
  }[];
}

export interface Violation {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly cyclomatic: number;
}

export interface GateResult {
  readonly violations: readonly Violation[];
  readonly warnings: readonly Violation[];
  readonly filesChecked: number;
  readonly functionsGated: number;
}

/** Parse `complexity-guard -f json` output into the fields the gate
 *  uses; a report whose shape has drifted throws instead of gating
 *  nothing silently. */
export function parseEngineReport(json: string): EngineReport {
  const parsed = JSON.parse(json) as { files?: unknown };

  if (!Array.isArray(parsed.files)) {
    throw engineShapeError("files");
  }

  return { files: parsed.files.map((file) => parseEngineFile(file)) };
}

function parseEngineFile(file: unknown): EngineReport["files"][number] {
  const entry = file as { path?: unknown; functions?: unknown };

  if (typeof entry.path !== "string" || !Array.isArray(entry.functions)) {
    throw engineShapeError(`file ${String(entry.path)}`);
  }

  const path: string = entry.path;

  return {
    path,
    functions: entry.functions.map((fn) => parseEngineFunction(path, fn)),
  };
}

function parseEngineFunction(path: string, fn: unknown): EngineFunction {
  const candidate = fn as Partial<EngineFunction>;

  if (
    typeof candidate.name !== "string" ||
    !isFiniteNumber(candidate.start_line) ||
    !isFiniteNumber(candidate.end_line) ||
    !isFiniteNumber(candidate.cyclomatic)
  ) {
    throw engineShapeError(`function ${String(candidate.name)} in ${path}`);
  }

  return candidate as EngineFunction;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function engineShapeError(where: string): Error {
  return new Error(
    `complexity-guard report shape not recognized at ${where} — engine output changed; adjust parseEngineReport in src/quality/complexity.ts`,
  );
}

/** Run the real engine over the given repo-relative paths. */
export function runEngine(paths: readonly string[]): EngineReport {
  const bin = join(repoRoot, "node_modules", ".bin", "complexity-guard");

  const out = execFileSync(
    bin,
    ["-f", "json", "--fail-on", "none", "--no-color", ...paths],
    { encoding: "utf8", cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );

  return parseEngineReport(out);
}

/** True when the function's line extent intersects any changed range;
 *  a null diff (new/untracked file, unparseable diff) gates whole. */
function gatedBy(
  fn: EngineFunction,
  ranges: readonly { start: number; end: number }[] | null,
): boolean {
  if (ranges === null) {
    return true;
  }

  return mergeRanges([...ranges]).some(
    (range) => fn.start_line <= range.end && fn.end_line >= range.start,
  );
}

/** Apply the threshold to every function a change touches. */
export function gateChanged(
  report: EngineReport,
  changed: readonly FileDiff[],
): GateResult {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];

  const changedByPath = new Map(changed.map((file) => [file.path, file]));

  let filesChecked = 0;
  let functionsGated = 0;

  for (const file of report.files) {
    const diff = changedByPath.get(file.path);

    if (diff === undefined) {
      continue;
    }

    filesChecked++;

    for (const fn of file.functions) {
      if (!gatedBy(fn, diff.ranges)) {
        continue;
      }

      functionsGated++;

      const entry: Violation = {
        path: file.path,
        line: fn.start_line,
        name: fn.name,
        cyclomatic: fn.cyclomatic,
      };

      if (fn.cyclomatic > CYCLOMATIC_LIMIT) {
        violations.push(entry);
      } else if (fn.cyclomatic > CYCLOMATIC_WARN) {
        warnings.push(entry);
      }
    }
  }

  return { violations, warnings, filesChecked, functionsGated };
}

const REFACTOR_ADVICE =
  "Refactor it: extract helpers, use table-driven dispatch, return early, or split generators into named steps. Do not suppress — a genuinely irreducible function gets a .complexityguard.json files.exclude entry justified in the PR body.";

function violationLine(v: Violation): string {
  return `${v.path}:${v.line}  ${v.name}  cyclomatic ${v.cyclomatic} > ${CYCLOMATIC_LIMIT}`;
}

/** The agent-facing changed-mode report; doubles as the vitest
 *  assertion message when the gate fails. */
export function renderGateReport(result: GateResult): string {
  const tone = colors();
  const lines: string[] = [];

  if (result.violations.length === 0) {
    lines.push(
      tone.green(
        `complexity gate: clean — ${result.functionsGated} functions checked (limit ${CYCLOMATIC_LIMIT})`,
      ),
    );
  } else {
    lines.push(
      tone.red(
        `complexity gate: ${result.violations.length} violation(s) over cyclomatic ${CYCLOMATIC_LIMIT} — refactor, do not suppress`,
      ),
    );

    for (const v of result.violations) {
      lines.push(tone.red(violationLine(v)));
      lines.push(`  Refactor ${v.name} — ${REFACTOR_ADVICE}`);
    }
  }

  for (const w of result.warnings) {
    lines.push(
      tone.yellow(
        `${w.path}:${w.line}  ${w.name}  cyclomatic ${w.cyclomatic} — warning tier (over ${CYCLOMATIC_WARN}, at or under ${CYCLOMATIC_LIMIT})`,
      ),
    );
  }

  lines.push(
    tone.dim(
      `checked ${result.filesChecked} files, ${result.functionsGated} functions gated: ${result.violations.length} violation(s), ${result.warnings.length} warning(s)`,
    ),
  );

  return lines.join("\n");
}

/** The advisory full-repo debt report, worst functions first. */
export function renderDebtReport(report: EngineReport): string {
  const tone = colors();

  const fns = report.files.flatMap((file) =>
    file.functions.map((fn) => ({ fn, path: file.path })),
  );

  const over = fns.filter((e) => e.fn.cyclomatic > CYCLOMATIC_LIMIT).length;
  const warned = fns.filter((e) => e.fn.cyclomatic > CYCLOMATIC_WARN).length;

  fns.sort((a, b) => b.fn.cyclomatic - a.fn.cyclomatic);

  const lines: string[] = [
    tone.bold(
      `complexity debt report (advisory, whole src/): ${fns.length} functions, ${over} over ${CYCLOMATIC_LIMIT}, ${warned} over ${CYCLOMATIC_WARN}`,
    ),
  ];

  for (const entry of fns.slice(0, 20)) {
    const score =
      entry.fn.cyclomatic > CYCLOMATIC_LIMIT
        ? tone.red(String(entry.fn.cyclomatic))
        : String(entry.fn.cyclomatic);

    lines.push(
      `  ${score.padStart(3)}  ${entry.path}:${entry.fn.start_line}  ${entry.fn.name}`,
    );
  }

  return lines.join("\n");
}
