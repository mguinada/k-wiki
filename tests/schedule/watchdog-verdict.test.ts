import { describe, expect, it } from "vitest";
import type { CycleHeartbeat } from "../../src/schedule/heartbeat.ts";
import { watchdogVerdict } from "../../src/schedule/watchdog-verdict.ts";

function stamp(overrides: Partial<CycleHeartbeat> = {}): CycleHeartbeat {
  return {
    timestamp: "2026-09-20T10:00:00.000Z",
    outcome: "ok",
    pid: 1,
    lastOk: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-20T12:00:00.000Z");
const THRESHOLD = 90 * 60_000;

describe("watchdogVerdict", () => {
  it("reports a fresh stamp with age and threshold, exit 0", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({ timestamp: "2026-09-20T11:00:00.000Z" }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: fresh — last cycle 1h ago (threshold 1h 30m)",
      exitCode: 0,
    });
  });

  it("reports a stale stamp with age and threshold, exit 1", () => {
    expect(
      watchdogVerdict({
        read: { kind: "present", stamp: stamp() },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — last cycle 2h ago, past the 1h 30m threshold",
      exitCode: 1,
    });
  });

  it("reports persistent skipped cycles with their cause", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "skipped",
            reason: "ingest provider zai exhausted until reset",
            lastOk: "2026-09-20T10:00:00.000Z",
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — cycles skipping: ingest provider zai exhausted until reset; last successful cycle 2h ago",
      exitCode: 1,
    });
  });

  it("fires the never-succeeded alert on a fresh skipped stamp with no success on record", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "skipped",
            reason: "ingest provider zai exhausted until reset",
            lastOk: null,
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — cycles skipping: ingest provider zai exhausted until reset; no successful cycle on record",
      exitCode: 1,
    });
  });

  it("keeps a fresh skipped stamp benign while a recent success is on record", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "skipped",
            reason: "ingest provider zai exhausted until reset",
            lastOk: "2026-09-20T11:55:00.000Z",
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: fresh — cycles skipping: ingest provider zai exhausted until reset",
      exitCode: 0,
    });
  });

  it("alerts when skipped ticks stop arriving before any success", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "skipped",
            reason: "ingest provider zai exhausted until reset",
            lastOk: null,
            timestamp: "2026-09-20T10:00:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — last cycle 2h ago, past the 1h 30m threshold",
      exitCode: 1,
    });
  });

  it("alerts when skipped ticks stop arriving after a recent success", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "skipped",
            reason: "ingest provider zai exhausted until reset",
            lastOk: "2026-09-20T11:55:00.000Z",
            timestamp: "2026-09-20T10:00:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — last cycle 2h ago, past the 1h 30m threshold",
      exitCode: 1,
    });
  });

  it("fires the never-succeeded alert on a fresh failed stamp with no success on record", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "failed",
            reason: "wiki-sync: proposed removals need a receipt",
            lastOk: null,
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — cycles failing: wiki-sync: proposed removals need a receipt; no successful cycle on record",
      exitCode: 1,
    });
  });

  it("alerts on a fresh failed stamp whose last success aged past the threshold", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "failed",
            reason: "wiki-sync: proposed removals need a receipt",
            lastOk: "2026-09-20T10:00:00.000Z",
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — cycles failing: wiki-sync: proposed removals need a receipt; last successful cycle 2h ago",
      exitCode: 1,
    });
  });

  it("alerts on a fresh failed stamp without a recorded reason", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "failed",
            lastOk: "2026-09-20T10:00:00.000Z",
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — cycles failing; last successful cycle 2h ago",
      exitCode: 1,
    });
  });

  it("keeps a fresh failed stamp benign while a recent success is on record", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "failed",
            reason: "wiki-sync: proposed removals need a receipt",
            lastOk: "2026-09-20T11:55:00.000Z",
            timestamp: "2026-09-20T11:55:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: fresh — cycles failing: wiki-sync: proposed removals need a receipt",
      exitCode: 0,
    });
  });

  it("alerts when a failed stamp stops arriving", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            outcome: "failed",
            reason: "wiki-sync: proposed removals need a receipt",
            lastOk: "2026-09-20T10:00:00.000Z",
            timestamp: "2026-09-20T10:00:00.000Z",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — last cycle 2h ago, past the 1h 30m threshold",
      exitCode: 1,
    });
  });

  it("surfaces a dormant quota pre-flight on the verdict line", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            timestamp: "2026-09-20T11:00:00.000Z",
            preflight: "unavailable",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: fresh — last cycle 1h ago (threshold 1h 30m); pre-flight: off — quota-axi not configured",
      exitCode: 0,
    });
  });

  it("names settings as the reason when the pre-flight is off", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            timestamp: "2026-09-20T11:00:00.000Z",
            preflight: "off",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: fresh — last cycle 1h ago (threshold 1h 30m); pre-flight: off — disabled by settings",
      exitCode: 0,
    });
  });

  it("names the missing provider when the stamp records no-provider", () => {
    expect(
      watchdogVerdict({
        read: {
          kind: "present",
          stamp: stamp({
            timestamp: "2026-09-20T11:00:00.000Z",
            preflight: "no-provider",
          }),
        },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: fresh — last cycle 1h ago (threshold 1h 30m); pre-flight: off — no ingest provider configured",
      exitCode: 0,
    });
  });

  it("holds the grace window for a missing stamp inside the threshold", () => {
    expect(
      watchdogVerdict({
        read: { kind: "missing" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: new Date("2026-09-20T11:00:00.000Z"),
      }),
    ).toEqual({
      line: "sync-watchdog: no heartbeat yet — newest data-repo commit 1h old, inside the 1h 30m grace window",
      exitCode: 0,
    });
  });

  it("alerts for a missing stamp past the grace window", () => {
    expect(
      watchdogVerdict({
        read: { kind: "missing" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: new Date("2026-09-20T09:00:00.000Z"),
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — no heartbeat; newest data-repo commit 3h old, past the 1h 30m threshold",
      exitCode: 1,
    });
  });

  it("holds the grace on a fresh install anchor even when commits are old", () => {
    expect(
      watchdogVerdict({
        read: { kind: "missing" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: new Date("2026-09-20T09:00:00.000Z"),
        installedAt: new Date("2026-09-20T11:30:00.000Z"),
      }),
    ).toEqual({
      line: "sync-watchdog: no heartbeat yet — watchdog install 30m old, inside the 1h 30m grace window",
      exitCode: 0,
    });
  });

  it("alerts once the install anchor passes the threshold", () => {
    expect(
      watchdogVerdict({
        read: { kind: "missing" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
        installedAt: new Date("2026-09-20T08:00:00.000Z"),
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — no heartbeat; watchdog install 4h old, past the 1h 30m threshold",
      exitCode: 1,
    });
  });

  it("prefers the newer grace reference: a fresh commit over an old anchor", () => {
    expect(
      watchdogVerdict({
        read: { kind: "missing" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: new Date("2026-09-20T11:00:00.000Z"),
        installedAt: new Date("2026-09-20T08:00:00.000Z"),
      }),
    ).toEqual({
      line: "sync-watchdog: no heartbeat yet — newest data-repo commit 1h old, inside the 1h 30m grace window",
      exitCode: 0,
    });
  });

  it("alerts for a missing stamp with no git history to hold the grace", () => {
    expect(
      watchdogVerdict({
        read: { kind: "missing" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — no heartbeat and no data-repo git history or install anchor to hold the grace window (threshold 1h 30m)",
      exitCode: 1,
    });
  });

  it("alerts for an unreadable stamp", () => {
    expect(
      watchdogVerdict({
        read: { kind: "unreadable", reason: "not valid JSON" },
        now: NOW,
        thresholdMs: THRESHOLD,
        newestCommitAt: undefined,
      }),
    ).toEqual({
      line: "sync-watchdog: ALERT — heartbeat unreadable (not valid JSON); expected a stamp at outputs/last-cycle.json",
      exitCode: 1,
    });
  });
});
