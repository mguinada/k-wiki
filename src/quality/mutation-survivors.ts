import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";
import {
  mutantIdentity,
  readSourceFrom,
  type SourceReader,
} from "./mutation-identity.ts";
import {
  parseRegistry,
  REGISTRY_FILENAME,
  type Registry,
  splitByRegistry,
} from "./mutation-registry.ts";

// Printer over the last Stryker JSON report (issue #21 advisory signal).
// Exit code is always 0 when a report exists: a non-zero exit on
// survivors would invite misuse as a gate, and mutation testing is
// advisory by design. Registry-recorded adjudications (issue #241)
// are filtered from the printed list and counted on their own line,
// so local triage and the CI filing agree on what is settled.

export type Mutant = {
  mutatorName: string;

  status: string;

  /** The sabotage text the mutator substitutes in — Stryker's JSON
   *  report carries it; sibling mutants of one mutator on one span
   *  (e.g. `<` → `<=` and `<` → `>=`) differ only by it. */
  replacement?: string | undefined;

  location: {
    start: { line: number; column?: number };
    end?: { line: number; column?: number };
  };
};

export type Report = { files: Record<string, { mutants: Mutant[] }> };

const REPORT_PATH = "reports/mutation/mutation.json";

const ACTIONABLE_STATUSES = new Set(["Survived", "NoCoverage"]);

export type ActionableEntry = {
  file: string;
  line: number;
  status: string;
  mutator: string;
};

export const isActionable = (status: string): boolean =>
  ACTIONABLE_STATUSES.has(status);

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-survivors [--ids] [-h | --help]

Re-list the actionable mutants (Survived, NoCoverage) from the last
Stryker JSON report at reports/mutation/mutation.json — no mutation
run, instant. Mutants recorded in .mutants-registry.json under the
working directory are filtered out and counted as recorded
adjudications, so the printed list is the untriaged work queue.

  --ids         Prefix each listed mutant with its span identity —
                the key an adjudication is recorded under in the
                registry. Uncomputable identities print as -.

  -h, --help    Print this help and exit; no side effects.

Writes nothing but the list and counts. Exit 0 whenever a report
parses — even with survivors, because mutation testing is advisory
and this printer must stay unusable as a gate; exit 1 with a hint
when no report exists yet, when it is corrupt (not valid JSON), when
a Stryker upgrade drifted its shape, or when the registry file is
present but invalid.`;

/** File, then line, then mutator — the ledger and the survivors
 *  printer share one deterministic order. */
export function compareEntries(
  a: { file: string; line: number; mutator: string },
  b: { file: string; line: number; mutator: string },
): number {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }

  if (a.line !== b.line) {
    return a.line - b.line;
  }

  return a.mutator < b.mutator ? -1 : a.mutator > b.mutator ? 1 : 0;
}

/** The one rendered-line format: status, file:line, mutator. */
export function formatEntry(entry: ActionableEntry): string {
  return `${entry.status}  ${entry.file}:${entry.line}  ${entry.mutator}`;
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
 *  actionableEntries. Throws on invalid JSON with the parse cause. */
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

/** Actionable entries — Survived or NoCoverage — with each
 *  mutant's span identity attached when its source is readable. */
export function actionableEntries(
  report: Report,
  readSource: SourceReader,
): (ActionableEntry & { id?: string })[] {
  const entries: (ActionableEntry & { id?: string })[] = [];

  for (const [file, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      if (isActionable(mutant.status)) {
        const id = mutantIdentity(file, mutant, readSource);

        entries.push({
          file,
          line: mutant.location.start.line,
          status: mutant.status,
          mutator: mutant.mutatorName,
          ...(id === undefined ? {} : { id }),
        });
      }
    }
  }

  return entries.sort(compareEntries);
}

/** The registry file's text under the base directory, undefined when
 *  absent — a fresh repo has recorded no adjudication yet. */
function readRegistryFile(baseDir: string): string | undefined {
  try {
    return readFileSync(join(baseDir, REGISTRY_FILENAME), "utf8");
  } catch {
    return undefined;
  }
}

/** The read-side diagnosis for a report that fails to parse. */
function reportError(cause: unknown): string {
  if (cause instanceof Error && cause.message.includes("unexpected shape")) {
    return `The report at ${REPORT_PATH} has an unexpected shape — a Stryker upgrade changed the report format; ${cause.message}`;
  }

  return `The report at ${REPORT_PATH} is corrupt (not valid JSON) — re-run npm run mutation:changed to regenerate it.`;
}

/** Print one triage split: the untriaged work queue, then the
 *  recorded counts — recording a mutant moves it between counts,
 *  and the total never shrinks silently. */
function printSplit(
  split: ReturnType<typeof splitByRegistry>,
  withIds: boolean,
): void {
  const actionable =
    split.untriaged.length + split.equivalents.length + split.artifacts.length;

  if (actionable === 0) {
    console.log("No actionable mutants — nothing survived, nothing uncovered.");

    return;
  }

  if (split.untriaged.length === 0) {
    console.log(
      "No untriaged mutants — every actionable mutant is adjudicated.",
    );
  } else {
    console.log(
      `Untriaged mutants (${split.untriaged.length}) — kill or record as adjudicated:`,
    );

    for (const entry of split.untriaged) {
      const id = withIds ? `${entry.id ?? "-"}  ` : "";

      console.log(`  ${id}${formatEntry(entry)}`);
    }
  }

  const recorded = split.equivalents.length + split.artifacts.length;

  if (recorded > 0) {
    console.log(
      `Recorded adjudications (${recorded}) — filtered from the list above: ` +
        `${split.equivalents.length} equivalent, ${split.artifacts.length} artifact (${REGISTRY_FILENAME}).`,
    );
  }
}

/** Print the actionable mutants of one report file's text (or the
 *  missing-report hint for undefined); exported for in-process
 *  tests — spawned CLI children cannot exercise this branch under
 *  mutation. Registry-recorded adjudications are filtered out and
 *  counted on their own line. Always leaves the exit code at 0 when
 *  a report parses: mutation testing is advisory (issue #21). */
export function printSurvivors(
  text: string | undefined,
  baseDir: string = process.cwd(),
  withIds = false,
): void {
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
    console.error(reportError(cause));
    process.exitCode = 1;

    return;
  }

  let registry: Registry;

  try {
    registry = parseRegistry(readRegistryFile(baseDir));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;

    return;
  }

  printSplit(
    splitByRegistry(
      actionableEntries(report, readSourceFrom(baseDir)),
      registry,
    ),
    withIds,
  );
}

export function main(
  argv: readonly string[],
  baseDir: string = process.cwd(),
): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(argv, {
    boolean: ["--ids"],
    positionals: { max: 0, error: (arg) => `unexpected argument: ${arg}` },
  });

  if (parsed.error !== undefined) {
    console.error(errorMessage(parsed.error));
    process.exitCode = 1;

    return;
  }

  printSurvivors(readReportFile(baseDir), baseDir, parsed.flags.has("--ids"));
}

/* v8 ignore next: covered only under direct `node src/quality/mutation-survivors.ts` runs */
refuseDirectExecution(import.meta.url, "mutation-survivors", "dev");
