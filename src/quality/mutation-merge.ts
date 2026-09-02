import { readFileSync, writeFileSync } from "node:fs";
import { errorMessage } from "../cli/colors.ts";
import { intFlagError } from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";
import { parseReport } from "./mutation-survivors.ts";

// Report stitching for chunked full mutation runs (issue #236): each
// CI chunk job mutates a disjoint slice of src/ (src/quality/
// mutation-chunk.ts) and reports its own mutation.json; this tool
// merges the chunk reports into the one mutation.json the
// mutation-report artifact and the mutants-report workflow consume.
// A missing chunk is never silently tolerated — CI passes --expect,
// so a cancelled chunk fails the merge instead of filing a partial
// full-run picture into the rolling survivor issue (#208).

type FileEntry = { mutants: unknown[] };

/** A chunk report: the files map plus every other top-level key
 *  (schemaVersion, thresholds, testFiles, ...) carried as-is. */
type ChunkReport = { files: Record<string, FileEntry> } & Record<
  string,
  unknown
>;

/** Parse and shape-check one chunk report, naming its 1-based input
 *  position when it is not a Stryker report. */
function parseChunk(text: string, position: number): ChunkReport {
  try {
    return parseReport(text) as ChunkReport;
  } catch (cause) {
    const detail = errorMessage(cause);

    throw new Error(`input ${position}: ${detail}`);
  }
}

/** Refuse chunk reports from different Stryker schema versions —
 *  merging across versions produces a report nothing can read. */
function checkSchemaVersion(first: ChunkReport, next: ChunkReport): void {
  const a = first.schemaVersion;
  const b = next.schemaVersion;

  if (a !== undefined && b !== undefined && a !== b) {
    throw new Error(
      `schema versions differ across chunk reports (${a} vs ${b}) — all chunks must run the same Stryker`,
    );
  }
}

/** Merge next's files into merged, throwing when a file was mutated
 *  by two chunks (the chunk split was not disjoint). */
function mergeFiles(
  merged: ChunkReport,
  seen: Set<string>,
  next: ChunkReport,
): void {
  const overlaps = Object.keys(next.files).filter((path) => seen.has(path));

  if (overlaps.length > 0) {
    throw new Error(
      `files mutated by more than one chunk: ${overlaps.join(", ")}`,
    );
  }

  for (const [path, entry] of Object.entries(next.files)) {
    merged.files[path] = entry;

    seen.add(path);
  }
}

/** Merge chunk report texts into one report's JSON text, carrying
 *  the first report's non-files keys unchanged. */
export function mergeReports(texts: readonly string[]): string {
  const reports = texts.map((text, position) => parseChunk(text, position + 1));

  const first = reports[0];

  if (first === undefined) {
    throw new Error("at least one report is required to merge");
  }

  const merged: ChunkReport = { ...first, files: { ...first.files } };

  const seen = new Set(Object.keys(merged.files));

  for (const report of reports.slice(1)) {
    checkSchemaVersion(first, report);

    mergeFiles(merged, seen, report);
  }

  return JSON.stringify(merged);
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-merge <out.json> <chunk.json>... [--expect <n>]
              [-h | --help]

Merge the mutation.json reports of a chunked full mutation run into
one Stryker report at <out.json>: the chunk file maps union into one
(mutated files are disjoint by construction — an overlap is an error),
and the first chunk's other top-level keys (schemaVersion, thresholds,
testFiles, ...) carry over unchanged.

  <out.json>      Path of the merged report to write.
  <chunk.json>    One mutation.json per chunk job, any order.
  --expect <n>    Fail unless exactly n chunk reports are given — CI
                  passes the chunk count so a cancelled or missing
                  chunk fails loudly instead of merging a partial
                  full-run picture. Default: no check.

  -h, --help      Print this help and exit without reading anything.

Writes <out.json> and prints a one-line summary (mutants, files,
reports) to stdout. Exit 1 — writing nothing — when an input cannot
be read, is not a Stryker report, mixes schema versions, mutates a
file twice, or misses the --expect count.`;

interface Options {
  outPath?: string | undefined;
  inputs: string[];
  expect?: number | undefined;
}

/** Parse argv through the shared CLI shell — unknown options are
 *  rejected, never read as input paths — and validate --expect with
 *  the shared int-flag helper; throws naming the malformed part. */
function mergeOptions(argv: readonly string[]): Options {
  const parsed = parseArgs(argv, { value: ["--expect"] });

  if (parsed.error !== undefined) {
    throw new Error(parsed.error);
  }

  if (parsed.values.has("--expect")) {
    const error = intFlagError("--expect", parsed.values.get("--expect"));

    if (error !== undefined) {
      throw new Error(error);
    }
  }

  const [outPath, ...inputs] = parsed.positional;

  return {
    outPath,
    inputs,
    expect: parsed.values.has("--expect")
      ? Number(parsed.values.get("--expect"))
      : undefined,
  };
}

/** The merged report's mutant count, for the summary line. */
function mutantCount(report: ChunkReport): number {
  return Object.values(report.files).reduce(
    (total, entry) => total + entry.mutants.length,
    0,
  );
}

/** Read every input, refuse a missing chunk when --expect is set,
 *  merge, write the output, and print the summary. */
function runMerge(options: Options): void {
  if (options.outPath === undefined) {
    console.error("missing <out.json> — see --help");
    process.exitCode = 1;

    return;
  }

  if (
    options.expect !== undefined &&
    options.inputs.length !== options.expect
  ) {
    console.error(
      `expected ${options.expect} chunk reports, got ${options.inputs.length} — a chunk job did not report; see its job log`,
    );
    process.exitCode = 1;

    return;
  }

  let mergedText: string;

  try {
    mergedText = mergeReports(
      options.inputs.map((path) => readFileSync(path, "utf8")),
    );
  } catch (cause) {
    console.error(errorMessage(cause));
    process.exitCode = 1;

    return;
  }

  writeFileSync(options.outPath, mergedText);

  const merged = JSON.parse(mergedText) as ChunkReport;

  console.log(
    `Merged ${mutantCount(merged)} mutants across ${
      Object.keys(merged.files).length
    } files from ${options.inputs.length} reports.`,
  );
}

export function main(argv: readonly string[]): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  try {
    runMerge(mergeOptions(argv));
  } catch (cause) {
    console.error(errorMessage(cause));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/quality/mutation-merge.ts` runs */
refuseDirectExecution(import.meta.url, "mutation-merge", "dev");
