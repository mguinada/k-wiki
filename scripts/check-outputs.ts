import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, terminalColors } from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { listFiles } from "../src/cli/shared.ts";
import { type CliSpec, parseArgs } from "../src/cli/shell.ts";
import {
  cycleDayTitle,
  type DayFamily,
  type DaySection,
  lintDayTitle,
  type ParsedDayFile,
  parseDayFile,
} from "../src/sync/cycle-reports.ts";
import { scannedLines } from "../src/sync/fence-state.ts";
import {
  cycleLintReference,
  lintRunReference,
} from "../src/sync/report-references.ts";
import { outputsRelativeTarget } from "../src/wiki/outputs-links.ts";

/**
 * The outputs day-file checker (issue #459): validates the wiki-sync
 * report families in a data repo's outputs/ directory — the cycle
 * digests (`cycle-<date>.md`), the windowed lint day files
 * (`lint-<date>.md`), and the weekly full-sweep files
 * (`lint-<date>-full.md`) — over real files, mechanically. Legacy
 * (overwrite-era) day files are exempt until their first append
 * gives them the day-file shape.
 *
 * Prints one `file: problem` line per finding and exits 1; exits 0
 * with an ok summary when the checked formats hold. Writes nothing.
 */

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-outputs [-h | --help] [--mode <mode>] <outputs-dir>

Check the wiki-sync report day files in a data repo's outputs/
directory: the cycle digests (cycle-<YYYY-MM-DD>.md), the windowed
lint day files (lint-<YYYY-MM-DD>.md), and the weekly full-sweep
files (lint-<YYYY-MM-DD>-full.md). Files outside these families are
never read; a legacy-shape (overwrite-era) day file is exempt until
its first append gives it the day-file shape.

  --mode <mode>      Which checks run:
                     shape     the day-file format: exactly one day
                               H1 with the family's title and the
                               file's date; bounded sections numbered
                               by position in the family grammar
                               (Cycle N / Lint run N — <local ISO
                               timestamp> (<window>) for lint, or
                               N (pre-append)); a --- separator
                               between consecutive sections; every
                               heading inside a section strictly
                               deeper than the section heading
                               (pre-append bounds are grandfathered
                               legacy content); no supersession prose
                               on writer-owned surfaces.
                     citations the pair references: each cycle
                               section's lint reference resolves to
                               an existing lint day file and section;
                               each lint run section carries either
                               the standalone marker or a cycle
                               back-reference resolving to an
                               existing cycle file and section.
                               References are data-repo-relative
                               plain paths — an [[outputs/...]]
                               wikilink is a problem, never a link.
                     all       both (default).
  -h, --help         Print this help and exit; no side effects.
  <outputs-dir>      The outputs/ directory to check. Required.

Writes nothing. Prints one problem line per finding (red) to stderr
and exits 1; prints an ok summary (green) and exits 0 when the
checked formats hold. NO_COLOR disables color.`;

/** The CLI flag set: the --mode value flag and one <outputs-dir>. */
const CLI_SPEC = {
  value: ["--mode"],
  positionals: {
    max: 1,
    error: (_arg: string, count: number) =>
      `expected exactly one <outputs-dir> argument, got ${count}`,
  },
} as const satisfies CliSpec;

/** One day-file family: filename shape, grammar family, day title. */
interface Family {
  readonly pattern: RegExp;
  readonly kind: DayFamily;
  readonly mode: "window" | "full" | undefined;
}

const FAMILIES: readonly Family[] = [
  { pattern: /^cycle-\d{4}-\d{2}-\d{2}\.md$/, kind: "cycle", mode: undefined },
  { pattern: /^lint-\d{4}-\d{2}-\d{2}\.md$/, kind: "lint", mode: "window" },
  {
    pattern: /^lint-\d{4}-\d{2}-\d{2}-full\.md$/,
    kind: "lint",
    mode: "full",
  },
];

/** A parsed append-shape day file ready for checking. */
interface DayFile {
  readonly name: string;
  readonly family: Family;
  readonly parsed: ParsedDayFile;
  readonly text: string;
}

/** Which checks run. */
export type CheckMode = "shape" | "citations" | "all";

/** Check one outputs directory; returns one problem line per finding,
 *  `file: problem` with paths relative to the outputs directory. */
export async function checkOutputs(
  outputsDir: string,
  mode: CheckMode,
): Promise<readonly string[]> {
  const names = (await listFiles(outputsDir, "", { regularFilesOnly: true }))
    .filter((name) => FAMILIES.some((family) => family.pattern.test(name)))
    .sort();

  const problems: string[] = [];
  const files: DayFile[] = [];

  for (const name of names) {
    const family = familyOf(name);

    if (family === undefined) {
      continue;
    }

    const day = fileDate(name);

    if (day === undefined) {
      problems.push(`${name}: unparseable date in name`);

      continue;
    }

    const text = await readFile(join(outputsDir, name), "utf8");
    const expectedTitle = dayTitleOf(family, day);
    const parsed = parseDayFile(text, family.kind, expectedTitle);

    if (parsed.kind === "append") {
      files.push({ name, family, parsed: parsed.file, text });

      continue;
    }

    const firstLine = text.split("\n")[0] ?? "";

    if (firstLine === expectedTitle) {
      problems.push(`${name}: carries the day title but no bounded sections`);
    } else if (
      firstLine.startsWith(titlePrefix(family)) &&
      hasGrammarSection(text, family)
    ) {
      // A file with family-grammar sections under a family title of
      // the wrong date is a writer regression — never legacy content,
      // which carries neither the new title nor new sections.
      problems.push(`${name}: day title must be "${expectedTitle}"`);
    }
  }

  if (mode === "shape" || mode === "all") {
    for (const file of files) {
      problems.push(...shapeProblems(file));
    }
  }

  if (mode === "citations" || mode === "all") {
    for (const file of files) {
      problems.push(...(await citationProblems(file, files)));
    }

    for (const file of files) {
      if (file.text.includes("[[outputs/")) {
        problems.push(
          `${file.name}: carries an [[outputs/...]] wikilink — references are plain data-repo-relative paths`,
        );
      }
    }
  }

  return problems;
}

/** The family a day-file name belongs to. */
function familyOf(name: string): Family | undefined {
  return FAMILIES.find((family) => family.pattern.test(name));
}

/** The family's day H1 for a UTC day. */
function dayTitleOf(family: Family, date: Date): string {
  return family.kind === "cycle"
    ? cycleDayTitle(date)
    : lintDayTitle(family.mode ?? "window", date);
}

/** The family's day title up to the date — the prefix a writer-
 *  regression title shares with the expected one. */
function titlePrefix(family: Family): string {
  const title = dayTitleOf(family, new Date("2000-01-01T00:00:00.000Z"));

  return title.slice(0, -"2000-01-01".length);
}

/** Whether the text carries at least one family-grammar section. */
function hasGrammarSection(text: string, family: Family): boolean {
  return (
    parseDayFile(text, family.kind, text.split("\n")[0] ?? "").kind === "append"
  );
}

/** The file-family UTC day from the name, or undefined when the
 *  name's calendar date does not exist: a rolled-over or rejected
 *  parse both fail the round-trip against the name's digits. */
function fileDate(name: string): Date | undefined {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(name);

  if (match === null) {
    return undefined;
  }

  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const day = new Date(`${match[0]}T00:00:00.000Z`);
  const valid =
    day.getUTCFullYear() === y &&
    day.getUTCMonth() === m - 1 &&
    day.getUTCDate() === d;

  return valid ? day : undefined;
}

/** The shape-mode problems of one append-shape day file. */
function shapeProblems(file: DayFile): readonly string[] {
  const problems: string[] = [];
  const { name, parsed } = file;

  if (/supersed/i.test(parsed.title)) {
    problems.push(`${name}: the day title carries supersession prose`);
  }

  for (const [index, section] of parsed.sections.entries()) {
    problems.push(
      ...sectionShapeProblems(name, section, index, parsed.sections.length),
    );
  }

  return problems;
}

/** One section's shape problems: position numbering, separators,
 *  containment, and supersession prose on the heading. */
function sectionShapeProblems(
  name: string,
  section: DaySection,
  index: number,
  total: number,
): readonly string[] {
  const problems: string[] = [];
  const number = Number(/\d+/.exec(section.title)?.[0] ?? Number.NaN);

  if (number !== index + 1) {
    problems.push(
      `${name}: section ${index + 1} is numbered ${number}, expected ${index + 1} (sections number by position)`,
    );
  }

  if (/supersed/i.test(section.title)) {
    problems.push(`${name}: section heading carries supersession prose`);
  }

  if (!section.preAppend) {
    problems.push(...containmentProblems(name, section));
  }

  if (index + 1 < total) {
    const boundary = lastMeaningfulLine(section.body);

    if (boundary === undefined || boundary !== "---") {
      problems.push(`${name}: sections separate with a --- line`);
    }
  }

  return problems;
}

/** A section body's last non-blank line. */
function lastMeaningfulLine(body: string): string | undefined {
  const lines = body.split("\n").filter((line) => line.trim() !== "");

  return lines.at(-1)?.trim();
}

/** A non-pre-append section's containment problems: every heading
 *  strictly deeper than the section's H2, code-fenced lines exempt. */
function containmentProblems(
  name: string,
  section: DaySection,
): readonly string[] {
  const problems: string[] = [];

  for (const { line, hashes } of scannedLines(section.body)) {
    if (hashes > 0 && hashes < 3) {
      problems.push(`${name}: heading escapes its section — "${line.trim()}"`);
    }
  }

  return problems;
}

/** A citation-mode pass over one file: cycle→lint and lint→cycle
 *  references resolve against the sibling day files, and references
 *  stay plain data-repo-relative paths. */
async function citationProblems(
  file: DayFile,
  files: readonly DayFile[],
): Promise<readonly string[]> {
  const problems: string[] = [];

  for (const section of file.parsed.sections) {
    if (section.preAppend) {
      continue;
    }

    if (file.family.kind === "cycle") {
      const reference = cycleLintReference(section.body);

      if (reference !== undefined) {
        problems.push(
          ...(await resolveReference(file, files, section, {
            path: reference.path,
            sectionTitle: reference.sectionTitle,
            expectKind: "lint",
          })),
        );
      }
    } else {
      problems.push(...(await lintSectionProblems(file, files, section)));
    }
  }

  return problems;
}

/** One lint run section's back-reference, resolved. */
async function lintSectionProblems(
  file: DayFile,
  files: readonly DayFile[],
  section: DaySection,
): Promise<readonly string[]> {
  const reference = lintRunReference(section.body);

  if (reference.kind === "standalone") {
    return [];
  }

  if (reference.kind === "none") {
    return [
      `${file.name}: section "${section.title}" carries neither the standalone marker nor a cycle back-reference`,
    ];
  }

  return await resolveReference(file, files, section, {
    path: reference.path,
    sectionTitle: reference.sectionTitle,
    expectKind: "cycle",
  });
}

/** Resolve one reference: the target must be a relative in-outputs
 *  path of the expected family, exist, and carry the named section. */
async function resolveReference(
  file: DayFile,
  files: readonly DayFile[],
  section: DaySection,
  reference: {
    readonly path: string;
    readonly sectionTitle: string;
    readonly expectKind: DayFamily;
  },
): Promise<readonly string[]> {
  const where = `section "${section.title}"`;
  const relative = outputsRelativeTarget(reference.path);

  if (relative === undefined) {
    return [
      `${file.name}: ${where} names ${reference.path} — not a relative path inside outputs/`,
    ];
  }

  const target = files.find((candidate) => candidate.name === relative);

  if (target === undefined) {
    return [
      `${file.name}: ${where} references ${reference.path} — no such day file in the append shape`,
    ];
  }

  if (target.family.kind !== reference.expectKind) {
    return [
      `${file.name}: ${where} references ${reference.path} — expected a ${reference.expectKind} day file`,
    ];
  }

  const found = target.parsed.sections.some(
    (candidate) => candidate.title === reference.sectionTitle,
  );

  if (!found) {
    return [
      `${file.name}: ${where} references ${reference.path} — no section "${reference.sectionTitle}" there`,
    ];
  }

  return [];
}

/** check-outputs entry point: `check-outputs [-h | --help] [--mode <mode>] <outputs-dir>`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const { values, positional, error } = parseArgs(args, CLI_SPEC);

  if (error !== undefined) {
    console.error(terminalColors().red(`check-outputs: ${error}`));
    process.exitCode = 1;

    return;
  }

  const outputsDir = positional[0] ?? "";

  if (outputsDir === "") {
    console.error(
      terminalColors().red(
        "check-outputs: expected one <outputs-dir> argument",
      ),
    );
    process.exitCode = 1;

    return;
  }

  const mode = normalizeMode(values.get("--mode"));

  if (mode === undefined) {
    console.error(
      terminalColors().red(
        `check-outputs: unknown --mode ${values.get("--mode")} (shape, citations, all)`,
      ),
    );
    process.exitCode = 1;

    return;
  }

  try {
    const problems = await checkOutputs(outputsDir, mode);

    if (problems.length === 0) {
      console.log(terminalColors().green(`ok: day files checked (${mode})`));

      return;
    }

    for (const problem of problems) {
      console.error(terminalColors().red(problem));
    }

    process.exitCode = 1;
  } catch (caught) {
    console.error(
      terminalColors().red(`check-outputs: ${errorMessage(caught)}`),
    );
    process.exitCode = 1;
  }
}

/** The --mode value: all (absent), or one of the three names. */
function normalizeMode(value: string | undefined): CheckMode | undefined {
  if (value === undefined || value === "all") {
    return "all";
  }

  if (value === "shape" || value === "citations") {
    return value;
  }

  return undefined;
}

/* v8 ignore next: covered only under direct `node scripts/check-outputs.ts` runs */
refuseDirectExecution(import.meta.url, "check-outputs", "bin/libexec");
