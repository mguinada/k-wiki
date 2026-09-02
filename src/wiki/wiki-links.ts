import { basename } from "node:path";

/** The page-name stem of a wiki-relative path: the file name without
 *  the .md suffix — the name a [[wikilink]] targets. */
export function stem(file: string): string {
  return basename(file, ".md");
}

/**
 * Wikilink primitives shared by `scripts/check-links.ts` (the lint a
 * human runs) and the ingest guardrails (issue #12, check 3): extract
 * every `[[wikilink]]` from markdown and map page names to files.
 */

export interface Wikilink {
  /** The page name the link points at: before any alias and anchor. */
  readonly target: string;
  /** The 1-based line the link starts on. */
  readonly line: number;
  /** The original `[[...]]` text as written. */
  readonly raw: string;
  /** The heading anchor after the page name, as written
   *  (`[[hub#A#B|chip]]` → `A#B`); undefined for anchorless links,
   *  empty anchors, and `#^block-id` references — blocks are not
   *  headings, and Obsidian block semantics stay out of scope
   *  (issue #235). */
  readonly anchor?: string | undefined;
}

/** The body of a bracketed wikilink entry — the text between the
 *  double brackets — the one `[[…]]` strip (issue #255, dedup
 *  D-21) shared by page-name, anchor, and alias readers. */
export function wikilinkBody(entry: string): string {
  return entry.slice(2, -2);
}

/** The page-name part of a wikilink's inner text; empty when blank. */
export function wikilinkBodyTarget(body: string): string {
  /* v8 ignore next: split never yields undefined — the fallback satisfies the type system only */
  return body.split("|")[0]?.split("#")[0]?.trim() ?? "";
}

/** The heading-anchor part of a wikilink's inner text, before any
 *  alias: `hub#Chapter` → `Chapter`, multi-level paths as written
 *  (`hub#A#B` → `A#B`); undefined for empty anchors and `#^block`
 *  references. The one parser every anchor consumer shares —
 *  body-text link checking (issue #235) and `sources` citations
 *  (issue #226, via citationAnchor) — so the surfaces cannot drift. */
export function wikilinkBodyAnchor(body: string): string | undefined {
  /* v8 ignore next: split never yields undefined — the fallback satisfies the type system only */
  const anchor = body.split("|")[0]?.split("#").slice(1).join("#") ?? "";

  return anchor === "" || anchor.startsWith("^") ? undefined : anchor;
}

/** A line's fence marker — 0–3 leading spaces, then 3+ backticks or
 *  tildes — as the marker run plus the rest of the line (the info
 *  string, trimmed); null when the line is not a fence marker. */
function fenceMarker(line: string): { chars: string; info: string } | null {
  const chars = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

  if (chars === undefined) {
    return null;
  }

  return {
    chars,
    info: line.slice(line.indexOf(chars) + chars.length).trim(),
  };
}

/** Whether one fence marker closes an open fence, per CommonMark:
 *  bare (no info string), same character, at least the opening
 *  length (issue #246 C-10). */
function closesFence(
  marker: { chars: string; info: string },
  open: { char: string; length: number },
): boolean {
  return (
    marker.chars.slice(0, 1) === open.char &&
    marker.chars.length >= open.length &&
    marker.info === ""
  );
}

/** Every non-fence line of a markdown text as `[index, line]`
 *  pairs (0-based source line; fence lines and fenced content
 *  skipped) — the shared scanner for wikilink and heading
 *  extraction, so fence semantics cannot drift between them.
 *  Fences follow CommonMark's closing rule: any 3+ backtick/tilde
 *  marker opens (an info string is allowed on the opener), while a
 *  closing fence must be bare, use the same character, and be at
 *  least as long as the opener (issue #246 C-10). */
export function* unfencedLines(
  text: string,
): Generator<[number, string], void, unknown> {
  let open: { char: string; length: number } | null = null;

  for (const [i, line] of text.split("\n").entries()) {
    const marker = fenceMarker(line);

    if (marker === null) {
      if (open === null) {
        yield [i, line];
      }

      continue;
    }

    if (open === null) {
      open = {
        char: marker.chars.slice(0, 1),
        length: marker.chars.length,
      };
    } else if (closesFence(marker, open)) {
      open = null;
    }
  }
}

/**
 * Extract every wikilink from markdown text, skipping fenced code
 * blocks. Aliased links keep only the page name, the heading anchor
 * is kept as written on the `anchor` field, and anchor-only or
 * alias-only links are ignored.
 */
export function extractWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];

  for (const [i, line] of unfencedLines(text)) {
    for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      /* v8 ignore next: the regex guarantees group 1 on every match — fallback is for the type system */
      const inner = match[1] ?? "";
      const target = wikilinkBodyTarget(inner);

      if (target === "") {
        continue;
      }

      links.push({
        target,
        line: i + 1,
        raw: match[0],
        anchor: wikilinkBodyAnchor(inner),
      });
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
