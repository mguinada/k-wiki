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

    const path = untrackedEntryOf(line);

    if (path === null) {
      tracked.push(line.slice(3));
    } else if (couldBeSelected(include, path)) {
      untrackedSelectable.push(path);
    }
  }

  if (tracked.length + untrackedSelectable.length > 0) {
    throw new Error(
      `source repo ${root} has uncommitted changes; commit before projecting — ${describeBlocking(tracked, untrackedSelectable)}`,
    );
  }
}

/** The normalized path of a `?? ` porcelain line (quotes and the
 *  collapsed-directory slash stripped), or null for tracked-change
 *  lines. */
function untrackedEntryOf(line: string): string | null {
  if (!line.startsWith("?? ")) {
    return null;
  }

  const path = line.slice(3).replace(/^"|"$/g, "");

  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Whether an untracked entry could still enter the projection:
 *  ignorable only when no include pattern could possibly match it.
 *  Conservative by design — patterns are over-approximated by their
 *  literal leading segments, a pattern rooted at a wildcard (`**`,
 *  `*.md`) can reach any entry, and `.git`/`node_modules` — skipped
 *  at every walk root — are never selectable. */
function couldBeSelected(include: readonly string[], entry: string): boolean {
  const segments = entry.split("/");
  const first = segments[0];

  if (first !== undefined && SKIPPED_ROOT_DIRS.has(first)) {
    return false;
  }

  return include.some((pattern) =>
    literalSegmentsOverlap(literalPrefix(pattern), segments),
  );
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
