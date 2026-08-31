import { unfencedLines } from "../wiki-links.ts";
import { bodyAfterFrontmatter } from "./pages.ts";

/**
 * Chapter headings (issue #226): a hub citation anchors to a real
 * target only when the hub body carries a heading whose text is
 * byte-identical to the citation's `#anchor`. Raw directory names
 * carry irregular whitespace (`27.  Digital Wallet`), so the heading
 * text is generated from the same string the citation uses — never
 * typed. The heading set derives from the hub's own `sources`
 * citation list, so it is regenerable and stays in step when
 * chapters are added or renamed.
 */

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;

/** Every ATX heading's text in a page body — any level, outside
 *  fenced code blocks, in document order; the anchor-resolution
 *  surface for `[[page#heading]]` citations. */
export function extractHeadings(body: string): string[] {
  const headings: string[] = [];

  for (const [, line] of unfencedLines(body)) {
    const text = ATX_HEADING.exec(line)?.[2];

    if (text !== undefined && text !== "") {
      headings.push(text);
    }
  }

  return headings;
}

/** The result of regenerating a hub's chapter-heading skeleton: the
 *  page text (unchanged when nothing was appended), the chapters
 *  whose headings were appended, and the chapters skipped because
 *  their generated heading does not round-trip through
 *  extractHeadings — an unclosed code fence swallows the appended
 *  line, or no ATX heading carries the chapter name
 *  byte-identically (edge whitespace is stripped). Skipped chapters
 *  are reported, never guessed, so a re-run cannot append them
 *  again. */
export interface HeadingInsertion {
  readonly text: string;
  readonly added: readonly string[];
  readonly skipped: readonly string[];
}

/** Append one `## <chapter>` heading per chapter the page does not
 *  already carry — heading text byte-identical to the chapter name —
 *  after the existing body; everything already written stays
 *  byte-identical, so a re-run with no new chapters changes nothing
 *  (idempotent). Only chapters whose appended heading survives
 *  extractHeadings are written; the rest are skipped and reported. */
export function insertChapterHeadings(
  text: string,
  chapters: readonly string[],
): HeadingInsertion {
  const body = bodyAfterFrontmatter(text);
  const existing = new Set(extractHeadings(body));
  const missing = [...new Set(chapters)].filter(
    (chapter) => !existing.has(chapter),
  );

  if (missing.length === 0) {
    return { text, added: [], skipped: [] };
  }

  const prefix = text.slice(0, text.length - body.length);
  const normalized = body.replace(/\s+$/, "\n");
  const blocks = missing.map((chapter) => `\n## ${chapter}\n`).join("");
  const visible = new Set(
    extractHeadings(bodyAfterFrontmatter(`${prefix}${normalized}${blocks}`)),
  );
  const added = missing.filter((chapter) => visible.has(chapter));

  if (added.length === 0) {
    return { text, added: [], skipped: missing };
  }

  return {
    text: `${prefix}${normalized}${added.map((chapter) => `\n## ${chapter}\n`).join("")}`,
    added,
    skipped: missing.filter((chapter) => !visible.has(chapter)),
  };
}
