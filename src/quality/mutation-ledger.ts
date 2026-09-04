// The rolling survivor issue's merged ledger (issue #261).
//
// The issue body IS the ledger: the renderer embeds the full ledger
// as a hidden HTML-comment JSON block beside the human-readable list,
// and every filing merges the fresh Stryker report into the prior
// body's ledger. Removal is status-aware, never absence-blind: an
// entry leaves only via a verified kill (the run covered it and it
// died) or an adjudication record in the equivalent-mutant registry
// (issue #241 — recorded entries stay in the block, filtered only
// from the rendered list, so the filter is presentation only). An
// entry absent from the report was never generated (out of the run's
// scope) and stays, so a windowed nightly cannot wipe out-of-window
// entries. Full-scope dispatch runs pass absenceKills: covering all
// of src/, absence anywhere means death — that is the reconciliation
// / ledger-rewrite role.
//
// Entries are keyed by the refactor-resilient span identity (issue
// #241): sha(mutated span text, mutator, repo-relative path), never
// file:line. Pre-registry blocks (schema 1) parse to legacy entries
// without ids; a generated mutant replaces its legacy file:line twin
// on the spot, so in-window entries migrate without duplicates, and
// the first full run rewrites the whole ledger under span keys.

import { mutantIdentity, type SourceReader } from "./mutation-identity.ts";
import {
  compareEntries,
  formatEntry,
  isActionable,
  type Mutant,
  type Report,
} from "./mutation-survivors.ts";

/** One tracked actionable mutant: Survived or NoCoverage. */
export interface LedgerEntry {
  readonly file: string;
  readonly line: number;
  readonly mutator: string;
  readonly status: string;
  /** The span identity; absent on legacy (pre-registry) entries. */
  readonly id?: string | undefined;
}

/** The tracked actionable mutants, sorted deterministically. */
export interface Ledger {
  readonly entries: readonly LedgerEntry[];
}

/** The mutant-identity key: the span identity when the entry has
 *  one, else the legacy `file:line|mutator` stopgap — the two never
 *  collide (span identities are 16 hex characters). */
export function identity(entry: LedgerEntry): string {
  return entry.id ?? `${entry.file}:${entry.line}|${entry.mutator}`;
}

/** Verdicts that prove the run covered a mutant and it died. */
const DEATH_STATUSES = new Set(["Killed", "Timeout"]);

/** The rendered, sorted lines of a ledger — the exact format
 *  `npm run mutation:survivors` prints. */
export function ledgerLines(ledger: Ledger): string[] {
  return [...ledger.entries].sort(compareEntries).map(formatEntry);
}

/** The serialized shape inside the hidden block. */
type LedgerJson = { schema: number; entries: Record<string, LedgerEntry> };

const BLOCK_PREFIX = "k-wiki-mutants-ledger: ";

/** The full ledger as one hidden HTML-comment line — GitHub renders
 *  nothing, `gh issue view --json body` returns it verbatim. */
export function ledgerBlockLine(ledger: Ledger): string {
  const entries: Record<string, LedgerEntry> = {};

  for (const entry of [...ledger.entries].sort(compareEntries)) {
    entries[identity(entry)] = entry;
  }

  const json: LedgerJson = { schema: 2, entries };

  return `<!-- ${BLOCK_PREFIX}${JSON.stringify(json)} -->`;
}

/** A valid-looking parsed block, or undefined when absent or
 *  unreadable (the bootstrap path then takes over). */
function parseLedgerBlock(body: string): Ledger | undefined {
  const match = new RegExp(`^<!-- ${BLOCK_PREFIX}(\\{.+\\}) -->$`, "m").exec(
    body,
  );

  if (match === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1] ?? "{}") as LedgerJson;

    if (
      (parsed.schema !== 1 && parsed.schema !== 2) ||
      typeof parsed.entries !== "object" ||
      Array.isArray(parsed.entries) ||
      parsed.entries === null
    ) {
      return undefined;
    }

    return { entries: Object.values(parsed.entries) };
  } catch {
    return undefined;
  }
}

/** The rendered actionable lines of a pre-block body — the one-time
 *  bootstrap: bodies the replace-era renderer wrote carry no block,
 *  so the first merge parses the list that same renderer printed. */
export function bootstrapEntries(body: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];

  const rendered = /^(Survived|NoCoverage) {2}(\S+):(\d+) {2}(\S+)$/gm;

  for (const match of body.matchAll(rendered)) {
    entries.push({
      status: match[1] ?? "",
      file: match[2] ?? "",
      line: Number(match[3]),
      mutator: match[4] ?? "",
    });
  }

  return entries;
}

/** The prior ledger of a rolling-issue body: the embedded block when
 *  present (authoritative), else the bootstrapped rendered entries,
 *  else an empty ledger (fresh filing). */
export function ledgerFromBody(body: string): Ledger {
  const fromBlock = parseLedgerBlock(body);

  if (fromBlock !== undefined) {
    return fromBlock;
  }

  return { entries: bootstrapEntries(body) };
}

export interface MergeOptions {
  /** A full-scope run covers all of src/: an entry absent from its
   *  report is dead. Windowed runs leave absent entries alone. */
  readonly absenceKills: boolean;
  /** Reads the report's source files, for span-identity computation. */
  readonly readSource: SourceReader;
}

/** The merge's output: the merged ledger, plus the identities the
 *  fresh report generated — the reconciliation input the registry's
 *  prune pass consumes (only a full run may prune). */
export interface MergeResult {
  readonly ledger: Ledger;
  readonly generated: ReadonlySet<string>;
}

/** Apply one fresh-report verdict to the merged ledger. */
function applyVerdict(
  merged: Map<string, LedgerEntry>,
  generated: Set<string>,
  readSource: SourceReader,
  file: string,
  mutant: Mutant,
): void {
  const id = mutantIdentity(file, mutant, readSource);
  const key =
    id ?? `${file}:${mutant.location.start.line}|${mutant.mutatorName}`;

  const entry: LedgerEntry = {
    file,
    line: mutant.location.start.line,
    mutator: mutant.mutatorName,
    status: mutant.status,
    ...(id === undefined ? {} : { id }),
  };

  generated.add(key);

  if (id !== undefined) {
    // The migration twin: the legacy file:line entry this span
    // identity replaces — deleted so the mutant never lists twice.
    merged.delete(`${entry.file}:${entry.line}|${entry.mutator}`);
  }

  if (isActionable(mutant.status)) {
    merged.set(key, entry);
  } else if (DEATH_STATUSES.has(mutant.status)) {
    merged.delete(key);
  }

  // Any other verdict (e.g. CompileError) never tested the mutant:
  // the ledger entry stays untouched.
}

/** Merge a fresh Stryker report into the prior ledger: upsert the
 *  actionable verdicts under their span identities, drop the verified
 *  kills, and — for full-scope runs only — drop entries the report
 *  never generated. */
export function mergeLedger(
  prior: Ledger,
  report: Report,
  options: MergeOptions,
): MergeResult {
  const merged = new Map(
    prior.entries.map((entry) => [identity(entry), entry]),
  );

  const generated = new Set<string>();

  for (const [file, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      applyVerdict(merged, generated, options.readSource, file, mutant);
    }
  }

  if (options.absenceKills) {
    for (const key of merged.keys()) {
      if (!generated.has(key)) {
        merged.delete(key);
      }
    }
  }

  return {
    ledger: { entries: [...merged.values()].sort(compareEntries) },
    generated,
  };
}
