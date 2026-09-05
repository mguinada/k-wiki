/**
 * The status `last change` fact line (issue #310): how fresh is the
 * wiki about to be read, from the one universal, honest ground truth
 * every instance has — the data repo's last commit. Status states
 * the fact; the staleness verdict stays with health's freshness
 * check. One git read, nothing else (the issue's scope stop line:
 * no page counts, no coverage, no lint state here).
 */

import { runGit } from "../data/git.ts";
import type { RunContext } from "./run-context.ts";

/** The relative-age ladder, coarsest unit first: a month is 30 days,
 *  a year 365 — display heuristics, not calendar arithmetic. The
 *  largest unit that fits the elapsed time names the age. */
const AGE_UNITS: readonly (readonly [number, string])[] = [
  [31_536_000_000, "year"],
  [2_592_000_000, "month"],
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
];

/** The elapsed age of a past moment, clamped at zero (a clock-skewed
 *  future commit reads as fresh): `just now` under a minute, then the
 *  largest fitting unit in whole counts. */
function relativeAge(past: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - past.getTime());

  for (const [span, unit] of AGE_UNITS) {
    if (span <= elapsed) {
      const count = Math.floor(elapsed / span);

      return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }

  return "just now";
}

/** A timestamp as `YYYY-MM-DD HH:mm`, local time — the line's clock
 *  reading. */
function formatStamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`
  );
}

/** The `last change:` line — the fact (or `never` for a fresh,
 *  never-committed data repo), never a verdict. */
export function lastChangeLine(
  lastCommit: Date | undefined,
  now: Date,
): string {
  if (lastCommit === undefined) {
    return "last change: never (fresh data repo)";
  }

  return `last change: ${formatStamp(lastCommit)} (${relativeAge(lastCommit, now)})`;
}

/** The data repo's last commit time (`git log -1`, committer date),
 *  undefined when the repo has no commit yet or git cannot read it. */
export async function lastCommitDate(
  context: RunContext,
): Promise<Date | undefined> {
  try {
    const { stdout } = await runGit(
      context.dataRoot,
      ["log", "-1", "--format=%cI"],
      context.env,
    );

    const parsed = new Date(stdout.trim());

    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}
