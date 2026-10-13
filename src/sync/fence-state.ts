/**
 * The one code-fence-state scanner for the report day files (issue
 * #459): CommonMark fence rules — an opener is up to three leading
 * spaces then three or more backticks or tildes, a backtick marker
 * whose info string carries a backtick is prose, and a fence closes
 * only on a marker of the same character at least as long — tracked
 * across a text's lines in a single pass. Every structural reader of
 * the report day files consumes it (the digest embed's demotion, the
 * checker's containment scan, the day-file section parser, the
 * pair-reference extractors), so fenced report content is never read
 * as section structure.
 */

/** One scanned body line: the text verbatim, its ATX heading depth
 *  (0 for a non-heading or fenced line), that heading's leading
 *  spaces (0 for a non-heading), whether the line lives inside a
 *  code fence (openers, closers, and fenced lines all do), and the
 *  fence still open after it. */
export interface ScannedLine {
  readonly line: string;
  readonly hashes: number;
  readonly indent: number;
  readonly fenced: boolean;
  readonly openFence: OpenFence | undefined;
}

/** An open code fence: the marker character and the minimum length
 *  that closes it. */
export interface OpenFence {
  readonly char: string;
  readonly length: number;
}

/** The fence a line opens with: an indent of up to three spaces,
 *  then three or more backticks or tildes. */
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;

/** Whether the line closes an open fence: up to three leading
 *  spaces, then a marker of the same character at least as long as
 *  the opener's, then nothing but whitespace. */
function closesFence(line: string, fence: OpenFence): boolean {
  const stripped = line.replace(/^ {0,3}/, "");
  const marker = /^(`+|~+)/.exec(stripped)?.[0];

  return (
    marker !== undefined &&
    marker[0] === fence.char &&
    marker.length >= fence.length &&
    stripped.slice(marker.length).trim() === ""
  );
}

/** The heading a non-fenced line carries — up to three leading
 *  spaces, then one to six hashes, then a space — undefined for a
 *  non-heading. */
function headingOf(
  line: string,
): { hashes: number; indent: number } | undefined {
  const match = /^ {0,3}(#{1,6}) /.exec(line);
  const hashes = match?.[1];

  if (match === null || hashes === undefined) {
    return undefined;
  }

  return {
    hashes: hashes.length,
    indent: match[0].length - hashes.length - 1,
  };
}

/** Scan a text's lines with code-fence state tracked: a fence opens
 *  on its marker line — a backtick marker whose info string carries
 *  a backtick is prose, not a fence — and closes only on a marker
 *  of the same character at least as long; lines inside a fence —
 *  the markers included — carry heading depth 0. */
export function scannedLines(text: string): readonly ScannedLine[] {
  let fence: OpenFence | undefined;

  return text.split("\n").map((line) => {
    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        fence = undefined;
      }

      return { line, hashes: 0, indent: 0, fenced: true, openFence: fence };
    }

    const match = FENCE_OPENER.exec(line);
    const marker = match?.[1];

    if (match !== null && marker !== undefined) {
      const info = line.slice(match[0].length);

      if (marker.charAt(0) !== "`" || !info.includes("`")) {
        fence = { char: marker.charAt(0), length: marker.length };

        return {
          line,
          hashes: 0,
          indent: 0,
          fenced: true,
          openFence: fence,
        };
      }
    }

    const heading = headingOf(line) ?? { hashes: 0, indent: 0 };

    return {
      line,
      hashes: heading.hashes,
      indent: heading.indent,
      fenced: false,
      openFence: undefined,
    };
  });
}

/** The fence still open at the text's end: undefined when every
 *  fence the text opens is closed. */
function openFenceAtEnd(text: string): OpenFence | undefined {
  return scannedLines(text).at(-1)?.openFence;
}

/** The line that seals a fence the content leaves open — empty when
 *  every fence is closed: the one seal every embed site composes
 *  with (the append planner's existing content and legacy body, the
 *  digest's embedded summaries). */
export function fenceSeal(text: string): string {
  const open = openFenceAtEnd(text);

  return open === undefined ? "" : `\n${open.char.repeat(open.length)}`;
}
