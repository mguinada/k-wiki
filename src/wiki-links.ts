import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/** The page-name stem of a wiki-relative path: the file name without
 *  the .md suffix — the name a [[wikilink]] targets. */
export function stem(file: string): string {
  return basename(file, ".md");
}

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

/** Every non-fence line of a markdown text as `[index, line]`
 *  pairs (0-based source line; fence lines and fenced content
 *  skipped) — the shared scanner for wikilink and heading
 *  extraction, so fence semantics cannot drift between them. */
export function* unfencedLines(
  text: string,
): Generator<[number, string], void, unknown> {
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

    yield [i, line];
  }
}

/**
 * Extract every wikilink from markdown text, skipping fenced code
 * blocks. Aliased links keep only the page name, heading anchors are
 * dropped, and anchor-only or alias-only links are ignored.
 */
export function extractWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];

  for (const [i, line] of unfencedLines(text)) {
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

/** A wikilink target naming a page of another wiki instance (issue
 *  #81): any target containing a `/` is cross-wiki — `[[<vault>/<page>]]`,
 *  where `<vault>` is a domain wiki's vault name. Bare targets are
 *  internal: page names come from file names, which cannot contain a
 *  slash. A vault segment carrying a protocol (`http:`, `file:`, …) is
 *  a URL, not a vault name. The internal checkers skip cross-wiki
 *  targets and `scripts/check-crosslinks.ts` validates them against
 *  the named domain wiki. */
export interface CrossWikiTarget {
  /** The vault segment before the first slash, case as written. */
  readonly vault: string;
  /** The page segment after the first slash, as written. */
  readonly page: string;
}

const PROTOCOL_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The vault and page of a cross-wiki target, or undefined when the
 *  target is internal (no slash), a bare prefix with no page, or a
 *  protocol URL. */
export function crossWikiTarget(target: string): CrossWikiTarget | undefined {
  const separator = target.indexOf("/");

  if (separator === -1) {
    return undefined;
  }

  const vault = target.slice(0, separator);
  const page = target.slice(separator + 1);

  if (vault === "" || page === "" || PROTOCOL_PREFIX.test(vault)) {
    return undefined;
  }

  return { vault, page };
}

/**
 * Map page names to their wiki-relative paths by file name (kebab-case
 * naming per wiki/AGENTS.md); later files win on duplicate names.
 */
export function buildPageIndex(files: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const file of files) {
    if (file.endsWith(".md")) {
      index.set(stem(file), file);
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
