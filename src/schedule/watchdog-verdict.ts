/**
 * The sync-watchdog's verdict layer: pure classification over an
 * already-read heartbeat stamp and the grace references — no I/O.
 * Verdicts: fresh → one line, exit 0. Stale, unreadable, or missing
 * past the grace window → one ALERT line, exit 1 (the door owns the
 * notification and the exit). A skipped stamp is benign while its
 * ticks keep arriving and names its cause; with no successful cycle
 * on record it alerts at once naming that cause, when the last
 * success ages past the threshold the alert names it. A failed
 * stamp gets the same tolerance: one transient failure stays quiet
 * while the last success is inside the threshold, but cycles
 * failing on every tick — a fresh failed stamp, a stale lastOk —
 * alert, naming the stamp's one-line failure reason when it carries
 * one. And a stamp that itself goes stale — a scheduler that died —
 * alerts like any other. A missing stamp inside the grace window is
 * the fresh-install case: the newest of the data-repo commit date
 * and the install anchor is younger than the threshold, so the
 * first cycle has not had its chance yet and the verdict stays
 * quiet.
 */

import {
  type CycleHeartbeat,
  classifyHeartbeat,
  formatAge,
  type ReadHeartbeat,
} from "./heartbeat.ts";

/** One watchdog verdict: the exit line and code. Pure classification
 *  over the already-read heartbeat and the grace reference. */
export function watchdogVerdict(input: {
  readonly read: ReadHeartbeat;
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

  if (read.kind === "missing") {
    return missingStampVerdict({
      now,
      thresholdMs,
      newestCommitAt: input.newestCommitAt,
      installedAt: input.installedAt,
    });
  }

  if (read.kind === "unreadable") {
    return {
      line: `sync-watchdog: ALERT — heartbeat unreadable (${read.reason}); expected a stamp at outputs/last-cycle.json`,
      exitCode: 1,
    };
  }

  const verdict = presentStampVerdict(read.stamp, now, thresholdMs);

  return {
    line: `${verdict.line}${preflightNote(read.stamp)}`,
    exitCode: verdict.exitCode,
  };
}

/** The verdict over a present stamp: an ok cycle is judged by the
 *  stamp's age alone; a skipped tick or a failed cycle gets the
 *  persistent-tick verdict, which also watches the last success. */
function presentStampVerdict(
  stamp: CycleHeartbeat,
  now: Date,
  thresholdMs: number,
): { readonly line: string; readonly exitCode: 0 | 1 } {
  if (stamp.outcome === "skipped") {
    return nonOkVerdict(
      stamp,
      now,
      thresholdMs,
      "skipping",
      "scheduled cycle skipped",
    );
  }

  if (stamp.outcome === "failed") {
    return nonOkVerdict(stamp, now, thresholdMs, "failing");
  }

  const classified = classifyHeartbeat(stamp, now, thresholdMs);

  return classified.verdict === "fresh"
    ? {
        line: `sync-watchdog: fresh — last cycle ${formatAge(classified.ageMs)} ago (threshold ${formatAge(thresholdMs)})`,
        exitCode: 0 as const,
      }
    : {
        line: `sync-watchdog: ALERT — last cycle ${formatAge(classified.ageMs)} ago, past the ${formatAge(thresholdMs)} threshold`,
        exitCode: 1 as const,
      };
}

/** The verdict over a stamp whose ticks keep arriving but whose
 *  outcome is not ok — a benign skipped tick or a failed cycle. A
 *  stamp that itself went stale means the scheduler died, whatever
 *  the last outcomes said. With no success on record it alerts at
 *  once; otherwise the last successful cycle's age decides — inside
 *  the threshold one transient failure stays quiet, past it the
 *  alert names how long the pipeline has been not-ok. The stamp's
 *  reason names the cause when it carries one; a skipped tick
 *  without one falls back to its generic cause. */
function nonOkVerdict(
  stamp: CycleHeartbeat,
  now: Date,
  thresholdMs: number,
  label: string,
  fallbackCause?: string,
): { readonly line: string; readonly exitCode: 0 | 1 } {
  const classified = classifyHeartbeat(stamp, now, thresholdMs);

  // Skipping or failing is benign only while its ticks keep
  // arriving: a stamp that itself went stale means the scheduler
  // died, whatever the last outcomes said.
  if (classified.verdict === "stale") {
    return {
      line: `sync-watchdog: ALERT — last cycle ${formatAge(classified.ageMs)} ago, past the ${formatAge(thresholdMs)} threshold`,
      exitCode: 1,
    };
  }

  const cause = stamp.reason ?? fallbackCause;
  const causeNote = cause === undefined ? "" : `: ${cause}`;

  if (stamp.lastOk === null) {
    return {
      line: `sync-watchdog: ALERT — cycles ${label}${causeNote}; no successful cycle on record`,
      exitCode: 1,
    };
  }

  const lastOkAgeMs = Math.max(0, now.getTime() - Date.parse(stamp.lastOk));

  return lastOkAgeMs > thresholdMs
    ? {
        line: `sync-watchdog: ALERT — cycles ${label}${causeNote}; last successful cycle ${formatAge(lastOkAgeMs)} ago`,
        exitCode: 1,
      }
    : {
        line: `sync-watchdog: fresh — cycles ${label}${causeNote}`,
        exitCode: 0,
      };
}

/** The verdict over a missing stamp: the grace references available,
 *  newest wins — the install anchor (the upgrade path) and the
 *  newest commit date (the fresh-init fallback when no anchor was
 *  stamped). Quiet while the newest reference is inside the
 *  threshold, an alert once older; no reference at all alerts
 *  immediately. */
function missingStampVerdict(input: {
  readonly now: Date;
  readonly thresholdMs: number;
  readonly newestCommitAt: Date | undefined;
  readonly installedAt?: Date | undefined;
}): { readonly line: string; readonly exitCode: 0 | 1 } {
  const threshold = formatAge(input.thresholdMs);

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
  const refAgeMs = Math.max(0, input.now.getTime() - refAt.getTime());

  return refAgeMs <= input.thresholdMs
    ? {
        line: `sync-watchdog: no heartbeat yet — ${label} ${formatAge(refAgeMs)} old, inside the ${threshold} grace window`,
        exitCode: 0,
      }
    : {
        line: `sync-watchdog: ALERT — no heartbeat; ${label} ${formatAge(refAgeMs)} old, past the ${threshold} threshold`,
        exitCode: 1,
      };
}

/** The dormant pre-flight note appended to any verdict over a stamp
 *  whose cycle ran ungated; empty when the gate was active. */
function preflightNote(stamp: CycleHeartbeat): string {
  if (stamp.preflight === undefined) {
    return "";
  }

  const why =
    stamp.preflight === "off"
      ? "disabled by settings"
      : stamp.preflight === "no-provider"
        ? "no ingest provider configured"
        : "quota-axi not configured";

  return `; pre-flight: off — ${why}`;
}
