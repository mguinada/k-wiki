/**
 * The deterministic lint pre-pass (issue #359, phase B): worklists the
 * lint prompt embeds so the agent judges, never scans. One pass over
 * the wiki tree produces the candidate lists — orphans, single-source
 * pages, sources→non-source edges, frontmatter field misses, the tag
 * inventory, index misses, duplicate titles — each entry a candidate
 * with its evidence, never a verdict: judging stays the agent's job.
 * Checks the standing gates already own (broken wikilinks, cross-wiki
 * targets, citation fidelity) are deliberately absent — no duplication
 * between the agent and the gates. The sandbox root never lists (the
 * shared walker's exclusion), so sandbox notes never reach a worklist.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isWikilinkEntry,
  kebab,
  listWikiPages,
  type PageFields,
  parsePageFields,
  REQUIRED_PAGE_FIELDS,
  wikilinkTarget,
} from "./pages.ts";
import {
  buildPageIndex,
  extractWikilinks,
  inboundLinkIndex,
  stem,
} from "./wiki-links.ts";

/** One worklist candidate: the page, and the deterministic evidence. */
export interface WorklistEntry {
  readonly page: string;
  readonly detail: string;
}

/** The pre-pass worklists, every entry page-keyed except the index's
 *  own dangling entries (they belong to index.md, not a target). */
export interface WikiWorklists {
  readonly orphans: readonly WorklistEntry[];
  readonly singleSource: readonly WorklistEntry[];
  readonly nonSourceEdges: readonly WorklistEntry[];
  readonly frontmatterMisses: readonly WorklistEntry[];
  readonly tagDrift: readonly WorklistEntry[];
  readonly indexMisses: readonly WorklistEntry[];
  readonly duplicateTitles: readonly WorklistEntry[];
  readonly danglingIndexEntries: readonly string[];
}

/** Structural pages: navigation and the append-only log — exempt from
 *  orphan candidacy and index listing (they are the structure). */
const STRUCTURAL = new Set(["index.md", "overview.md", "log.md"]);

/** The log is append-only with no frontmatter by design; the index
 *  and overview carry frontmatter but no `sources` (nothing derives
 *  from source material in them). */
const SOURCES_EXEMPT = new Set(["index.md", "overview.md"]);

/** The wiki tree in one read: every page's fields and the inbound-link
 *  index, plus the stem→page index — the shared substrate of every
 *  worklist. */
interface WikiScan {
  readonly files: readonly string[];
  readonly fields: ReadonlyMap<string, PageFields>;
  readonly byStem: ReadonlyMap<string, string>;
  readonly inbound: ReadonlyMap<string, ReadonlySet<string>>;
  readonly indexTargets: ReadonlySet<string>;
}

/** Read every page once: fields, links, and the reverse-link index. */
async function scanWiki(wikiDir: string): Promise<WikiScan> {
  const files = await listWikiPages(wikiDir);
  const fields = new Map<string, PageFields>();
  const texts = new Map<string, string>();

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");

    texts.set(file, text);
    fields.set(file, parsePageFields(text));
  }

  const indexText = texts.get("index.md");

  return {
    files,
    fields,
    byStem: buildPageIndex(files),
    inbound: inboundLinkIndex(texts),
    indexTargets: new Set(
      indexText === undefined ? [] : extractIndexTargets(indexText),
    ),
  };
}

/** The internal page names index.md links to. */
function extractIndexTargets(indexText: string): string[] {
  return extractWikilinks(indexText)
    .filter((link) => !link.target.includes("/"))
    .map((link) => link.target);
}

/** Pages with no inbound links from any other page — orphan
 *  candidates; structural pages are the structure, not orphans. */
function orphanEntries(scan: WikiScan): WorklistEntry[] {
  const orphans: WorklistEntry[] = [];

  for (const file of scan.files) {
    if (STRUCTURAL.has(file) || scan.inbound.has(stem(file))) {
      continue;
    }

    orphans.push({ page: file, detail: "no inbound links" });
  }

  return orphans;
}

/** Pages whose `sources` has exactly one entry — the corroboration
 *  lifecycle's open set (check 16 reports them; the agent judges). */
function singleSourceEntries(scan: WikiScan): WorklistEntry[] {
  const entries: WorklistEntry[] = [];

  for (const [file, fields] of scan.fields) {
    if (fields.type === "source" || fields.sources.length !== 1) {
      continue;
    }

    entries.push({
      page: file,
      detail: `sources: ${fields.sources[0]}`,
    });
  }

  return entries;
}

/** `sources` entries that cite a page which is missing or not of
 *  type `source` (check 17's deterministic part). Source pages are
 *  exempt — their own `sources` cite chapters, the hub pattern.
 *  Raw-path entries are check-provenance's domain, never candidates
 *  here. */
function nonSourceEdgeEntries(scan: WikiScan): WorklistEntry[] {
  const entries: WorklistEntry[] = [];

  for (const [file, fields] of scan.fields) {
    if (fields.type === "source") {
      continue;
    }

    for (const entry of fields.sources) {
      if (!isWikilinkEntry(entry)) {
        continue;
      }

      const target = wikilinkTarget(entry);
      const targetPage = target === "" ? undefined : scan.byStem.get(target);

      if (targetPage === undefined) {
        entries.push({
          page: file,
          detail: `sources entry ${entry} has no page target`,
        });

        continue;
      }

      const targetType = scan.fields.get(targetPage)?.type;

      if (targetType !== "source") {
        entries.push({
          page: file,
          detail: `sources entry ${entry} cites ${targetType === undefined ? "an untyped page" : `type: ${targetType}`}`,
        });
      }
    }
  }

  return entries;
}

/** Pages missing a required frontmatter field (checks 7 and 8's
 *  deterministic part); the log is append-only by design. */
function frontmatterMissEntries(scan: WikiScan): WorklistEntry[] {
  const entries: WorklistEntry[] = [];

  for (const [file, fields] of scan.fields) {
    if (file === "log.md") {
      continue;
    }

    const missing: string[] = [
      ...REQUIRED_PAGE_FIELDS.filter(
        (field) =>
          fields[field] === undefined ||
          fields[field] === "" ||
          (Array.isArray(fields[field]) && fields[field].length === 0),
      ),
    ];

    if (
      fields.type !== undefined &&
      fields.type !== "source" &&
      !SOURCES_EXEMPT.has(file) &&
      fields.sources.length === 0
    ) {
      missing.push("sources");
    }

    if (missing.length > 0) {
      entries.push({ page: file, detail: `missing: ${missing.join(", ")}` });
    }
  }

  return entries;
}

/** Every page's tags, as written — the vocabulary inventory the agent
 *  reads for drift (check 9); deterministic near-duplicate detection
 *  would be the judgment being smuggled back into code. */
function tagEntries(scan: WikiScan): WorklistEntry[] {
  const entries: WorklistEntry[] = [];

  for (const [file, fields] of scan.fields) {
    if (fields.tags.length > 0) {
      entries.push({ page: file, detail: fields.tags.join(", ") });
    }
  }

  return entries;
}

/** Content pages index.md does not link to (check 13's deterministic
 *  part) — the missing-entry side; the dangling side is the index's
 *  own list. */
function indexMissEntries(scan: WikiScan): WorklistEntry[] {
  const entries: WorklistEntry[] = [];

  for (const file of scan.files) {
    if (STRUCTURAL.has(file) || scan.indexTargets.has(stem(file))) {
      continue;
    }

    entries.push({ page: file, detail: "not listed in index.md" });
  }

  return entries;
}

/** index.md entries whose target page does not exist. */
function danglingIndexEntries(scan: WikiScan): string[] {
  return [...scan.indexTargets]
    .filter((target) => !scan.byStem.has(target))
    .map((target) => `index.md -> [[${target}]] has no page`);
}

/** Pages whose titles kebab-case to the same slug (check 4's
 *  deterministic part) — same title, or two spellings of one. */
function duplicateTitleEntries(scan: WikiScan): WorklistEntry[] {
  const bySlug = new Map<string, string[]>();

  for (const [file, fields] of scan.fields) {
    if (fields.title === undefined) {
      continue;
    }

    const slug = kebab(fields.title);
    const group = bySlug.get(slug) ?? [];

    group.push(file);
    bySlug.set(slug, group);
  }

  const entries: WorklistEntry[] = [];

  for (const [slug, group] of bySlug) {
    if (group.length < 2) {
      continue;
    }

    for (const file of group) {
      entries.push({
        page: file,
        detail: `title slug "${slug}" shared with ${group.filter((peer) => peer !== file).join(", ")}`,
      });
    }
  }

  return entries.sort((a, b) => a.page.localeCompare(b.page));
}

/** Compute every worklist in one pass over the wiki tree. */
export async function computeWikiWorklists(
  wikiDir: string,
): Promise<WikiWorklists> {
  const scan = await scanWiki(wikiDir);

  return {
    orphans: orphanEntries(scan),
    singleSource: singleSourceEntries(scan),
    nonSourceEdges: nonSourceEdgeEntries(scan),
    frontmatterMisses: frontmatterMissEntries(scan),
    tagDrift: tagEntries(scan),
    indexMisses: indexMissEntries(scan),
    duplicateTitles: duplicateTitleEntries(scan),
    danglingIndexEntries: danglingIndexEntries(scan),
  };
}

/** Keep only the entries whose page is in the window — how the
 *  windowed lint prompt narrows the worklists to its audit scope.
 *  The index's own dangling entries stay: they are facts the window
 *  report can carry regardless of scope. */
export function filterWorklistsToWindow(
  worklists: WikiWorklists,
  windowPages: readonly string[],
): WikiWorklists {
  const window = new Set(windowPages);
  const keep = (entries: readonly WorklistEntry[]): WorklistEntry[] =>
    entries.filter((entry) => window.has(entry.page));

  return {
    orphans: keep(worklists.orphans),
    singleSource: keep(worklists.singleSource),
    nonSourceEdges: keep(worklists.nonSourceEdges),
    frontmatterMisses: keep(worklists.frontmatterMisses),
    tagDrift: keep(worklists.tagDrift),
    indexMisses: keep(worklists.indexMisses),
    duplicateTitles: keep(worklists.duplicateTitles),
    danglingIndexEntries: worklists.danglingIndexEntries,
  };
}

/** One worklist section: a heading, one `- page — evidence` line per
 *  entry, or "(none)". */
function section(title: string, entries: readonly WorklistEntry[]): string[] {
  const lines = [`### ${title} (${entries.length})`];

  if (entries.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of entries) {
      lines.push(`- ${entry.page} — ${entry.detail}`);
    }
  }

  return lines;
}

/** Render the worklists as the markdown block the lint prompt embeds:
 *  candidates with evidence, never verdicts. */
export function renderWorklists(worklists: WikiWorklists): string {
  return [
    "Deterministic worklists — candidates to judge, not verdicts:",
    "",
    ...section("Orphan candidates", worklists.orphans),
    "",
    ...section("Single-source pages", worklists.singleSource),
    "",
    ...section("Sources → non-source edges", worklists.nonSourceEdges),
    "",
    ...section("Frontmatter field misses", worklists.frontmatterMisses),
    "",
    ...section("Tag inventory", worklists.tagDrift),
    "",
    ...section("Pages missing from index.md", worklists.indexMisses),
    "",
    ...section("Duplicate-title candidates", worklists.duplicateTitles),
    "",
    ...section("Dangling index entries", [
      ...worklists.danglingIndexEntries.map((line) => ({
        page: "index.md",
        detail: line,
      })),
    ]),
  ].join("\n");
}
