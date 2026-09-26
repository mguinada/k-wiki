/**
 * sync-watchdog (issue #362): the independent observer of the
 * scheduled pipeline's heartbeat. The 2026-09-13 outage taught the
 * constraint this door exists for: in-process failure logging can
 * never catch a process that failed to start (the launchd job
 * crashed with MODULE_NOT_FOUND before any code ran), so the
 * monitor must live outside the monitored pipeline. The watchdog
 * reads exactly one file — the data repo's outputs/last-cycle.json
 * heartbeat stamp, written by every completed cycle — and compares
 * its age against a staleness threshold. No git state is trusted
 * beyond the grace-window fallbacks: the newest commit date (the
 * freshness signal a stamp-less fresh init has) and the install
 * anchor setup-schedule writes when the watchdog registration is
 * installed — the upgrade path, an existing data repo whose commits
 * are old, would otherwise alert before its first cycle completes.
 *
 * Verdicts: fresh → one line, exit 0. Stale, unreadable, or missing
 * past the grace window → one line, a macOS notification
 * (osascript; KWIKI_NOTIFY=0 disables), exit 1 — launchd records
 * the non-zero exit too. A skipped stamp is benign while its ticks
 * keep arriving and names its cause; when the last success ages
 * past the threshold the alert names it, and a stamp that itself
 * goes stale — a scheduler that died — alerts like any other. A
 * missing stamp inside the grace window is
 * the fresh-install case: the newest of the data-repo commit date
 * and the install anchor is younger than the threshold, so the
 * first cycle has not had its chance yet and the watchdog stays
 * quiet.
 */

import { join } from "node:path";
import { cliFail } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";
import { runGit } from "../data/git.ts";
import {
  classifyHeartbeat,
  formatAge,
  type ReadHeartbeat,
  readCycleHeartbeat,
  readWatchdogSince,
} from "./heartbeat.ts";
import { notifyUser } from "./notify.ts";
import { resolveDataRoot } from "./scheduled-run.ts";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  parseIntervalDuration,
} from "./setup-schedule.ts";

/** The watchdog's argv shape: the staleness override plus the same
 *  two positionals scheduled-run takes (config and raw-dir), so an
 *  instance resolves its data repo exactly the way the cycle does. */
export function parseWatchdogArgs(args: readonly string[]) {
  return parseArgs(args, {
    value: ["--stale-after"],
    boolean: [],
    positionals: {
      max: 2,
      error: (_arg, count) =>
        `expected at most two arguments (<config> and <raw-dir>), got ${count}`,
    },
  });
}

/** One watchdog verdict: the exit line and code. Pure classification
 *  over the already-read heartbeat and the grace reference. */
export function watchdogVerdict(input: {
  readonly read: Awaited<ReturnType<typeof readCycleHeartbeat>>;
  readonly now: Date;
  readonly thresholdMs: number;
  /** The newest data-repo commit date, one grace reference when no
   *  stamp exists; undefined when git could not answer. */
  readonly newestCommitAt: Date | undefined;
  /** The install anchor setup-schedule wrote at watchdog install,
   *  the other grace reference; optional. */
  readonly installedAt?: Date | undefined;
}): { readonly line: string; readonly exitCode: 0 | 1 } {
  const { now, thresholdMs, read } = input;
  const threshold = formatAge(thresholdMs);

  if (read.kind === "missing") {
    /** The grace references available, newest wins: the install
     *  anchor (the upgrade path) and the newest commit date (the
     *  fresh-init fallback when no anchor was stamped). */
    const refs: readonly (readonly [string, Date])[] = [
      ...(input.newestCommitAt === undefined
        ? []
        : [["newest data-repo commit", input.newestCommitAt] as const]),
      ...(input.installedAt === undefined
        ? []
        : [["watchdog install", input.installedAt] as const]),
    ];

    if (refs.length === 0) {
      return {
        line: `sync-watchdog: ALERT — no heartbeat and no data-repo git history or install anchor to hold the grace window (threshold ${threshold})`,
        exitCode: 1,
      };
    }

    const [label, refAt] = refs.reduce((a, b) => (b[1] > a[1] ? b : a));
    const refAgeMs = Math.max(0, now.getTime() - refAt.getTime());

    return refAgeMs <= thresholdMs
      ? {
          line: `sync-watchdog: no heartbeat yet — ${label} ${formatAge(refAgeMs)} old, inside the ${threshold} grace window`,
          exitCode: 0,
        }
      : {
          line: `sync-watchdog: ALERT — no heartbeat; ${label} ${formatAge(refAgeMs)} old, past the ${threshold} threshold`,
          exitCode: 1,
        };
  }

  if (read.kind === "unreadable") {
    return {
      line: `sync-watchdog: ALERT — heartbeat unreadable (${read.reason}); expected a stamp at outputs/last-cycle.json`,
      exitCode: 1,
    };
  }

  const classified = classifyHeartbeat(read.stamp, now, thresholdMs);

  const verdict =
    read.stamp.outcome === "skipped"
      ? skippedVerdict(read.stamp, now, thresholdMs)
      : classified.verdict === "fresh"
        ? {
            line: `sync-watchdog: fresh — last cycle ${formatAge(classified.ageMs)} ago (threshold ${threshold})`,
            exitCode: 0 as const,
          }
        : {
            line: `sync-watchdog: ALERT — last cycle ${formatAge(classified.ageMs)} ago, past the ${threshold} threshold`,
            exitCode: 1 as const,
          };

  return {
    line: `${verdict.line}${preflightNote(read.stamp)}`,
    exitCode: verdict.exitCode,
  };
}

function skippedVerdict(
  stamp: NonNullable<Extract<ReadHeartbeat, { kind: "present" }>["stamp"]>,
  now: Date,
  thresholdMs: number,
): { readonly line: string; readonly exitCode: 0 | 1 } {
  const classified = classifyHeartbeat(stamp, now, thresholdMs);

  // Skipping is benign only while its ticks keep arriving: a stamp
  // that itself went stale means the scheduler died, whatever the
  // last outcomes said.
  if (classified.verdict === "stale") {
    return {
      line: `sync-watchdog: ALERT — last cycle ${formatAge(classified.ageMs)} ago, past the ${formatAge(thresholdMs)} threshold`,
      exitCode: 1,
    };
  }

  const lastOkAgeMs =
    stamp.lastOk === null
      ? 0
      : Math.max(0, now.getTime() - Date.parse(stamp.lastOk));
  const cause = stamp.reason ?? "scheduled cycle skipped";

  return lastOkAgeMs > thresholdMs
    ? {
        line: `sync-watchdog: ALERT — cycles skipping: ${cause}; last successful cycle ${formatAge(lastOkAgeMs)} ago`,
        exitCode: 1,
      }
    : {
        line: `sync-watchdog: fresh — cycles skipping: ${cause}`,
        exitCode: 0,
      };
}

/** The dormant pre-flight note appended to any verdict over a stamp
 *  whose cycle ran ungated; empty when the gate was active. */
function preflightNote(
  stamp: NonNullable<Extract<ReadHeartbeat, { kind: "present" }>["stamp"]>,
): string {
  if (stamp.preflight === undefined) {
    return "";
  }

  const why =
    stamp.preflight === "off"
      ? "disabled by settings"
      : "quota-axi not configured";

  return `; pre-flight: off — ${why}`;
}

/** The newest data-repo commit date, the fresh-install grace
 *  reference for a missing stamp; undefined when git could not
 *  answer (no repo, no commits). */
export async function newestCommitDate(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<Date | undefined> {
  const { stdout } = await runGit(dataRoot, ["log", "-1", "--format=%cI"], env);
  const date = new Date(stdout.trim());

  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Run one watchdog pass against a data repo: read the heartbeat,
 *  classify, print exactly one line, notify on a non-zero verdict.
 *  Returns the exit code (0 fresh, 1 not). */
export async function runWatchdog(options: {
  readonly dataRoot: string;
  readonly staleAfterMs: number;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
  /** Alert notifier; default silent (the CLI main wires the macOS
   *  notification). */
  readonly notify?: (message: string) => void | Promise<void>;
}): Promise<0 | 1> {
  const notify = options.notify ?? (() => {});
  const log = options.log ?? ((line: string) => console.log(line));
  const read = await readCycleHeartbeat(options.dataRoot);

  let newestCommitAt: Date | undefined;
  let installedAt: Date | undefined;

  if (read.kind === "missing") {
    newestCommitAt = await newestCommitDate(
      options.dataRoot,
      options.env ?? process.env,
    ).catch(() => undefined);
    installedAt = await readWatchdogSince(options.dataRoot).catch(
      () => undefined,
    );
  }

  const verdict = watchdogVerdict({
    read,
    now: (options.now ?? (() => new Date()))(),
    thresholdMs: options.staleAfterMs,
    newestCommitAt,
    installedAt,
  });

  log(verdict.line);

  if (verdict.exitCode === 1) {
    await notify(verdict.line);
  }

  return verdict.exitCode;
}

/** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: sync-watchdog [-h | --help] [--stale-after <duration>] [<config>] [<raw-dir>]

The heartbeat watchdog: read the data repo's outputs/last-cycle.json
stamp (written by every completed scheduled-run cycle — ok, failed,
or a benign quota-skipped tick) and report whether the pipeline is
alive. The stamp's age is the verdict: within the threshold prints
one line and exits 0; past it — or unreadable, or missing past the
grace window — prints one line, fires a macOS notification
(osascript; KWIKI_NOTIFY=0 disables every notification), and exits 1
(launchd records the failure). A quota-skipped stamp is benign while
its ticks keep arriving and names its cause; when the last
successful cycle ages past the threshold the watchdog alerts naming
that cause, and a stamp that itself goes stale — a scheduler that
died — alerts like any other. A stamp whose cycle ran with the
quota pre-flight dormant carries a "pre-flight: off" note. The
watchdog is independent of the monitored pipeline by design: a
cycle that never started leaves no log line, but a stalling
heartbeat is visible from outside.

  --stale-after <duration>  The staleness threshold, e.g. 90minutes
                            (the default: three 30-minute run
                            intervals), 3hours, 45minutes. A stamp
                            at least this old still counts as
                            fresh; older alerts.
  -h, --help                Print this help and exit; no side
                            effects.
  <config>                  The sync config naming the data repo.
                            Default: the repo's sync.json.
  <raw-dir>                 The raw projection directory; its
                            parent names the data repo. Default:
                            the config's raw dir.

Grace window: a fresh install has no stamp until the first cycle
completes. While no stamp exists, the newest of the data-repo
commit date and the install anchor (the ISO line setup-schedule
writes when the watchdog registration installs — the upgrade path,
an existing data repo whose commits are old) holds the grace:
quiet while inside the threshold, an alert once older. An
unreadable stamp alerts immediately: torn bytes must never read
as fresh.

Reads the stamp file and (only when it is missing) the newest git
commit date and the install anchor; writes nothing. The launchd
registration
com.kwiki.watchdog (setup-schedule --watchdog) runs this door
hourly.

Exits 0 on a fresh (or in-grace) heartbeat, 1 on stale, unreadable,
missing-past-grace, or quota-skipped ticks persisting past the
threshold.`;

/** sync-watchdog entry point. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseWatchdogArgs(args);

  if (parsed.error !== undefined) {
    cliFail("sync-watchdog", parsed.error);

    return;
  }

  const staleAfterText = parsed.values.get("--stale-after");

  if (parsed.values.has("--stale-after") && staleAfterText === undefined) {
    cliFail(
      "sync-watchdog",
      "--stale-after needs a duration value (e.g. 90minutes)",
    );

    return;
  }

  const staleAfterSeconds =
    staleAfterText === undefined
      ? DEFAULT_STALE_AFTER_SECONDS
      : parseIntervalDuration(staleAfterText);

  if (staleAfterSeconds === undefined) {
    cliFail(
      "sync-watchdog",
      `invalid --stale-after value ${JSON.stringify(staleAfterText)} — use <n><unit> with unit seconds|minutes|hours (e.g. 90minutes)`,
    );

    return;
  }

  const resolved = await resolveDataRoot(
    parsed.positional[0] ?? join(repoRoot, "sync.json"),
    parsed.positional[1],
  );

  if (resolved.error !== undefined) {
    cliFail("sync-watchdog", resolved.error);

    return;
  }

  const exitCode = await runWatchdog({
    dataRoot: resolved.dataRoot,
    staleAfterMs: staleAfterSeconds * 1000,
    notify: async (message) => {
      await notifyUser("k-wiki", message);
    },
  });

  process.exitCode = exitCode;
}

/* v8 ignore next: covered only under direct `node src/schedule/sync-watchdog.ts` runs */
refuseDirectExecution(import.meta.url, "sync-watchdog");
