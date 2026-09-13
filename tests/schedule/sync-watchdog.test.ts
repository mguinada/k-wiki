import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CycleHeartbeat } from "../../src/schedule/heartbeat.ts";
import { writeCycleHeartbeat } from "../../src/schedule/heartbeat.ts";
import { DEFAULT_STALE_AFTER_SECONDS } from "../../src/schedule/setup-schedule.ts";
import {
  main,
  parseWatchdogArgs,
  runWatchdog,
  watchdogVerdict,
} from "../../src/schedule/sync-watchdog.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;

  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temp data repo: git-initialized, one commit, no heartbeat. */
async function tempDataRoot(committedAt?: Date): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-watchdog-"));

  tempDirs.push(dir);

  const dataRoot = join(dir, "data");

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");

  const env =
    committedAt === undefined
      ? undefined
      : {
          ...process.env,
          GIT_AUTHOR_DATE: committedAt.toISOString(),
          GIT_COMMITTER_DATE: committedAt.toISOString(),
        };

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot, env });

  return dataRoot;
}

/** Write a stamp fixture with a given timestamp. */
async function putStamp(
  dataRoot: string,
  stamp: CycleHeartbeat | string,
): Promise<void> {
  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(
    join(dataRoot, "outputs", "last-cycle.json"),
    typeof stamp === "string" ? stamp : JSON.stringify(stamp),
    "utf8",
  );
}

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

describe("parseWatchdogArgs", () => {
  it("takes the stale-after value flag and two positionals", () => {
    const parsed = parseWatchdogArgs([
      "--stale-after",
      "3hours",
      "sync.json",
      "raw",
    ]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.values.get("--stale-after")).toBe("3hours");
    expect(parsed.positional).toEqual(["sync.json", "raw"]);
  });

  it("rejects a third positional", () => {
    expect(parseWatchdogArgs(["a", "b", "c"]).error).toContain(
      "expected at most two arguments",
    );
  });
});

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

describe("runWatchdog", () => {
  it("exits 0 with one line on a fresh stamp and stays silent", async () => {
    const dataRoot = await tempDataRoot();
    const lines: string[] = [];
    const notified: string[] = [];

    await putStamp(dataRoot, stamp({ timestamp: new Date().toISOString() }));

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(notified).toEqual([]);
  });

  it("exits 1 and notifies on a stale stamp", async () => {
    const dataRoot = await tempDataRoot();
    const lines: string[] = [];
    const notified: string[] = [];

    await putStamp(dataRoot, stamp());

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(code).toBe(1);
    expect(lines[0]).toContain("ALERT — last cycle 2h ago");
    expect(notified).toEqual([lines[0]]);
  });

  it("exits 1 and notifies on an unreadable stamp", async () => {
    const dataRoot = await tempDataRoot();
    const notified: string[] = [];

    await putStamp(dataRoot, "garbage bytes");

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(code).toBe(1);
    expect(notified[0]).toContain("heartbeat unreadable");
  });

  it("holds the grace window when no stamp exists and the repo is fresh", async () => {
    const dataRoot = await tempDataRoot(new Date());
    const notified: string[] = [];

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(code).toBe(0);
    expect(notified).toEqual([]);
  });

  it("alerts when no stamp exists and the newest commit is past the threshold", async () => {
    const dataRoot = await tempDataRoot(new Date("2026-09-20T09:00:00.000Z"));
    const notified: string[] = [];

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(code).toBe(1);
    expect(notified[0]).toContain("no heartbeat");
  });
  it("holds the grace on a fresh install anchor over old commits", async () => {
    const dataRoot = await tempDataRoot(new Date("2026-09-20T09:00:00.000Z"));
    const notified: string[] = [];

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await writeFile(
      join(dataRoot, "outputs", "watchdog-since.txt"),
      "2026-09-20T11:30:00.000Z\n",
      "utf8",
    );

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(code).toBe(0);
    expect(notified).toEqual([]);
  });
});

describe("runWatchdog against the heartbeat writer (fresh install flow)", () => {
  it("treats a stamp from a completed cycle as fresh", async () => {
    const dataRoot = await tempDataRoot();

    await writeCycleHeartbeat({
      dataRoot,
      outcome: "ok",
      pid: 7,
      now: new Date(),
    });

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: () => {},
    });

    expect(code).toBe(0);
  });
});

describe("main", () => {
  it("answers --help with usage and no exit code", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["--help"]);

      expect(logSpy.mock.calls.flat().join("\n")).toContain(
        "Usage: sync-watchdog",
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints one line and exits 1 for a stale stamp via the default threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-watchdog-main-"));

    tempDirs.push(dir);

    const dataRoot = await tempDataRoot();
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({ dataRoot, vaults: [] }),
      "utf8",
    );
    await putStamp(
      dataRoot,
      stamp({
        timestamp: new Date(
          Date.now() - (DEFAULT_STALE_AFTER_SECONDS + 60) * 1000,
        ).toISOString(),
      }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main([configPath]);

      expect(process.exitCode).toBe(1);
      expect(logSpy.mock.calls).toHaveLength(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toContain("ALERT — last cycle");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails loud on an invalid --stale-after value", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main(["--stale-after", "soon"]);

      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "invalid --stale-after value",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("runWatchdog against a non-repo data root", () => {
  it("alerts with no git history to hold the grace window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-watchdog-nogit-"));

    tempDirs.push(dir);

    const lines: string[] = [];

    const code = await runWatchdog({
      dataRoot: dir,
      staleAfterMs: THRESHOLD,
      log: (line) => lines.push(line),
      notify: () => {},
    });

    expect(code).toBe(1);
    expect(lines[0]).toContain("no data-repo git history");
  });
});
