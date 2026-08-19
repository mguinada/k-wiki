import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

/** Actionable entries — Survived or NoCoverage — as sorted, readable lines. */
export function actionableLines(report: Report): string[] {
  const entries: { file: string; line: number; status: string; mutator: string }[] = [];

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

function main(): void {
  let report: Report;

  try {
    report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as Report;
  } catch {
    console.error(`No report at ${REPORT_PATH} — run npm run mutation:changed first.`);

    process.exitCode = 1;

    return;
  }

  const lines = actionableLines(report);

  if (lines.length === 0) {
    console.log("No actionable mutants — nothing survived, nothing uncovered.");

    return;
  }

  console.log(`Actionable mutants (${lines.length}) — kill or record as equivalent:`);

  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
