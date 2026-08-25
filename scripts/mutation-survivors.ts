import { readFileSync } from "node:fs";
import { refuseDirectExecution } from "../src/cli/is-main.ts";

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

Writes nothing. Exit 0 whenever a report exists — even with
survivors, because mutation testing is advisory and this printer
must stay unusable as a gate; exit 1 with a hint when no report
exists yet.`;

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

export function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  let report: Report;

  try {
    report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as Report;
  } catch {
    console.error(
      `No report at ${REPORT_PATH} — run npm run mutation:changed first.`,
    );

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

/* v8 ignore next: covered only under direct `node scripts/mutation-survivors.ts` runs */
refuseDirectExecution(import.meta.url, "mutation-survivors");
