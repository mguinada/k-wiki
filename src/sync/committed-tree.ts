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
      untrackedSelectable.push(entry.path);
    }
  }

  if (tracked.length + untrackedSelectable.length > 0) {
    throw new Error(
      `source repo ${root} has uncommitted changes; commit before projecting — ${describeBlocking(tracked, untrackedSelectable)}`,
    );
  }
}

/** A normalized `?? ` porcelain entry: its repo-relative path
 *  (quotes stripped) and whether git reported a collapsed
 *  directory. */
interface UntrackedEntry {
  readonly path: string;
  readonly isDir: boolean;
}

/** The `?? ` porcelain entry — quotes and the collapsed-directory
 *  slash stripped — or null for tracked-change lines. */
function untrackedEntryOf(line: string): UntrackedEntry | null {
  if (!line.startsWith("?? ")) {
    return null;
  }

  const raw = line.slice(3).replace(/^"|"$/g, "");
  const isDir = raw.endsWith("/");

  return { path: isDir ? raw.slice(0, -1) : raw, isDir };
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
