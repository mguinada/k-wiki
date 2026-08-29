import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  appendLog,
  buildScheduledEnv,
  LOCK_STALE_MS,
  lockData,
  releaseLock,
  resolveDataRoot,
  runScheduledCycle,
  type ScheduledRunOptions,
} from "../src/schedule/scheduled-run.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    rm: vi.fn(
      async (
        path: string | URL,
        options?: { force?: boolean; recursive?: boolean },
      ) => actual.rm(path, options),
    ),
  };
});

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "k-wiki-sched-"));
}

describe("acquireLock", () => {
  it("creates the lock file with the current pid and an ISO timestamp", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    expect(await acquireLock(lockPath)).toBe("acquired");

    const lock = lockData(await readFile(lockPath, "utf8"));

    expect(lock?.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(lock?.takenAt ?? "x"))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it("reports busy while a fresh lock exists", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await acquireLock(lockPath);

    expect(await acquireLock(lockPath)).toBe("busy");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("takes over a lock older than the stale timeout", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const now = new Date("2026-01-01T00:00:00Z");

    await acquireLock(lockPath, {
      now: () => new Date(now.getTime() - LOCK_STALE_MS - 1),
    });

    expect(await acquireLock(lockPath, { now: () => now })).toBe("took-over");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("takes over an unreadable lock instead of hanging", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await writeFile(lockPath, "");

    expect(await acquireLock(lockPath)).toBe("took-over");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("reports busy when a racing acquirer recreates the lock during takeover", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 1, takenAt: "2020-01-01T00:00:00Z" })}\n`,
    );
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      await realFs.rm(path, options);

      if (path === lockPath) {
        await realFs.writeFile(
          lockPath,
          `${JSON.stringify({ pid: 4242, takenAt: new Date().toISOString() })}\n`,
        );
      }
    });

    expect(await acquireLock(lockPath)).toBe("busy");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("releaseLock", () => {
  it("removes the lock file and tolerates an absent one", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await acquireLock(lockPath);
    await releaseLock(lockPath);

    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    await expect(releaseLock(lockPath)).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("lockData", () => {
  it("parses a written lock and rejects garbage", () => {
    const parsed = lockData('{"pid":42,"takenAt":"2026-01-01T00:00:00Z"}');

    expect(parsed).toEqual({ pid: 42, takenAt: "2026-01-01T00:00:00Z" });
    expect(lockData("not json")).toBeUndefined();
    expect(lockData('{"takenAt":"2026-01-01T00:00:00Z"}')).toBeUndefined();
  });
});

describe("buildScheduledEnv", () => {
  it("sets HOME and a PATH with the node bin dir ahead of the system dirs", () => {
    const env = buildScheduledEnv("/Users/me", "/opt/node/bin/node");

    expect(env.HOME).toBe("/Users/me");
    expect(env.PATH).toBe(
      "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });
});

/** A fake git step runner recording every call in order. */
interface FakeGit {
  readonly calls: string[][];
  respond?: (args: readonly string[], calls: readonly string[][]) => void;
}

function fakeGit(respond?: FakeGit["respond"]): {
  git: FakeGit;
  runGitStep: NonNullable<ScheduledRunOptions["runGitStep"]>;
} {
  const base: FakeGit = { calls: [] };
  const git: FakeGit = respond === undefined ? base : { ...base, respond };

  return {
    git,
    // Record first, then respond — the failing call stays in the
    // recorded sequence, so tests can count prior pushes.
    runGitStep: async (_dir, args) => {
      git.calls.push([...args]);
      git.respond?.(args, git.calls);
    },
  };
}

function syncRecorder(
  git: FakeGit,
): (args: readonly string[]) => Promise<void> {
  return async (args) => {
    git.calls.push(["wiki-sync", ...args]);
  };
}

describe("runScheduledCycle", () => {
  it("locks, verifies origin, pulls, runs wiki-sync, pushes, releases", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lockPath = join(dir, ".scheduled-run.lock");

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
      args: ["--settings", "/x/settings.yml"],
    });

    expect(outcome).toEqual({ status: "ok" });
    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["pull", "--rebase"],
      ["wiki-sync", "--settings", "/x/settings.yml"],
      ["push"],
    ]);
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it("forwards its args to the wiki-sync invocation", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: ["--settings", "/x/settings.yml"],
    });

    expect(git.calls[2]?.[1]).toBe("--settings");

    await rm(dir, { recursive: true, force: true });
  });

  it("fails loud when the data repo has no origin and runs nothing", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit((args) => {
      if (args[0] === "remote") {
        throw new Error("fatal: no origin configured");
      }
    });
    const lines: string[] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      log: (line) => lines.push(line),
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toContain("origin");
    expect(git.calls).toEqual([["remote", "get-url", "origin"]]);
    expect(lines.join("\n")).toContain("origin");

    await rm(dir, { recursive: true, force: true });
  });

  it("skips without running anything while another run holds the lock", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lockPath = join(dir, ".scheduled-run.lock");

    await mkdir(join(dir, "outputs"), { recursive: true });
    await acquireLock(lockPath);

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
    });

    expect(outcome).toEqual({
      status: "skipped",
      reason: expect.stringContaining("another run"),
    });
    expect(git.calls).toEqual([]);

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("stops before the push when wiki-sync fails and releases the lock", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];
    const lockPath = join(dir, ".scheduled-run.lock");

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: () => Promise.reject(new Error("lint failed")),
      log: (line) => lines.push(line),
    });

    expect(outcome).toEqual({ status: "failed", error: "lint failed" });
    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["pull", "--rebase"],
    ]);
    expect(lines.join("\n")).toContain("lint failed");
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it("recovers a push rejection with pull --rebase and one retry", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit((args, calls) => {
      if (
        args[0] === "push" &&
        calls.filter((c) => c[0] === "push").length === 1
      ) {
        throw new Error("! [rejected] fetch first");
      }
    });

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
    });

    expect(outcome).toEqual({ status: "ok" });
    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["pull", "--rebase"],
      ["wiki-sync"],
      ["push"],
      ["pull", "--rebase"],
      ["push"],
    ]);

    await rm(dir, { recursive: true, force: true });
  });

  it("alerts after the retry also fails", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit((args) => {
      if (args[0] === "push") {
        throw new Error("! [rejected] fetch first");
      }
    });
    const lines: string[] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      log: (line) => lines.push(line),
    });

    expect(outcome).toEqual({
      status: "failed",
      error: expect.stringContaining("! [rejected] fetch first"),
    });
    expect(lines.join("\n")).toContain("ALERT");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("LOCK_STALE_MS", () => {
  it("gives a run two hours before its lock goes stale", () => {
    expect(LOCK_STALE_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe("resolveDataRoot", () => {
  it("derives the data repo from the raw-dir positional like wiki-sync", async () => {
    expect(await resolveDataRoot("/no/sync.json", "/other/raw")).toBe("/other");
  });

  it("reads the config's dataRoot when no raw-dir positional is given", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({ vaults: [], dataRoot: "/data/repo" }),
    );

    expect(await resolveDataRoot(configPath, undefined)).toBe("/data/repo");

    await rm(dir, { recursive: true, force: true });
  });

  it("fails loud when the config has no dataRoot", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    try {
      expect(await resolveDataRoot(configPath, undefined)).toBeUndefined();
    } finally {
      errors.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("appendLog", () => {
  it("never rejects when the log path is unwritable", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "blocker");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await writeFile(blocker, "not a dir");

    try {
      await expect(
        appendLog(join(blocker, "nested", "run.log"), "line"),
      ).resolves.toBeUndefined();
    } finally {
      errors.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rotates a log that has reached 5 MiB to .1 before appending", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "scheduled-run.log");

    await writeFile(logPath, "x".repeat(5 * 1024 * 1024 + 1));
    await appendLog(logPath, "fresh line");

    const [rotated, fresh] = await Promise.all([
      readFile(`${logPath}.1`, "utf8"),
      readFile(logPath, "utf8"),
    ]);

    expect([rotated.length, fresh]).toEqual([
      5 * 1024 * 1024 + 1,
      "fresh line\n",
    ]);

    await rm(dir, { recursive: true, force: true });
  });
});
