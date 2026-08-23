import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Wikilink primitives shared by `scripts/check-links.ts` (the lint a
 * human runs) and the ingest guardrails (issue #12, check 3): extract
 * every `[[wikilink]]` from markdown, map page names to files, and
 * list the pages under a wiki root.
 */

export interface Wikilink {
  /** The page name the link points at: before any alias and anchor. */
  readonly target: string;
  /** The 1-based line the link starts on. */
  readonly line: number;
  /** The original `[[...]]` text as written. */
  readonly raw: string;
}

/** The page-name part of a wikilink's inner text; empty when blank. */
export function wikilinkBodyTarget(body: string): string {
  return body.split("|")[0]?.split("#")[0]?.trim() ?? "";
}

/**
 * Extract every wikilink from markdown text, skipping fenced code
 * blocks. Aliased links keep only the page name, heading anchors are
 * dropped, and anchor-only or alias-only links are ignored.
 */
export function extractWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];
  let fenceChar: string | null = null;

  for (const [i, line] of text.split("\n").entries()) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

    if (fence !== undefined) {
      if (fenceChar === null) {
        fenceChar = fence[0] ?? null;
      } else if (fence[0] === fenceChar) {
        fenceChar = null;
      }

      continue;
    }

    if (fenceChar !== null) {
      continue;
    }

    for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = wikilinkBodyTarget(match[1] ?? "");

      if (target === "") {
        continue;
      }

      links.push({ target, line: i + 1, raw: match[0] });
    }
  }

  return links;
}

/** The reserved external link prefix: `[[engineering/<page>]]` in any
 *  non-engineering wiki refers to the engineering wiki instance's page
 *  (issue #81). Such links never resolve internally — by design — so
 *  the internal checkers skip them and `scripts/check-crosslinks.ts`
 *  validates them against the engineering wiki itself. */
const CROSS_WIKI_PREFIX = "engineering/";

/** The engineering page name of a cross-wiki target, or undefined when
 *  the target is internal. A target that is only the prefix carries no
 *  page name and stays internal (it dangles like any broken link). */
export function crossWikiTarget(target: string): string | undefined {
  if (!target.startsWith(CROSS_WIKI_PREFIX)) {
    return undefined;
  }

  const page = target.slice(CROSS_WIKI_PREFIX.length);

  return page === "" ? undefined : page;
}

/**
 * Map page names to their wiki-relative paths by file name (kebab-case
 * naming per wiki/AGENTS.md); later files win on duplicate names.
 */
export function buildPageIndex(files: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const file of files) {
    if (file.endsWith(".md")) {
      index.set(basename(file, ".md"), file);
    }
  }

  return index;
}

/** Recursively list every wiki-relative path under `dir`. */
export async function listFiles(
  dir: string,
  prefix = "",
  files: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await listFiles(join(dir, entry.name), rel, files);
    } else {
      files.push(rel);
    }
  }

  return files;
}
