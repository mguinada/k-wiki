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
  it("parses without error", () => {
    const parsed = parseWatchdogArgs([
      "--stale-after",
      "3hours",
      "sync.json",
      "raw",
    ]);

    expect(parsed.error).toBeUndefined();
  });

  it("reads the --stale-after value", () => {
    const parsed = parseWatchdogArgs([
      "--stale-after",
      "3hours",
      "sync.json",
      "raw",
    ]);

    expect(parsed.values.get("--stale-after")).toBe("3hours");
  });

  it("reads the two positionals", () => {
    const parsed = parseWatchdogArgs([
      "--stale-after",
      "3hours",
      "sync.json",
      "raw",
    ]);

    expect(parsed.positional).toEqual(["sync.json", "raw"]);
  });

  it("rejects a third positional", () => {
    expect(parseWatchdogArgs(["a", "b", "c"]).error).toContain(
      "expected at most two arguments",
    );
  });
});

describe("runWatchdog", () => {
  it("exits 0 on a fresh stamp", async () => {
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
  });

  it("prints one line on a fresh stamp", async () => {
    const dataRoot = await tempDataRoot();

    const lines: string[] = [];

    const notified: string[] = [];

    await putStamp(dataRoot, stamp({ timestamp: new Date().toISOString() }));

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(lines).toHaveLength(1);
  });

  it("stays silent on a fresh stamp", async () => {
    const dataRoot = await tempDataRoot();

    const lines: string[] = [];

    const notified: string[] = [];

    await putStamp(dataRoot, stamp({ timestamp: new Date().toISOString() }));

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(notified).toEqual([]);
  });

  it("exits 1 on a stale stamp", async () => {
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
  });

  it("alerts naming the last cycle age", async () => {
    const dataRoot = await tempDataRoot();

    const lines: string[] = [];

    const notified: string[] = [];

    await putStamp(dataRoot, stamp());

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(lines[0]).toContain("ALERT — last cycle 2h ago");
  });

  it("notifies with the alert line", async () => {
    const dataRoot = await tempDataRoot();

    const lines: string[] = [];

    const notified: string[] = [];

    await putStamp(dataRoot, stamp());

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(notified).toEqual([lines[0]]);
  });

  it("exits 1 and notifies on a fresh failed stamp whose success aged out", async () => {
    const dataRoot = await tempDataRoot();
    const lines: string[] = [];
    const notified: string[] = [];

    await putStamp(
      dataRoot,
      stamp({
        outcome: "failed",
        reason: "wiki-sync: proposed removals need a receipt",
        lastOk: "2026-09-20T10:00:00.000Z",
        timestamp: "2026-09-20T11:55:00.000Z",
      }),
    );

    const code = await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: (line) => lines.push(line),
      notify: (message) => {
        notified.push(message);
      },
    });

    expect({ code, lines, notified }).toEqual({
      code: 1,
      lines: [
        "sync-watchdog: ALERT — cycles failing: wiki-sync: proposed removals need a receipt; last successful cycle 2h ago",
      ],
      notified: [
        "sync-watchdog: ALERT — cycles failing: wiki-sync: proposed removals need a receipt; last successful cycle 2h ago",
      ],
    });
  });

  it("exits 1 on an unreadable stamp", async () => {
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
  });

  it("notifies naming the unreadable heartbeat", async () => {
    const dataRoot = await tempDataRoot();

    const notified: string[] = [];

    await putStamp(dataRoot, "garbage bytes");

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(notified[0]).toContain("heartbeat unreadable");
  });

  it("holds the grace window with no stamp on a fresh repo", async () => {
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
  });

  it("stays silent inside the grace window", async () => {
    const dataRoot = await tempDataRoot(new Date());

    const notified: string[] = [];

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(notified).toEqual([]);
  });

  it("exits 1 when no stamp exists past the threshold", async () => {
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
  });

  it("alerts that no heartbeat exists", async () => {
    const dataRoot = await tempDataRoot(new Date("2026-09-20T09:00:00.000Z"));

    const notified: string[] = [];

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(notified[0]).toContain("no heartbeat");
  });
  it("holds the grace on a fresh install anchor", async () => {
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
  });

  it("stays silent under the install anchor", async () => {
    const dataRoot = await tempDataRoot(new Date("2026-09-20T09:00:00.000Z"));

    const notified: string[] = [];

    await mkdir(join(dataRoot, "outputs"), { recursive: true });

    await writeFile(
      join(dataRoot, "outputs", "watchdog-since.txt"),
      "2026-09-20T11:30:00.000Z\n",
      "utf8",
    );

    await runWatchdog({
      dataRoot,
      staleAfterMs: THRESHOLD,
      now: () => NOW,
      log: () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

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
    } finally {
      logSpy.mockRestore();
    }
  });

  it("answers --help without setting an exit code", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["--help"]);

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
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints one line for a stale stamp via the default threshold", async () => {
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

      expect(logSpy.mock.calls).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("alerts naming the last cycle age via the default threshold", async () => {
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
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exits 1 on an invalid --stale-after value", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main(["--stale-after", "soon"]);

      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails loud on --stale-after without a value", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main(["--stale-after"]);

      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "--stale-after needs a duration value",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exits 1 on --stale-after without a value", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main(["--stale-after"]);

      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("runWatchdog against a non-repo data root", () => {
  it("exits 1 with no git history to hold the grace", async () => {
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
  });

  it("alerts that no data-repo git history exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-watchdog-nogit-"));

    tempDirs.push(dir);

    const lines: string[] = [];

    await runWatchdog({
      dataRoot: dir,
      staleAfterMs: THRESHOLD,
      log: (line) => lines.push(line),
      notify: () => {},
    });

    expect(lines[0]).toContain("no data-repo git history");
  });
});
