import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { anchorResolves } from "./chapter-headings.ts";
import {
  buildPageIndex,
  closingFence,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  pageReportPath,
  parsePageFields,
  wikilinkTarget,
} from "./pages.ts";
import {
  citationAnchor,
  isUnmigratableSelfCitation,
  loadSourceHubIndex,
  type SourceHubIndex,
  wikilinkFor,
} from "./source-hubs.ts";
import { stem } from "./wiki-links.ts";

/**
 * Dead-provenance core (issue #65): the deterministic backstop that
 * catches any purge miss — and any sync/wiki drift of any kind. Every
 * `sources` wikilink on every wiki page must resolve to an existing
 * `type: source` page, and every `origin` raw path must exist under
 * `raw/`. A path-form `sources` entry (issue #126) must be backed by a
 * raw file AND must not be a path a `type: source` hub covers — a
 * covered path has a clickable wikilink, and citing the raw path
 * instead is dead-provenance drift. An anchored citation
 * (`[[hub#Chapter]]`, issue #226) must also land on a heading
 * byte-identical to the anchor — reported with page and line, the
 * check that stops anchor drift returning. Coverage follows the
 * shared hub index (src/wiki/source-hubs.ts), the one rule the
 * migration and the guardrails also apply. The scripts/check-provenance
 * CLI renders it; the wiki-sync verification stage (issue #138) runs
 * it every cycle.
 */

export interface ProvenanceReport {
  /** One `wiki/<page> -> …` line per dead-provenance problem. */
  readonly problems: readonly string[];
  /** `sources` wikilinks checked across all scanned pages. */
  readonly sources: number;
  /** `origin` fields checked. */
  readonly origins: number;
  /** `type: source` pages whose frontmatter lacks `origin`. */
  readonly missingOrigins: number;
  /** Markdown pages scanned under the wiki root. */
  readonly pages: number;
}

/** The raw projection must be a directory; named on failure. Shared
 *  with the fidelity core (issue #125). */
export async function assertRawDir(rawDir: string): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(rawDir)).isDirectory();
  } catch {
    throw new Error(`raw directory does not exist: ${rawDir}`);
  }

  if (!isDirectory) {
    throw new Error(`raw directory is not a directory: ${rawDir}`);
  }
}

/** The 1-based line a `sources` entry sits on inside its page's
 *  frontmatter block, or undefined when it cannot be located. */
function entryLine(text: string, entry: string): number | undefined {
  const lines = text.split("\n");
  const closing = closingFence(lines);
  const limit = closing === -1 ? lines.length : closing;

  for (let i = 0; i < limit; i += 1) {
    if ((lines[i] ?? "").includes(entry)) {
      return i + 1;
    }
  }

  return undefined;
}

/** Check one `sources` wikilink entry: it must resolve to an
 *  existing page whose hub index type is `source`, and an anchored
 *  citation must land on a heading byte-identical to its anchor. */
function checkWikilinkEntry(
  page: string,
  line: number | undefined,
  entry: string,
  index: ReadonlyMap<string, string>,
  texts: ReadonlyMap<string, string>,
  hubs: SourceHubIndex,
  problems: string[],
): void {
  const target = wikilinkTarget(entry);

  if (!index.has(target)) {
    problems.push(`${page} -> ${entry} (missing source page)`);

    return;
  }

  if (hubs.fields.get(target)?.type !== "source") {
    problems.push(`${page} -> ${entry} (does not cite a type: source page)`);

    return;
  }

  const anchor = citationAnchor(entry);

  if (anchor === undefined) {
    return;
  }

  const targetText = texts.get(index.get(target) ?? "");

  if (!anchorResolves(targetText ?? "", anchor)) {
    problems.push(
      `${page}${line === undefined ? "" : `:${line}`} -> ${entry} (target has no heading "${anchor}")`,
    );
  }
}

/** Check one `sources` path entry: it must exist under `raw/` and
 *  must not be a path a hub covers — a covered path has a clickable
 *  wikilink, and citing the raw path instead is dead-provenance
 *  drift. */
async function checkPathEntry(
  page: string,
  fileStem: string,
  entry: string,
  hubs: SourceHubIndex,
  rawDir: string,
  problems: string[],
): Promise<void> {
  try {
    await stat(join(rawDir, normalizeRawPath(entry)));
  } catch {
    problems.push(`${page} -> sources ${entry} (missing under raw/)`);

    return;
  }

  const mapped = wikilinkFor(entry, hubs);

  if (
    "wikilink" in mapped &&
    !isUnmigratableSelfCitation(fileStem, entry, hubs)
  ) {
    problems.push(
      `${page} -> sources ${entry} (path has hub ${mapped.wikilink} — use the wikilink)`,
    );
  }
}

/** Check a page's `origin` raw path exists under `raw/`. */
async function checkOrigin(
  page: string,
  origin: string,
  rawDir: string,
  problems: string[],
): Promise<void> {
  try {
    await stat(join(rawDir, normalizeRawPath(origin)));
  } catch {
    problems.push(`${page} -> origin ${origin} (missing under raw/)`);
  }
}

/**
 * Check every wiki page under `wikiDirInput` against the raw projection
 * at `rawDirInput`, reporting problems with paths relative to the wiki
 * root's parent directory. A `sources` entry must be alive: a wikilink
 * entry resolves to an existing wiki page, a path entry to an existing
 * file under `raw/`; an `origin` must exist under `raw/`. Agent
 * contract files (AGENTS.md) are not wiki pages and are skipped.
 * Throws when either directory is missing.
 */
export async function checkWikiProvenance(
  wikiDirInput: string,
  rawDirInput: string,
): Promise<ProvenanceReport> {
  const wikiDir = resolve(wikiDirInput);
  const rawDir = resolve(rawDirInput);

  // listWikiPages asserts the wiki directory itself; only the raw
  // side needs its own check here.
  const files = await listWikiPages(wikiDir);

  await assertRawDir(rawDir);
  const index = buildPageIndex(files);
  const hubs = await loadSourceHubIndex(wikiDir);
  const problems: string[] = [];
  const texts = new Map<string, string>();
  let sources = 0;
  let origins = 0;
  let missingOrigins = 0;

  for (const file of files) {
    texts.set(file, await readFile(join(wikiDir, file), "utf8"));
  }

  for (const file of files) {
    const text = texts.get(file) ?? "";
    const fields = parsePageFields(text);
    const page = pageReportPath(wikiDir, file);

    if (fields.type === "source" && fields.origin === undefined) {
      missingOrigins++;
    }

    for (const entry of fields.sources) {
      sources++;

      if (isWikilinkEntry(entry)) {
        checkWikilinkEntry(
          page,
          entryLine(text, entry),
          entry,
          index,
          texts,
          hubs,
          problems,
        );

        continue;
      }

      await checkPathEntry(page, stem(file), entry, hubs, rawDir, problems);
    }

    if (fields.origin !== undefined) {
      origins++;

      await checkOrigin(page, fields.origin, rawDir, problems);
    }
  }

  return { problems, sources, origins, missingOrigins, pages: files.length };
}

/** The report's summary sentence — source links resolved and origins
 *  verified — shared by the check-provenance CLI's ok line and the
 *  wiki-sync digest (issue #138), so the two surfaces cannot drift
 *  apart. */
export function summarizeProvenance(report: ProvenanceReport): string {
  const links = `${report.sources} ${report.sources === 1 ? "source link resolves" : "source links resolve"}`;
  const origins = `${report.origins} ${report.origins === 1 ? "origin exists" : "origins exist"}`;

  return `${links}, ${origins} across ${report.pages} ${report.pages === 1 ? "page" : "pages"}`;
}
