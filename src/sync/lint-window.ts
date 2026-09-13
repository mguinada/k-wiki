/**
 * The lint window (issue #359): the snapshot that bounds the cycle's
 * lint stage by change instead of by clock. The snapshot lives in the
 * data repo's outputs/ — per-instance state beside the ingest manifest
 * snapshot, stamped with its data root, never committed — and records
 * the sha256 of every wiki page as of the last successful lint. The
 * next run's window is every page whose hash differs (changed, added)
 * plus the one-hop reverse-link neighbors of the changed set, so
 * cross-page effects stay covered while the audited surface scales
 * with change, not with the wiki. A missing snapshot means a first
 * run (the caller falls back to the full audit); a failed lint run
 * leaves the snapshot untouched, so the next run retries the same
 * window. Derivation is pure file reading: no git, no LLM.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPlainObject, readTextIfExists, sha256 } from "../cli/shared.ts";
import { listWikiPages } from "../wiki/pages.ts";
import { inboundLinkIndex, stem } from "../wiki/wiki-links.ts";

/** The snapshot's file name under the data repo's outputs/. */
export const LINT_WINDOW_FILENAME = "lint-window.json";

/** The snapshot path for a data repo. */
export function lintWindowPath(dataRoot: string): string {
  return join(dataRoot, "outputs", LINT_WINDOW_FILENAME);
}

/** The last successful lint's page-state: every wiki page's
 *  wiki-relative path to its content hash. */
export type LintWindowSnapshot = ReadonlyMap<string, string>;

/** The parsed snapshot's `pages` record as a path→hash map; throws
 *  naming the file when the record is missing or an entry has no
 *  hash. */
function pagesRecordOf(
  parsed: Record<string, unknown>,
  snapshotPath: string,
): LintWindowSnapshot {
  if (!isPlainObject(parsed.pages)) {
    throw new Error(`invalid lint window at ${snapshotPath}: no pages record`);
  }

  const snapshot = new Map<string, string>();

  for (const [path, hash] of Object.entries(parsed.pages)) {
    if (typeof hash !== "string") {
      throw new Error(
        `invalid lint window at ${snapshotPath}: page ${path} has no hash`,
      );
    }

    snapshot.set(path, hash);
  }

  return snapshot;
}

/** The foreign-or-unstamped warning: what the snapshot's origin is
 *  and why it is ignored. */
function foreignSnapshotWarning(
  snapshotPath: string,
  snapshotFor: string | undefined,
  dataRoot: string,
): string {
  const origin =
    snapshotFor === undefined
      ? "has no instance stamp"
      : `is stamped for ${snapshotFor}`;

  return `lint window ${snapshotPath} ${origin}, not this instance (${dataRoot}); ignoring it and running a full audit; the next successful lint rewrites the snapshot`;
}

/** Read the snapshot when it belongs to this data repo. The stamp
 *  guard mirrors the ingest snapshot's (issue #95): a snapshot
 *  stamped for another instance — or an unstamped one whose origin
 *  is unknowable — is foreign state; diffing against it would
 *  mis-shape the window, so warn and return undefined (the caller
 *  falls back to the full audit, and the next successful lint
 *  rewrites the stamp). A missing file is a first run, no warning.
 *  Invalid JSON throws: a corrupt snapshot must not silently become
 *  a full audit. */
export async function readLintWindowSnapshot(
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<LintWindowSnapshot | undefined> {
  const text = await readTextIfExists(snapshotPath);

  if (text === undefined) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid lint window at ${snapshotPath}: not valid JSON`, {
      cause,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`invalid lint window at ${snapshotPath}: no pages record`);
  }

  const snapshotFor =
    typeof parsed.snapshotFor === "string" ? parsed.snapshotFor : undefined;

  if (snapshotFor !== dataRoot) {
    onProgress(foreignSnapshotWarning(snapshotPath, snapshotFor, dataRoot));

    return undefined;
  }

  return pagesRecordOf(parsed, snapshotPath);
}

/** The window the next lint audits: the changed pages plus their
 *  one-hop reverse-link neighbors. */
export interface LintWindow {
  /** Wiki-relative paths to audit, sorted. */
  readonly pages: readonly string[];
  /** How many of them changed since the snapshot (the rest are
   *  reverse-link neighbors pulled in for coverage). */
  readonly changedCount: number;
}

/** Hash every wiki page's current bytes: the write-side record. */
export async function pageHashes(
  wikiDir: string,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const files = await listWikiPages(wikiDir);

  for (const file of files) {
    hashes.set(file, sha256(await readFile(join(wikiDir, file))));
  }

  return hashes;
}

/** Pages whose current state differs from the snapshot's record —
 *  changed, added, or deleted since the last successful lint. A
 *  deleted page cannot be audited itself, but its linkers must be:
 *  it stays in the changed set for the neighbor expansion. */
async function changedPages(
  wikiDir: string,
  snapshot: LintWindowSnapshot,
): Promise<string[]> {
  const current = await pageHashes(wikiDir);
  const changed: string[] = [];

  for (const [file, hash] of current) {
    if (snapshot.get(file) !== hash) {
      changed.push(file);
    }
  }

  for (const file of snapshot.keys()) {
    if (!current.has(file)) {
      changed.push(file);
    }
  }

  return changed;
}

/** The pages linking to each page name (the link graph's reverse
 *  edges), through the shared inbound index — the one edge rule in
 *  src/wiki/wiki-links.ts: cross-wiki targets and self-links never
 *  edge in. */
async function reverseLinkIndex(
  wikiDir: string,
): Promise<Map<string, Set<string>>> {
  const texts = new Map<string, string>();

  for (const file of await listWikiPages(wikiDir)) {
    texts.set(file, await readFile(join(wikiDir, file), "utf8"));
  }

  return inboundLinkIndex(texts);
}

/** Derive the window a lint run audits: every existing page changed
 *  since the snapshot plus the existing pages that link to a changed
 *  one (deleted pages included in the changed set for the expansion —
 *  their linkers are pulled in through the deleted stem's inbound
 *  set, and the deleted page itself is not audited). */
export async function deriveLintWindow(
  wikiDir: string,
  snapshot: LintWindowSnapshot,
): Promise<LintWindow> {
  const changed = await changedPages(wikiDir, snapshot);

  if (changed.length === 0) {
    return { pages: [], changedCount: 0 };
  }

  const reverse = await reverseLinkIndex(wikiDir);
  const existing = new Set((await listWikiPages(wikiDir)) as string[]);
  const window = new Set<string>();

  for (const file of changed) {
    if (existing.has(file)) {
      window.add(file);
    }

    for (const linker of reverse.get(stem(file)) ?? []) {
      window.add(linker);
    }
  }

  const pages = [...window].sort();

  return { pages, changedCount: changed.length };
}

/** Write the snapshot after a successful lint: every current page's
 *  hash, stamped for this data repo. Written only on success paths —
 *  the agent run finished and the guardrails passed — so a failed run
 *  leaves the previous snapshot in place and the next run retries the
 *  same window. */
export async function writeLintWindowSnapshot(
  wikiDir: string,
  snapshotPath: string,
  dataRoot: string,
): Promise<void> {
  const pages = await pageHashes(wikiDir);
  const record: Record<string, string> = {};

  for (const [file, hash] of pages) {
    record[file] = hash;
  }

  await mkdir(dirname(snapshotPath), { recursive: true });
  const tempPath = `${snapshotPath}.tmp`;

  await rm(tempPath, { force: true });

  await writeFile(
    tempPath,
    `${JSON.stringify({ snapshotFor: dataRoot, pages: record }, null, 2)}\n`,
    "utf8",
  );
  await rename(tempPath, snapshotPath);
}

/** Restore the snapshot file to its pre-lint bytes after a revert:
 *  the verification stage rewinds the lint edits, so the audit that
 *  recorded them must be unrecorded too — the next run re-derives
 *  its window against the pre-lint state and re-audits the reverted
 *  pages. `previous` undefined deletes a snapshot that did not exist
 *  before the lint ran. */
export async function restoreLintWindowSnapshot(
  snapshotPath: string,
  previous: string | undefined,
): Promise<void> {
  if (previous === undefined) {
    await rm(snapshotPath, { force: true });

    return;
  }

  const tempPath = `${snapshotPath}.tmp`;

  await rm(tempPath, { force: true });
  await writeFile(tempPath, previous, "utf8");
  await rename(tempPath, snapshotPath);
}
