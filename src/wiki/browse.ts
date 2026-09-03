import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { listWikiPages, readPageFields } from "./pages.ts";

/**
 * Wiki-browsing domain logic (guide §11), extracted from the k-wiki
 * CLI (issue #259, finding O-4): which pages list, how they group
 * into type sections, and how one page resolves by slug — including
 * the near-match suggestion. It composes the page primitives in
 * `pages.ts` into the listing and lookup shapes the CLIs render.
 * Pure over the wiki tree: no printing, no exit codes.
 */

/** The wiki page types (guide §9), listed in index.md order (guide §11). */
export const PAGE_TYPES = [
  "concept",
  "entity",
  "source",
  "query",
  "comparison",
] as const;

/** The type vocabulary widened to strings for membership checks on
 *  runtime input (cast the receiver, never the argument). */
const PAGE_TYPE_NAMES = PAGE_TYPES as readonly string[];

/** Whether `type` is one of the wiki page types (guide §9). */
export function isPageType(type: string): boolean {
  return PAGE_TYPE_NAMES.includes(type);
}

/** Navigation pages: listed by neither `list` nor typed, readable by name. */
const NAV_PAGES = new Set(["index.md", "log.md", "overview.md"]);

/** One listed page: its slug and frontmatter fields. */
export interface ListedPage {
  readonly path: string;
  readonly slug: string;
  readonly type: string | undefined;
  readonly title: string | undefined;
}

/** Collect the listable pages: every page except the navigation trio. */
export async function listablePages(wikiDir: string): Promise<ListedPage[]> {
  const pages: ListedPage[] = [];

  for (const path of await listWikiPages(wikiDir)) {
    if (NAV_PAGES.has(basename(path))) {
      continue;
    }

    const fields = await readPageFields(join(wikiDir, path));

    pages.push({
      path,
      slug: basename(path, ".md"),
      type: fields.type,
      title: fields.title,
    });
  }

  return pages;
}

const PLURAL: Record<string, string> = {
  concept: "concepts",
  entity: "entities",
  source: "sources",
  query: "queries",
  comparison: "comparisons",
};

/** One 'slug — title' line per page of one type filter. */
export function filteredLines(
  pages: readonly ListedPage[],
  typeFilter: string,
): string[] {
  return pages
    .filter((page) => page.type === typeFilter)
    .map((page) => `${page.slug} — ${page.title ?? page.slug}`);
}

/** Group the pages by frontmatter type; pages without one go to "untyped". */
export function groupPages(
  pages: readonly ListedPage[],
): Map<string, ListedPage[]> {
  const groups = new Map<string, ListedPage[]>();

  for (const page of pages) {
    const key = page.type ?? "untyped";
    const bucket = groups.get(key);

    if (bucket === undefined) {
      groups.set(key, [page]);
    } else {
      bucket.push(page);
    }
  }

  return groups;
}

/** Section order: known types in index.md order, then unknown types
 *  sorted, then untyped last. */
function sectionOrder(groups: ReadonlyMap<string, ListedPage[]>) {
  return [
    ...PAGE_TYPES.filter((type) => groups.has(type)).map((type) => ({
      key: type,
      header: PLURAL[type],
    })),
    ...[...groups.keys()]
      .filter((key) => !PAGE_TYPE_NAMES.includes(key) && key !== "untyped")
      .sort()
      .map((key) => ({ key, header: `${key}s` })),
    ...(groups.has("untyped") ? [{ key: "untyped", header: "untyped" }] : []),
  ];
}

/** Render the grouped listing: a '## header' line per section and one
 *  'slug — title' line per page under it. */
export function groupedLines(
  groups: ReadonlyMap<string, ListedPage[]>,
): string[] {
  const lines: string[] = [];

  for (const section of sectionOrder(groups)) {
    lines.push(`## ${section.header}`);

    for (const page of groups.get(section.key) ?? []) {
      lines.push(`${page.slug} — ${page.title ?? page.slug}`);
    }
  }

  return lines;
}

/** How one slug resolved against the wiki tree: the page's content,
 *  its near matches when absent, or the colliding paths when the
 *  file name is not unique. */
export type PageLookup =
  | { readonly kind: "page"; readonly content: string }
  | { readonly kind: "missing"; readonly nearMatches: readonly string[] }
  | { readonly kind: "ambiguous"; readonly matches: readonly string[] };

/** Resolve one page by file name across the wiki tree (concepts/,
 *  sources/, …): the slug matches every page whose file name is
 *  `<slug>.md`. File names must stay unique — an ambiguous name is
 *  reported, never silently resolved. An absent slug comes back
 *  with case-insensitive substring near matches. */
export async function lookupPage(
  wikiDir: string,
  slug: string,
): Promise<PageLookup> {
  const pages = await listWikiPages(wikiDir);
  const matches = pages.filter((path) => basename(path) === `${slug}.md`);

  if (matches.length === 0) {
    const lower = slug.toLowerCase();
    const near = pages
      .map((path) => basename(path, ".md"))
      .filter(
        (name) =>
          name.toLowerCase().includes(lower) ||
          lower.includes(name.toLowerCase()),
      );

    return { kind: "missing", nearMatches: near };
  }

  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }

  return {
    kind: "page",
    content: await readFile(join(wikiDir, matches[0] ?? ""), "utf8"),
  };
}
