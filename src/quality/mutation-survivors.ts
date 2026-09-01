import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refuseDirectExecution } from "../cli/is-main.ts";

// Printer over the last Stryker JSON report (issue #21 advisory signal).
// Exit code is always 0 when a report exists: a non-zero exit on
// survivors would invite misuse as a gate, and mutation testing is
// advisory by design.

type Mutant = {
  mutatorName: string;

  status: string;

  location: { start: { line: number } };
};

type Report = { files: Record<string, { mutants: Mutant[] }> };

const REPORT_PATH = "reports/mutation/mutation.json";

const ACTIONABLE_STATUSES = new Set(["Survived", "NoCoverage"]);

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-survivors [-h | --help]

Re-list the actionable mutants (Survived, NoCoverage) from the last
Stryker JSON report at reports/mutation/mutation.json — no mutation
run, instant. Takes no arguments.

  -h, --help    Print this help and exit; no side effects.

Writes nothing. Exit 0 whenever a report parses — even with
survivors, because mutation testing is advisory and this printer
must stay unusable as a gate; exit 1 with a hint when no report
exists yet, when it is corrupt (not valid JSON), or when a Stryker
upgrade drifted its shape.`;

/** Actionable entries — Survived or NoCoverage — as sorted, readable lines. */
export function actionableLines(report: Report): string[] {
  const entries: {
    file: string;
    line: number;
    status: string;
    mutator: string;
  }[] = [];

  for (const [file, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      if (ACTIONABLE_STATUSES.has(mutant.status)) {
        entries.push({
          file,
          line: mutant.location.start.line,
          status: mutant.status,
          mutator: mutant.mutatorName,
        });
      }
    }
  }

  entries.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
  );

  return entries.map((e) => `${e.status}  ${e.file}:${e.line}  ${e.mutator}`);
}

/** Whether the parsed report root carries a `files` object. */
function isFilesMap(value: unknown): value is { files: object } {
  return (
    typeof value === "object" &&
    value !== null &&
    "files" in value &&
    typeof value.files === "object" &&
    value.files !== null
  );
}

/** Whether one `files` entry carries its `mutants` array. */
function entryHasMutants(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "mutants" in entry &&
    Array.isArray((entry as { mutants: unknown }).mutants)
  );
}

/** Parse and shape-check a Stryker report: every `files` entry
 *  must carry a `mutants` array — a Stryker upgrade that drifts the
 *  shape gets a diagnosable error, not a raw TypeError from deep in
 *  actionableLines. Throws on invalid JSON with the parse cause. */
export function parseReport(text: string): Report {
  const parsed: unknown = JSON.parse(text);

  if (!isFilesMap(parsed)) {
    throw new Error("mutation report has an unexpected shape (no files)");
  }

  for (const entry of Object.values(parsed.files)) {
    if (!entryHasMutants(entry)) {
      throw new Error(
        "mutation report has an unexpected shape (a file entry lacks its mutants array)",
      );
    }
  }

  return parsed as Report;
}

/** The report file's text, or undefined when it cannot be read. */
function readReportFile(baseDir: string): string | undefined {
  try {
    return readFileSync(join(baseDir, REPORT_PATH), "utf8");
  } catch {
    return undefined;
  }
}

/** Print the actionable mutants of one report file's text (or the
 *  missing-report hint for undefined); exported for in-process
 *  tests — spawned CLI children cannot exercise this branch under
 *  mutation. Always leaves the exit code at 0 when a report parses:
 *  mutation testing is advisory (issue #21). */
export function printSurvivors(text: string | undefined): void {
  if (text === undefined) {
    console.error(
      `No report at ${REPORT_PATH} — run npm run mutation:changed first.`,
    );
    process.exitCode = 1;

    return;
  }

  let report: Report;

  try {
    report = parseReport(text);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("unexpected shape")) {
      console.error(
        `The report at ${REPORT_PATH} has an unexpected shape — a Stryker upgrade changed the report format; ${cause.message}`,
      );
    } else {
      console.error(
        `The report at ${REPORT_PATH} is corrupt (not valid JSON) — re-run npm run mutation:changed to regenerate it.`,
      );
    }

    process.exitCode = 1;

    return;
  }

  const lines = actionableLines(report);

  if (lines.length === 0) {
    console.log("No actionable mutants — nothing survived, nothing uncovered.");

    return;
  }

  console.log(
    `Actionable mutants (${lines.length}) — kill or record as equivalent:`,
  );

  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

export function main(
  argv: readonly string[],
  baseDir: string = process.cwd(),
): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  printSurvivors(readReportFile(baseDir));
}

/* v8 ignore next: covered only under direct `node src/quality/mutation-survivors.ts` runs */
refuseDirectExecution(import.meta.url, "mutation-survivors", "dev");
