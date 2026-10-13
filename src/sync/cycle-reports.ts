/**
 * The outputs/ day files (issue #459): the append-only report shape
 * shared by the cycle digest (src/sync/wiki-sync.ts), the lint stage
 * (src/sync/lint-stage.ts), and the check-outputs checker. One day
 * file per UTC day per family — `outputs/cycle-<date>.md`,
 * `outputs/lint-<date>.md`, `outputs/lint-<date>-full.md` — always
 * one day H1 plus bounded `## Cycle N — <timestamp>` /
 * `## Lint run N — <timestamp> (<window>)` sections separated by
 * `---`. Same-day runs append; nothing is ever rewritten or
 * superseded. The first append to a legacy-shape (overwrite-era) day
 * file retitles it and synthesizes a `Cycle 1 (pre-append)` /
 * `Lint run 1 (pre-append)` bound around the legacy content, so
 * references and the checker stay uniform from the first append
 * onward with zero content loss. Section timestamps are local-offset
 * ISO instants while the day file belongs to the UTC day of its
 * run's start — the two may disagree across the UTC/local boundary
 * by design. Every in-cycle lint section carries a back-reference
 * naming the exact cycle section that cites it, and a standalone run
 * carries the explicit marker.
 */

/** The cycle day file's H1 for a UTC day: the date, stated once. */
export function cycleDayTitle(date: Date): string {
  return `# wiki-sync cycle digest — ${dayDate(date)}`;
}

/** The lint day file's H1 for a UTC day, per audit mode. */
export function lintDayTitle(mode: "window" | "full", date: Date): string {
  return mode === "full"
    ? `# Full lint — ${dayDate(date)}`
    : `# Windowed lint — ${dayDate(date)}`;
}

/** The file-family date: the UTC day of the instant (the same
 *  derivation `cycleReportPath`/`lintReportPath` use for the file
 *  name). */
export function dayDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A local-offset ISO timestamp — `2026-10-12T14:54:53+01:00` — the
 *  section-heading form. Section headings carry local time; the day
 *  file name carries the UTC day (issue #459, Design 11). */
export function localIsoTimestamp(date: Date): string {
  const padded = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);

  return (
    `${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())}` +
    `T${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}` +
    `${sign}${padded(Math.floor(absolute / 60))}:${padded(absolute % 60)}`
  );
}

/** A cycle section's heading text: number, date, and time — the date
 *  stated once, inside the timestamp. */
export function cycleSectionTitle(start: Date, number: number): string {
  return `Cycle ${number} — ${localIsoTimestamp(start)}`;
}

/** A lint run section's heading text: the run's own execution
 *  instant plus its inline window definition. */
export function lintSectionTitle(
  instant: Date,
  number: number,
  window: string,
): string {
  return `Lint run ${number} — ${localIsoTimestamp(instant)} (${window})`;
}

/** The exact first line of an in-cycle lint run's section body: the
 *  back-reference naming the cycle section that cites it. */
export function cycleBackReferenceLine(
  cyclePath: string,
  sectionTitle: string,
): string {
  return `Cycle audited: \`${cyclePath}\` — section "${sectionTitle}"`;
}

/** The exact marker line of a standalone lint run's section body:
 *  no citing cycle exists, and the checker exempts marked runs. */
export const STANDALONE_MARKER = "Standalone — no citing cycle.";

/** A section plan: the section's exact heading text and the file
 *  content to write before the section body — the day title on
 *  create, the legacy transition when applicable, otherwise the
 *  previous content plus the `---` separator and the new heading. */
export interface DaySectionPlan {
  /** The section's heading text, without the `## ` prefix. */
  readonly sectionTitle: string;
  /** The full file content up to (and including the blank line
   *  after) the section heading; the body follows it verbatim. */
  readonly prefix: string;
}

/** Plan the next cycle section's append to the day file: number by
 *  section position, transition a legacy-shape file on first append
 *  (retitle plus the synthesized pre-append bound, content
 *  verbatim), and never touch prior sections. */
export function planCycleAppend(
  existing: string | undefined,
  start: Date,
): DaySectionPlan {
  const expectedTitle = cycleDayTitle(start);

  return planDayAppend({
    existing,
    expectedTitle,
    family: "cycle",
    sectionTitleFor: (number) => cycleSectionTitle(start, number),
  });
}

/** Plan the next lint run section's append to the day file: same
 *  rules as the cycle family, with the run's own execution instant
 *  and its inline window definition in the heading. */
export function planLintAppend(
  existing: string | undefined,
  instant: Date,
  mode: "window" | "full",
  window: string,
): DaySectionPlan {
  return planDayAppend({
    existing,
    expectedTitle: lintDayTitle(mode, instant),
    family: "lint",
    sectionTitleFor: (number) => lintSectionTitle(instant, number, window),
  });
}

/** The shared append planner's inputs. */
interface PlanInput {
  readonly existing: string | undefined;
  readonly expectedTitle: string;
  readonly family: DayFamily;
  readonly sectionTitleFor: (number: number) => string;
}

/** The section-word a family's headings open with: `Cycle N …` /
 *  `Lint run N …`. */
const FAMILY_LABEL: Record<DayFamily, string> = {
  cycle: "Cycle",
  lint: "Lint run",
};

/** Fresh file → day title + section 1; append shape → previous
 *  content + separator + the next numbered section; legacy shape →
 *  retitle plus the synthesized `1 (pre-append)` bound and the new
 *  section numbered 2 (the bound occupies position 1). */
function planDayAppend(input: PlanInput): DaySectionPlan {
  const { existing, expectedTitle, family, sectionTitleFor } = input;

  if (existing === undefined || existing.trim() === "") {
    return {
      sectionTitle: sectionTitleFor(1),
      prefix: `${expectedTitle}\n\n## ${sectionTitleFor(1)}\n\n`,
    };
  }

  const parsed = parseDayFile(existing, family, expectedTitle);

  if (parsed.kind === "append") {
    const next = parsed.file.sections.length + 1;
    const title = sectionTitleFor(next);

    return {
      sectionTitle: title,
      prefix: `${existing.trimEnd()}\n\n---\n\n## ${title}\n\n`,
    };
  }

  const title = sectionTitleFor(2);

  return {
    sectionTitle: title,
    prefix: `${expectedTitle}\n\n## ${FAMILY_LABEL[family]} 1 (pre-append)\n\n${legacyBody(existing)}\n\n---\n\n## ${title}\n\n`,
  };
}

/** The legacy content for the pre-append bound: everything except a
 *  leading H1 line (the retitle replaces it), seam whitespace
 *  trimmed, otherwise verbatim — zero content loss. */
function legacyBody(existing: string): string {
  const withoutTitle = existing.startsWith("# ")
    ? existing.slice(existing.indexOf("\n") + 1)
    : existing;

  return withoutTitle.trim();
}

/** One parsed day-file section. */
export interface DaySection {
  /** The heading text, without the `## ` prefix. */
  readonly title: string;
  /** The heading line, `## ` prefix included. */
  readonly heading: string;
  /** True for a synthesized `N (pre-append)` bound: its body is
   *  grandfathered legacy content, exempt from the appended-content
   *  rules. */
  readonly preAppend: boolean;
  /** The body lines after the heading, up to the next section. */
  readonly body: string;
}

/** A parsed append-shape day file: the day H1 (without `# `) and its
 *  sections in file order, at least one. */
export interface ParsedDayFile {
  readonly title: string;
  readonly sections: readonly DaySection[];
}

/** The day-file families, each with its own section grammar. */
export type DayFamily = "cycle" | "lint";

/** Section-heading grammar, per family: number, date, and time —
 *  the date stated once, inside the local-offset timestamp; lint
 *  headings carry their inline window definition. */
const SECTION_PATTERNS: Record<DayFamily, readonly RegExp[]> = {
  cycle: [
    /^Cycle (\d+) — (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})$/,
    /^Cycle (\d+) \(pre-append\)$/,
  ],
  lint: [
    /^Lint run (\d+) — (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) \((.+)\)$/,
    /^Lint run (\d+) \(pre-append\)$/,
  ],
};

/** True when the line is a section heading of the family. */
function isSectionHeading(line: string, family: DayFamily): boolean {
  return (
    line.startsWith("## ") &&
    SECTION_PATTERNS[family].some((pattern) =>
      pattern.test(line.slice("## ".length)),
    )
  );
}

/** Parse a day file into its append shape, or report it legacy. A
 *  file is append shape only when its first line is the expected day
 *  title and it carries at least one family-grammar section heading;
 *  anything else is a legacy (overwrite-era) file the transition
 *  rule owns. Section bodies run to the next section heading — a
 *  `---` line inside agent content never splits a section. */
export function parseDayFile(
  text: string,
  family: DayFamily,
  expectedTitle: string,
): { kind: "append"; file: ParsedDayFile } | { kind: "legacy" } {
  const lines = text.split("\n");
  const first = lines[0] ?? "";

  if (first !== expectedTitle) {
    return { kind: "legacy" };
  }

  const marks = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isSectionHeading(line, family));

  if (marks.length === 0) {
    return { kind: "legacy" };
  }

  const sections = marks.map(({ line, index }, position) => {
    const next = marks.at(position + 1);
    const end = next?.index ?? lines.length;
    const bodyLines = lines.slice(index + 1, end);
    const title = line.slice("## ".length);

    return {
      title,
      heading: line,
      preAppend: title.endsWith(" (pre-append)"),
      body: bodyLines.join("\n"),
    };
  });

  return {
    kind: "append",
    file: { title: first.slice("# ".length), sections },
  };
}

/** What a lint run section's body declares about its citing cycle:
 *  the explicit standalone marker, a cycle back-reference, or
 *  neither (a shape problem the checker reports). */
export type LintRunReference =
  | { readonly kind: "standalone" }
  | {
      readonly kind: "cycle";
      readonly path: string;
      readonly sectionTitle: string;
    }
  | { readonly kind: "none" };

/** Extract a lint run section's declared citing-cycle reference. */
export function lintRunReference(body: string): LintRunReference {
  if (body.includes(STANDALONE_MARKER)) {
    return { kind: "standalone" };
  }

  const match = /^Cycle audited: `([^`\n]+)` — section "([^"]+)"/m.exec(body);
  const path = match?.[1];
  const sectionTitle = match?.[2];

  if (path !== undefined && sectionTitle !== undefined) {
    return { kind: "cycle", path, sectionTitle };
  }

  return { kind: "none" };
}

/** The cycle section's lint reference: the report path plus the
 *  exact lint run section title it audited, or undefined when the
 *  section carries no lint-run reference (lint skipped, empty
 *  window, failure section). */
export function cycleLintReference(
  body: string,
): { readonly path: string; readonly sectionTitle: string } | undefined {
  const match = /— report `([^`\n]+)` — section "([^"]+)"/.exec(body);
  const path = match?.[1];
  const sectionTitle = match?.[2];

  if (path === undefined || sectionTitle === undefined) {
    return undefined;
  }

  return { path, sectionTitle };
}

/** One scanned body line: the text verbatim, its ATX heading depth
 *  (0 for a non-heading or fenced line), and that heading's leading
 *  spaces (0 for a non-heading). */
export interface ScannedLine {
  readonly line: string;
  readonly hashes: number;
  readonly indent: number;
}

/** A line's open code fence: the marker character and the minimum
 *  length that closes it. */
interface OpenFence {
  readonly char: string;
  readonly length: number;
}

/** The fence a line opens with: an indent of up to three spaces,
 *  then three or more backticks or tildes. */
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;

/** Whether the line closes an open fence: up to three leading
 *  spaces, then a marker of the same character at least as long as
 *  the opener's, then nothing but whitespace. */
function closesFence(line: string, fence: OpenFence): boolean {
  const stripped = line.replace(/^ {0,3}/, "");
  const marker = /^(`+|~+)/.exec(stripped)?.[0];

  return (
    marker !== undefined &&
    marker[0] === fence.char &&
    marker.length >= fence.length &&
    stripped.slice(marker.length).trim() === ""
  );
}

/** The heading a non-fenced line carries — up to three leading
 *  spaces, then one to six hashes, then a space — undefined for a
 *  non-heading. */
function headingOf(
  line: string,
): { hashes: number; indent: number } | undefined {
  const match = /^ {0,3}(#{1,6}) /.exec(line);
  const hashes = match?.[1];

  if (match === null || hashes === undefined) {
    return undefined;
  }

  return {
    hashes: hashes.length,
    indent: match[0].length - hashes.length - 1,
  };
}

/** Scan a text's lines with code-fence state tracked: a fence opens
 *  on its marker line and closes only on a marker of the same
 *  character at least as long; lines inside a fence — the markers
 *  included — carry heading depth 0. The one line scan the digest
 *  embed's demotion transform and the checker's containment scan
 *  both consume, so fenced report content is never read as section
 *  structure. */
export function scannedLines(text: string): readonly ScannedLine[] {
  let fence: OpenFence | undefined;

  return text.split("\n").map((line) => {
    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        fence = undefined;
      }

      return { line, hashes: 0, indent: 0 };
    }

    const marker = FENCE_OPENER.exec(line)?.[1];

    if (marker !== undefined) {
      fence = { char: marker.charAt(0), length: marker.length };

      return { line, hashes: 0, indent: 0 };
    }

    const heading = headingOf(line) ?? { hashes: 0, indent: 0 };

    return { line, hashes: heading.hashes, indent: heading.indent };
  });
}
