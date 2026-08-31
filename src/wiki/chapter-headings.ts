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
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Every ATX heading's text in a page body — any level, outside
 *  fenced code blocks, in document order; the anchor-resolution
 *  surface for `[[page#heading]]` citations. */
export function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  let fenceChar: string | null = null;

  for (const line of body.split("\n")) {
    const fence = FENCE_OPEN.exec(line)?.[1];

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

    const text = ATX_HEADING.exec(line)?.[2];

    if (text !== undefined && text !== "") {
      headings.push(text);
    }
  }

  return headings;
}

/** The result of regenerating a hub's chapter-heading skeleton: the
 *  page text (unchanged when nothing was missing) and the chapters
 *  whose headings were appended. */
export interface HeadingInsertion {
  readonly text: string;
  readonly added: readonly string[];
}

/** Append one `## <chapter>` heading per chapter the page does not
 *  already carry — heading text byte-identical to the chapter name —
 *  after the existing body; everything already written stays
 *  byte-identical, so a re-run with no new chapters changes nothing
 *  (idempotent). */
export function insertChapterHeadings(
  text: string,
  chapters: readonly string[],
): HeadingInsertion {
  const body = bodyAfterFrontmatter(text);
  const existing = new Set(extractHeadings(body));
  const added = [...new Set(chapters)].filter(
    (chapter) => !existing.has(chapter),
  );

  if (added.length === 0) {
    return { text, added: [] };
  }

  const prefix = text.slice(0, text.length - body.length);
  const normalized = body.replace(/\s+$/, "\n");
  const blocks = added.map((chapter) => `\n## ${chapter}\n`).join("");

  return { text: `${prefix}${normalized}${blocks}`, added };
}
