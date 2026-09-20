import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { isIsoDate, readDateFlag } from "../src/cli/flag-args.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { assertCleanTree } from "../src/data/git.ts";
import { prependWikiLog } from "../src/wiki/wiki-log.ts";

/**
 * One-way log.md inverter (issue #369): reorders a wiki/log.md from
 * oldest-first to newest-first — the log's entries reverse, every
 * entry stays byte-identical, and the run's own audit entry lands on
 * top. Lossless by construction and by verification: the log is
 * parsed into its header, byte-exact entries, inter-entry
 * separators, and file tail; only the entry order reverses, plus
 * one deterministic header rewrite — a legacy "Append-only."
 * standing comment's opening becomes "Prepend-only (newest-first).",
 * scoped to the header region so comments inside entry bodies are
 * never touched; the permutation property (entry count equal, sorted
 * entries byte-identical, everything else untouched) is verified before
 * the write, and the file on disk is re-read afterwards and
 * matched byte-exact against the verified inversion plus its
 * audit entry — the header and file ending take the shared
 * writer's normalized form by design. One-way:
 * no flag can produce oldest-first output — a log that already runs
 * newest-first (or carries a prior `log-inversion` audit entry) is a
 * clean exit-0 no-op, and a log whose dates run out of order in both
 * directions is refused, never guessed at. Safety envelope modeled
 * on backfill-origin: dry-run by default; `--write` refuses a dirty
 * tree so the clean git diff stays the review surface and
 * `git restore` the revert.
 */

/** The parsed log: header, byte-exact entries, and the newline runs
 *  that separate them — reassembling the four re-creates the file. */
export interface ParsedLog {
  /** Bytes before the first `## [` entry (includes `# Wiki Log\n` and the blank line after it). */
  readonly header: string;
  /** Entry blocks split on `^## \[` headings: heading through last non-newline byte, blank lines inside included. */
  readonly entries: readonly string[];
  /** The exact newline run between entry i and entry i+1. */
  readonly separators: readonly string[];
  /** The exact newline run ending the file after the last entry. */
  readonly tail: string;
}

/** One entry's `## [YYYY-MM-DD] <operation> | <title>` heading date. */
const ENTRY_DATE = /^## \[(\d{4}-\d{2}-\d{2})\]/;

/** The operation name of one entry's heading. */
const ENTRY_OPERATION = /^## \[\d{4}-\d{2}-\d{2}\] ([^|\n]+) \|/;

/** The audit operation this tool writes (issue #369's convention). */
const INVERSION_OPERATION = "log-inversion";

/** The legacy standing comment the header may carry: its
 *  "Append-only." opening becomes the prepend-only form — the one
 *  header rewrite the inversion performs. */
const LEGACY_APPEND_COMMENT = /(<!--\s*)Append-only\./;

/** Deterministically migrate a header's legacy standing comment:
 *  the "Append-only." opening of an HTML comment above every entry
 *  becomes "Prepend-only (newest-first)." Scoped to the header
 *  region by construction — the caller only ever passes the bytes
 *  before the first `## [` entry, so comments inside entry bodies
 *  (immutable history) are never touched. */
export function migrateLogHeader(header: string): string {
  return header.replace(
    LEGACY_APPEND_COMMENT,
    "$1Prepend-only (newest-first).",
  );
}

/** Parse a log into its lossless parts. Empty entries list means the
 *  log holds nothing to invert (the header swallows the whole text). */
export function parseWikiLog(text: string): ParsedLog {
  const starts: number[] = [];
  const heading = /^## \[/gm;

  for (
    let match = heading.exec(text);
    match !== null;
    match = heading.exec(text)
  ) {
    starts.push(match.index);
  }

  if (starts.length === 0) {
    return { header: text, entries: [], separators: [], tail: "" };
  }

  const header = text.slice(0, starts[0]);
  const entries: string[] = [];
  const separators: string[] = [];
  let tail = "";

  starts.forEach((start, index) => {
    const raw = text.slice(start, starts[index + 1] ?? text.length);
    const entry = raw.replace(/\n+$/, "");
    const newlineRun = raw.slice(entry.length);

    entries.push(entry);

    if (index + 1 < starts.length) {
      separators.push(newlineRun);
    } else {
      tail = newlineRun;
    }
  });

  return { header, entries, separators, tail };
}

/** Reassemble a parsed log with its entries reversed: the header,
 *  separators, and tail are reused verbatim, so the output is a pure
 *  permutation of the input's byte runs. */
export function invertWikiLog(parsed: ParsedLog): string {
  const parts: string[] = [parsed.header];
  const entries = [...parsed.entries].reverse();

  entries.forEach((entry, index) => {
    parts.push(entry, parsed.separators[index] ?? parsed.tail);
  });

  return parts.join("");
}

/** The date order of a log's entries. */
export type LogDirection = "newest-first" | "oldest-first" | "ambiguous";

/** Classify entry order by heading dates: non-increasing top-down is
 *  newest-first, non-decreasing is oldest-first, anything else runs
 *  out of order in both directions and is ambiguous — never guessed. */
export function logDirection(entries: readonly string[]): LogDirection {
  const dates = entries.map((entry) => {
    const date = ENTRY_DATE.exec(entry)?.[1];

    if (date === undefined) {
      throw new Error(
        `entry has no parseable date heading: ${entry.split("\n")[0]}`,
      );
    }

    return date;
  });

  const nonIncreasing = dates.every(
    (date, index) => date >= (dates[index + 1] ?? date),
  );

  if (nonIncreasing) {
    return "newest-first";
  }

  const nonDecreasing = dates.every(
    (date, index) => date <= (dates[index + 1] ?? date),
  );

  return nonDecreasing ? "oldest-first" : "ambiguous";
}

/** Whether any entry is this tool's own audit entry — proof a prior
 *  run already migrated the log (guard 1 of the one-way contract). */
function carriesInversionAudit(entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const operation = ENTRY_OPERATION.exec(entry)?.[1];

    return operation?.trim() === INVERSION_OPERATION;
  });
}

/** Verify the pure-permutation property of the pre-write inversion:
 *  same entry count, sorted entries byte-identical, header,
 *  separators, and tail untouched. Throws (never writes) on any
 *  mismatch. */
function verifyPermutation(before: ParsedLog, after: ParsedLog): void {
  const sorted = (entries: readonly string[]): string[] => [...entries].sort();
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  if (
    before.entries.length !== after.entries.length ||
    !same(sorted(before.entries), sorted(after.entries)) ||
    before.header !== after.header ||
    !same(before.separators, after.separators) ||
    before.tail !== after.tail
  ) {
    throw new Error("lossless gate failed (before write) — refusing to write");
  }
}

/** Verify the written log's entries: the audit entry on top, the
 *  original entries below it reversed and byte-identical. The header
 *  and file ending take prependWikiLog's normalized forms by design;
 *  the disk text is verified byte-exactly by the caller. Throws on
 *  any mismatch. */
function verifyWrittenLog(
  original: ParsedLog,
  written: ParsedLog,
  audit: string,
): void {
  const expected = [audit, ...[...original.entries].reverse()];

  if (
    written.entries.length !== expected.length ||
    written.entries.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      "lossless gate failed (after write) — log is not the pure inversion plus the audit entry",
    );
  }
}

export interface InvertOptions {
  /** The date written into the run's audit entry. */
  readonly date: string;
  /** Perform the inversion and write log.md; without it, report only. */
  readonly write?: boolean | undefined;
}

/** A completed run: inverted (written or previewed, with the
 *  standing comment migrated when the header carried the legacy
 *  form) or a no-op. */
export type InvertReport =
  | {
      readonly outcome: "inverted";
      readonly entries: number;
      readonly written: boolean;
      readonly commentMigrated: boolean;
    }
  | {
      readonly outcome: "no-op";
      readonly entries: number;
      readonly reason: "log absent" | "log-inversion" | "newest-first";
    };

/** Refuse an audit date older than the entry that will sit below
 *  it: a stale `--date` (or a default run against a future-typo'd
 *  log) would write a log that is neither newest-first nor
 *  oldest-first while reporting success — and the idempotency
 *  guard would then mask it forever. */
function assertAuditDateNotStale(
  entries: readonly string[],
  date: string,
): void {
  const newestAfterInversion = ENTRY_DATE.exec(
    entries[entries.length - 1] ?? "",
  )?.[1];

  if (newestAfterInversion !== undefined && date < newestAfterInversion) {
    throw new Error(
      `audit date ${date} sorts before the newest entry ${newestAfterInversion} — the written log would not be newest-first; use a --date on or after ${newestAfterInversion}`,
    );
  }
}

/** Invert `wikiDir/log.md` to newest-first under the full safety
 *  envelope. Throws on refusals (ambiguous order, dirty tree, a
 *  failed lossless gate, a missing wiki dir); resolves no-op for a
 *  log that has nothing to invert. */
export async function invertLog(
  wikiDirInput: string,
  options: InvertOptions,
): Promise<InvertReport> {
  const wikiDir = resolve(wikiDirInput);

  await assertDirectory(wikiDir, "wiki");

  const logPath = join(wikiDir, "log.md");
  const text = await readFile(logPath, "utf8").catch(() => undefined);

  if (text === undefined) {
    return { outcome: "no-op", entries: 0, reason: "log absent" };
  }

  const parsed = parseWikiLog(text);

  if (parsed.entries.length === 0) {
    return { outcome: "no-op", entries: 0, reason: "newest-first" };
  }

  if (carriesInversionAudit(parsed.entries)) {
    return {
      outcome: "no-op",
      entries: parsed.entries.length,
      reason: "log-inversion",
    };
  }

  const direction = logDirection(parsed.entries);

  if (direction === "newest-first") {
    return {
      outcome: "no-op",
      entries: parsed.entries.length,
      reason: "newest-first",
    };
  }

  if (direction === "ambiguous") {
    throw new Error(
      "entry dates run out of order in both directions — direction is ambiguous, fix the dates first",
    );
  }

  const migrated = { ...parsed, header: migrateLogHeader(parsed.header) };
  const invertedText = invertWikiLog(migrated);

  assertAuditDateNotStale(parsed.entries, options.date);

  verifyPermutation(migrated, parseWikiLog(invertedText));

  if (options.write !== true) {
    return {
      outcome: "inverted",
      entries: parsed.entries.length,
      written: false,
      commentMigrated: migrated.header !== parsed.header,
    };
  }

  await assertCleanTree(wikiDir, "invert-log");

  const count = parsed.entries.length;
  const audit = `## [${options.date}] ${INVERSION_OPERATION} | ${count} ${count === 1 ? "entry" : "entries"}`;
  const finalText = prependWikiLog(invertedText, audit);

  await writeFile(logPath, finalText, "utf8");

  const reread = await readFile(logPath, "utf8");

  if (reread !== finalText) {
    throw new Error(
      "lossless gate failed (after write) — file on disk differs from the verified inversion",
    );
  }

  verifyWrittenLog(parsed, parseWikiLog(reread), audit);

  return {
    outcome: "inverted",
    entries: count,
    written: true,
    commentMigrated: migrated.header !== parsed.header,
  };
}

/** Fail unless `dir` is a readable directory. */
async function assertDirectory(dir: string, label: string): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    throw new Error(`${label} directory does not exist: ${dir}`);
  }

  if (!isDirectory) {
    throw new Error(`${label} directory is not a directory: ${dir}`);
  }
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: invert-log [-h | --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]

Invert a wiki's log.md from oldest-first to newest-first: the entry
order reverses, every entry stays byte-identical, and the run's audit
entry ("## [<date>] log-inversion | N entries") lands on top. Works on
any wiki instance.

  <wiki-dir>  Wiki root holding log.md. Default: this repo's wiki/.
  --write     Perform the inversion and write log.md. Without it,
              report what would happen and write nothing (default).
  --date      Date of the audit entry. Default: today.
  -h, --help  Print this help and exit; no side effects.

Lossless gate: the log is parsed into its header, byte-exact entries,
separators, and tail; only the entry order reverses — plus one
deterministic header rewrite: a legacy "<!-- Append-only. ... -->"
standing comment's opening becomes "Prepend-only (newest-first).",
scoped above every entry so comments inside entry bodies are never
rewritten; a run that migrated the comment says so in its summary.
The permutation property (same entry count, sorted entries
byte-identical, everything else untouched) is verified before the
write — any mismatch refuses
it. After the write, the file on disk is re-read and matched
byte-exact against the verified inversion plus its audit entry (the
header and file ending take the shared writer's normalized form by
design).

One-way: no flag can produce oldest-first output. A log that already
runs newest-first (non-increasing dates top-down) or carries a prior
log-inversion audit entry is a clean exit-0 no-op. A log whose dates
run out of order in both directions is refused (exit 1) — direction
is ambiguous, never guessed. Reverting to oldest-first is git
history's job.

Safety: --write refuses a wiki tree with uncommitted changes (the
clean git diff is the review surface; git restore is the revert);
outside a git repo it warns and proceeds. Exit 0 after a run or a
no-op; exit 1 on any refusal. NO_COLOR disables color.`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** invert-log entry point: `invert-log [-h | --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const write = args.includes("--write");
  const { date, consumed } = readDateFlag(args);
  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (arg === "--write" || consumed.has(index)) {
      continue;
    }

    positional.push(arg);
  }

  if (
    positional.length > 1 ||
    (positional.length > 0 && positional.some((arg) => arg.startsWith("--"))) ||
    !isIsoDate(date)
  ) {
    console.error(colors().red("invert-log: bad arguments (see --help)"));
    process.exitCode = 1;

    return;
  }

  const wikiDir = positional[0] ?? join(repoRoot, "wiki");

  try {
    const report = await invertLog(wikiDir, { date, write });

    if (report.outcome === "no-op") {
      console.log(
        colors().dim(
          `invert-log: nothing to do (${report.reason}, ${report.entries} entries) — log stays as-is`,
        ),
      );

      return;
    }

    const summary = `${report.entries} entries verified lossless, audit entry on top`;
    const comment = report.commentMigrated
      ? ", standing comment migrated to prepend-only"
      : "";
    const suffix = report.written ? "" : " — dry run, nothing written";

    console.log(
      report.written
        ? colors().green(`invert-log: inverted — ${summary}${comment}`)
        : colors().dim(
            `invert-log: would invert — ${summary}${comment}${suffix}`,
          ),
    );
  } catch (error) {
    console.error(colors().red(`invert-log: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/invert-log.ts` runs */
refuseDirectExecution(import.meta.url, "invert-log", "bin/libexec");
