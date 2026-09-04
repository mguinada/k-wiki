import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Mutant } from "./mutation-survivors.ts";

// Refactor-resilient mutant identity (issue #241): a sha over the
// mutated span's exact code text, the mutator name, and the file's
// repo-relative path — never `file:line`, which rots under refactors
// (line shifts orphan or mispoint entries). One identity serves both
// consumers: the rolling ledger's merge-body dedup and the
// equivalent-mutant registry. Formatting churn re-keys (no
// whitespace normalization in v1 — half-normalized keys rot worse
// than honest ones), and a renamed file re-keys too: without the
// path, two identical code spans in different files would share a
// key and one adjudication would silence both.

/** Reads one report-relative source file's text; undefined when the
 *  file is unreadable (the mutant then falls back to the ledger's
 *  stopgap key — it is never silently dropped). */
export type SourceReader = (file: string) => string | undefined;

/** A SourceReader over one base directory — the repo root for the
 *  filing workflow and local triage alike. */
export function readSourceFrom(baseDir: string): SourceReader {
  return (file) => {
    try {
      return readFileSync(join(baseDir, file), "utf8");
    } catch {
      return undefined;
    }
  };
}

/** The mutated range's code text, column-precise. Stryker's JSON
 *  report carries 1-based lines and columns with an exclusive end
 *  (verified empirically against a live report — the schema docs say
 *  otherwise, the bytes do not); the extraction converts. Undefined
 *  when the location falls outside the source or carries no end
 *  position. */
export function spanText(source: string, mutant: Mutant): string | undefined {
  const { start, end } = mutant.location;

  if (
    end === undefined ||
    start.column === undefined ||
    end.column === undefined
  ) {
    return undefined;
  }

  const lines = source.split("\n");
  const first = lines[start.line - 1];
  const last = lines[end.line - 1];

  if (first === undefined || last === undefined) {
    return undefined;
  }

  if (start.line === end.line) {
    return first.slice(start.column - 1, end.column - 1);
  }

  const middle = lines.slice(start.line, end.line - 1);

  return [
    first.slice(start.column - 1),
    ...middle,
    last.slice(0, end.column - 1),
  ].join("\n");
}

/** The byte offset of the span's start — the anchor the
 *  occurrence ordinal counts against. */
function startOffset(source: string, mutant: Mutant): number | undefined {
  const { start } = mutant.location;
  const lines = source.split("\n");
  const before = lines.slice(0, start.line - 1);
  const line = lines[start.line - 1];

  if (line === undefined || start.column === undefined) {
    return undefined;
  }

  return [...before, line.slice(0, start.column - 1)].join("\n").length;
}

/** Which occurrence of an identical span text this mutant sits on —
 *  derived from the source alone (never the report's scope, so a
 *  windowed run and a full run compute the same identity): two
 *  identical `[]` literals in one file are different mutants, and a
 *  kill verdict for one must never delete the other. Pure line moves
 *  keep the count; inserting or removing an identical text above
 *  re-keys (bounded, rare — re-file and re-adjudicate). */
function occurrenceOrdinal(
  source: string,
  span: string,
  mutant: Mutant,
): number | undefined {
  const start = startOffset(source, mutant);

  if (start === undefined) {
    return undefined;
  }

  let ordinal = 0;
  let at = source.indexOf(span);

  while (at !== -1 && at < start) {
    ordinal += 1;
    at = source.indexOf(span, at + 1);
  }

  return ordinal;
}

/** The mutant's identity: 16 hex characters of sha256 over
 *  `file \0 span \0 mutator \0 replacement \0 #ordinal`. The
 *  replacement text distinguishes sibling mutants of one mutator on
 *  one span (`<` → `<=` vs `<` → `>=`); the occurrence ordinal
 *  distinguishes duplicate identical spans within a file. Undefined
 *  when the span cannot be read, is empty, or carries no replacement
 *  — such a mutant files under the ledger's stopgap key instead. */
export function mutantIdentity(
  file: string,
  mutant: Mutant,
  readSource: SourceReader,
): string | undefined {
  const source = readSource(file);

  if (source === undefined || mutant.replacement === undefined) {
    return undefined;
  }

  const span = spanText(source, mutant);

  if (span === undefined || span === "") {
    return undefined;
  }

  const ordinal = occurrenceOrdinal(source, span, mutant);

  if (ordinal === undefined) {
    return undefined;
  }

  return createHash("sha256")
    .update(
      `${file}\0${span}\0${mutant.mutatorName}\0${mutant.replacement}#${ordinal}`,
    )
    .digest("hex")
    .slice(0, 16);
}
