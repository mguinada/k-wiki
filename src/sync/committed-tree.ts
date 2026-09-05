import { literalPrefix, SKIPPED_ROOT_DIRS } from "./projection.ts";

/**
 * The committed-tree guard (issues #74, #312): SHA grounding
 * requires a source repository whose recorded commit describes the
 * projected content exactly — the truth anchor behind `health`
 * freshness and `check-raw --fail-on-stale`. Tracked modifications
 * always block; untracked entries block only when the include
 * allowlist could select them — scratch the projection can never
 * reach changes neither content nor manifest. Entries are
 * over-approximated, never exactly resolved: porcelain collapses
 * untracked directories, and the guard is allowed to block more
 * than strictly necessary, never less.
 */

/** Refuse a projection of `root` unless its `git status --porcelain`
 *  output is committed modulo unselectable untracked scratch; names
 *  up to five blocking paths per bucket so the operator sees which
 *  file to commit, ignore, or move. */
export function assertNoBlockingChanges(
  porcelain: string,
  root: string,
  include: readonly string[],
): void {
  const tracked: string[] = [];
  const untrackedSelectable: string[] = [];

  for (const line of porcelain.split("\n")) {
    if (line === "") {
      continue;
    }

    const entry = untrackedEntryOf(line);

    if (entry === null) {
      tracked.push(line.slice(3));
    } else if (couldBeSelected(include, entry)) {
      untrackedSelectable.push(entry.path ?? entry.raw);
    }
  }

  if (tracked.length + untrackedSelectable.length > 0) {
    throw new Error(
      `source repo ${root} has uncommitted changes; commit before projecting — ${describeBlocking(tracked, untrackedSelectable)}`,
    );
  }
}

/** A normalized `?? ` porcelain entry: its repo-relative path
 *  with git's C-style quoting decoded, and whether git reported a
 *  collapsed directory. `path` is null when the quoted bytes are
 *  not valid UTF-8 — such an entry still blocks, named by its raw
 *  porcelain field. */
interface UntrackedEntry {
  readonly path: string | null;
  readonly isDir: boolean;
  readonly raw: string;
}

/** The `?? ` porcelain entry — outer quotes, C-style escapes, and
 *  the collapsed-directory slash decoded — or null for
 *  tracked-change lines. */
function untrackedEntryOf(line: string): UntrackedEntry | null {
  if (!line.startsWith("?? ")) {
    return null;
  }

  const field = line.slice(3);
  const isDir = field.endsWith("/");
  const quoted = field.startsWith('"');
  const body = quoted ? field.slice(1, -1) : field;
  const decoded = quoted ? decodeCQuoted(body) : body;
  const path = decoded === null ? null : isDir ? decoded.slice(0, -1) : decoded;

  return { path, isDir, raw: field };
}

/** The byte each single-character C-style escape of a quoted
 *  porcelain path stands for. */
const ESCAPE_BYTES: Readonly<Record<string, number>> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/** Decode the body of a quoted porcelain path — backslash escapes
 *  and octal byte sequences — into the path git printed, or null
 *  when it is malformed or the bytes are not valid UTF-8. */
function decodeCQuoted(body: string): string | null {
  const utf8 = new TextEncoder();
  const bytes: number[] = [];
  let literal = "";

  const flushLiteral = (): void => {
    bytes.push(...utf8.encode(literal));

    literal = "";
  };

  for (let index = 0; index < body.length; ) {
    const char = body[index];

    if (char !== "\\") {
      literal += char;
      index += 1;

      continue;
    }

    flushLiteral();

    const decoded = decodeEscapeAt(body, index, bytes);

    if (decoded === null) {
      return null;
    }

    index += decoded;
  }

  flushLiteral();

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return null;
  }
}

/** Consume the escape starting at `index` in `body`, push its byte,
 *  and return how many characters it spans, or null when the
 *  escape is malformed. */
function decodeEscapeAt(
  body: string,
  index: number,
  bytes: number[],
): number | null {
  const escaped = body[index + 1];

  if (escaped === undefined) {
    return null;
  }

  const simple = ESCAPE_BYTES[escaped];

  if (simple !== undefined) {
    bytes.push(simple);

    return 2;
  }

  const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));

  if (octal === null) {
    return null;
  }

  bytes.push(Number.parseInt(octal[0], 8));

  return 1 + octal[0].length;
}

/** Whether an untracked entry could still enter the projection:
 *  ignorable only when no include pattern could possibly match it.
 *  Conservative by design — patterns are over-approximated by their
 *  literal leading segments, a pattern rooted at a wildcard (`**`,
 *  `*.md`) can reach any entry, and a `.git`/`node_modules`
 *  directory is skipped only by a whole-root walk — a pattern whose
 *  literal prefix is empty — while patterns rooted at or under it
 *  (exact files, walk roots) still select. */
function couldBeSelected(
  include: readonly string[],
  entry: UntrackedEntry,
): boolean {
  if (entry.path === null) {
    return true;
  }

  const segments = entry.path.split("/");
  const first = segments[0];
  const skippedDir =
    entry.isDir && first !== undefined && SKIPPED_ROOT_DIRS.has(first);

  return include.some((pattern) => {
    const prefix = literalPrefix(pattern);

    if (skippedDir && prefix.length === 0) {
      return false;
    }

    return literalSegmentsOverlap(prefix, segments);
  });
}

/** Whether a pattern's literal leading segments and an untracked
 *  entry sit on the same path branch — one is an ancestor-or-equal of
 *  the other: the pattern's walk covers the entry, or descends into
 *  (or lives inside) a collapsed untracked directory. An empty
 *  prefix overlaps every entry. */
function literalSegmentsOverlap(
  prefix: readonly string[],
  segments: readonly string[],
): boolean {
  const shared = Math.min(prefix.length, segments.length);

  for (let index = 0; index < shared; index += 1) {
    if (prefix[index] !== segments[index]) {
      return false;
    }
  }

  return true;
}

const LISTED_PATHS = 5;

function describeBlocking(
  tracked: readonly string[],
  untracked: readonly string[],
): string {
  const parts: string[] = [];

  if (tracked.length > 0) {
    parts.push(`tracked: ${listPaths(tracked)}`);
  }

  if (untracked.length > 0) {
    parts.push(`untracked-selectable: ${listPaths(untracked)}`);
  }

  return parts.join("; ");
}

function listPaths(paths: readonly string[]): string {
  const listed = paths.slice(0, LISTED_PATHS).join(", ");
  const extra = paths.length - LISTED_PATHS;

  return extra > 0 ? `${listed} (+${extra} more)` : listed;
}
