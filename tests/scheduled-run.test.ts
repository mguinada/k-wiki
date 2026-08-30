import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  appendLog,
  buildScheduledEnv,
  LOCK_STALE_MS,
  lockData,
  main,
  releaseLock,
  resolveDataRoot,
  rotateLogIfNeeded,
  runScheduledCycle,
  type ScheduledRunOptions,
  scheduledLogPath,
} from "../src/schedule/scheduled-run.ts";

const runExec = promisify(execFile);

async function gitRun(args: readonly string[], cwd: string): Promise<void> {
  await runExec("git", [...args], { cwd });
}

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

  it("keeps a successor's lock whose recorded pid is not this process's", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 4242, takenAt: new Date().toISOString() })}\n`,
    );
    await releaseLock(lockPath, 1111);

    await expect(readFile(lockPath, "utf8")).resolves.toContain("4242");

    await releaseLock(lockPath, 4242);

    await expect(readFile(lockPath, "utf8")).rejects.toThrow();

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

  it("rejects a non-object lock, a non-numeric pid, and a non-string timestamp", () => {
    expect(lockData("42")).toBeUndefined();
    expect(lockData('"str"')).toBeUndefined();
    expect(
      lockData('{"pid":"42","takenAt":"2026-01-01T00:00:00Z"}'),
    ).toBeUndefined();
    expect(lockData('{"pid":42,"takenAt":42}')).toBeUndefined();
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
  status?: string;
  respond?: (
    args: readonly string[],
    calls: readonly string[][],
  ) => void | Promise<void>;
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

      if (args[0] === "status") {
        return { stdout: git.status ?? "" };
      }

      await git.respond?.(args, git.calls);
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
      ["status", "--porcelain", "--untracked-files=no"],
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

    expect(git.calls[3]?.[1]).toBe("--settings");

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
      ["status", "--porcelain", "--untracked-files=no"],
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
      ["status", "--porcelain", "--untracked-files=no"],
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

  it("skips the pre-run pull over a dirty tree and still completes the cycle", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    git.status = " M wiki/concepts/stub.md\n";

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      log: (line) => lines.push(line),
    });

    expect(outcome).toEqual({ status: "ok" });
    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["wiki-sync"],
      ["push"],
    ]);
    expect(lines.join("\n")).toContain("skipping the pre-run pull");

    await rm(dir, { recursive: true, force: true });
  });

  it("never releases a lock a successor re-acquired mid-run", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, ".scheduled-run.lock");
    const successorLock = `${JSON.stringify({ pid: 4242, takenAt: new Date().toISOString() })}\n`;
    const { git, runGitStep } = fakeGit(async () => {
      await writeFile(lockPath, successorLock);
    });

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
    });

    expect(outcome).toEqual({ status: "ok" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(successorLock);

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

describe("acquireLock edge cases", () => {
  it("takes over a lock that is exactly the stale age", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const now = new Date("2026-01-01T00:00:00Z");

    await acquireLock(lockPath, {
      now: () => new Date(now.getTime() - LOCK_STALE_MS),
    });

    expect(await acquireLock(lockPath, { now: () => now })).toBe("took-over");

    await rm(dir, { recursive: true, force: true });
  });

  it("writes the takeover with the injected clock and pid", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const takenAt = new Date("2026-01-01T00:00:00Z");

    await acquireLock(lockPath, { now: () => new Date(0) });
    await acquireLock(lockPath, { now: () => takenAt, pid: 4242 });

    const lock = lockData(await readFile(lockPath, "utf8"));

    expect(lock).toEqual({ pid: 4242, takenAt: takenAt.toISOString() });

    await rm(dir, { recursive: true, force: true });
  });

  it("propagates a non-EEXIST open failure instead of reporting busy", async () => {
    await expect(
      acquireLock(join(await tempDir(), "missing-dir", "scheduled-run.lock")),
    ).rejects.toThrow();
  });
});

describe("scheduledLogPath", () => {
  it("logs to ~/Library/Logs/k-wiki on macOS", () => {
    expect(scheduledLogPath("/Users/me", "darwin")).toBe(
      "/Users/me/Library/Logs/k-wiki/scheduled-run.log",
    );
  });

  it("logs to the XDG state dir elsewhere", () => {
    expect(scheduledLogPath("/home/me", "linux")).toBe(
      "/home/me/.local/state/k-wiki/logs/scheduled-run.log",
    );
  });
});

describe("rotateLogIfNeeded", () => {
  it("keeps a log below the rotation threshold in place", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "scheduled-run.log");

    await writeFile(logPath, "small");
    await rotateLogIfNeeded(logPath, 1024);

    await expect(readFile(logPath, "utf8")).resolves.toBe("small");
    await expect(readFile(`${logPath}.1`, "utf8")).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("runScheduledCycle with the real wiki-sync spawner", () => {
  it("streams the child's stdout and stderr into the log on success", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync.ts"),
      [
        'console.log("digest-from-stdout");',
        'console.error("progress-from-stderr");',
      ].join("\n"),
    );

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(outcome).toEqual({ status: "ok" });
    expect(lines).toContain("digest-from-stdout");
    expect(lines).toContain("progress-from-stderr");

    await rm(dir, { recursive: true, force: true });
  });

  it("fails the cycle when the spawned wiki-sync exits non-zero", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(join(repoRoot, "bin", "wiki-sync.ts"), "process.exit(3);");

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
    });

    expect(outcome).toEqual({
      status: "failed",
      error: "wiki-sync exited 3",
    });

    await rm(dir, { recursive: true, force: true });
  });
});

describe("runScheduledCycle log narration", () => {
  it("narrates the full cycle in the log", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
      log: (line) => lines.push(line),
    });

    const text = lines.join("\n");

    expect(text).toContain("starting cycle");
    expect(text).toContain("git pull --rebase (data repo)");
    expect(text).toContain("wiki-sync starting");
    expect(text).toContain("wiki-sync finished — pushing");
    expect(text).toContain("pushed");
    expect(text).toContain("cycle complete");

    await rm(dir, { recursive: true, force: true });
  });

  it("narrates the push rejection, retry, and alert in the log", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit((args) => {
      if (args[0] === "push") {
        throw new Error("! [rejected]");
      }
    });
    const lines: string[] = [];

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
      log: (line) => lines.push(line),
    });

    const text = lines.join("\n");

    expect(text).toContain(
      "push rejected — pull --rebase and retry once: ! [rejected]",
    );
    expect(text).toContain("push failed again after retry");
    expect(text).toContain("ALERT ! [rejected]");

    await rm(dir, { recursive: true, force: true });
  });
});

/** Run main() with patched argv and captured console output. */
async function runMain(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ out: string; err: string; exitCode: string | undefined }> {
  const argv = process.argv;
  const prevEnv: Record<string, string | undefined> = {};
  const out: string[] = [];
  const err: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    prevEnv[key] = process.env[key];
    process.env[key] = value;
  }

  process.argv = [...argv.slice(0, 2), ...args];
  process.exitCode = undefined;

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await main();
  } finally {
    process.argv = argv;
    logSpy.mockRestore();
    errorSpy.mockRestore();

    for (const [key, value] of Object.entries(prevEnv)) {
      process.env[key] = value;
    }
  }

  return {
    out: out.join("\n"),
    err: err.join("\n"),
    exitCode: process.exitCode === undefined ? "0" : String(process.exitCode),
  };
}

describe("scheduled-run main: help", () => {
  it("prints the usage line for --help", async () => {
    const { out, exitCode } = await runMain(["--help"]);

    expect(`${exitCode}|${out.split("\n")[0]}`).toBe(
      "0|Usage: scheduled-run [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    const withLong = await runMain(["--help"]);

    expect((await runMain(["-h"])).out).toBe(withLong.out);
  });

  it("documents the lock takeover and the push retry in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("older than two hours is taken over");
  });

  it("documents the push rejection sequence in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("gets one pull --rebase + retry");
  });

  it("documents the no-retry recovery rule in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("no retry/backoff, guide §26");
  });

  it("documents the log override in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("KWIKI_SCHEDULED_LOG overrides");
  });

  it("documents the exit codes in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain(
      "Exits 0 on a completed or skipped cycle, 1 on failure.",
    );
  });
});

describe("scheduled-run main: usage errors", () => {
  it("rejects an unknown option with exit 1", async () => {
    const { err, exitCode } = await runMain(["--bogus"]);

    expect(`${exitCode}|${err}`).toBe(
      '1|scheduled-run: unknown option "--bogus"',
    );
  });

  it("rejects more than two positionals with exit 1", async () => {
    const { err, exitCode } = await runMain(["a", "b", "c"]);

    expect(err).toContain("expected at most two arguments");
    expect(exitCode).toBe("1");
  });

  it("rejects a value flag without its value with exit 1", async () => {
    const { err, exitCode } = await runMain(["--settings"]);

    expect(err).toContain("--settings needs a path value");
    expect(exitCode).toBe("1");
  });
});

describe("scheduled-run main: cycle outcomes", () => {
  it("exits 1 and fails loud when the data repo has no origin", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [], dataRoot: dir }));

    const { err, exitCode } = await runMain([configPath, join(dir, "raw")], {
      KWIKI_SCHEDULED_LOG: join(dir, "run.log"),
    });

    expect(exitCode).toBe("1");
    expect(err).toContain("origin");

    await rm(dir, { recursive: true, force: true });
  });

  it("exits 0 with a skipped note while a fresh lock is held", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [], dataRoot: dir }));
    await writeFile(
      join(dir, ".scheduled-run.lock"),
      `${JSON.stringify({ pid: 1, takenAt: new Date().toISOString() })}\n`,
    );

    const { out, exitCode } = await runMain([configPath, join(dir, "raw")]);

    expect(`${exitCode}|${out}`).toContain(
      "0|scheduled-run: skipped — another run holds the lock",
    );

    await rm(dir, { recursive: true, force: true });
  });

  it("runs a real cycle into a temp data repo and logs to the override path", async () => {
    const dir = await tempDir();
    const dataRoot = join(dir, "data");
    const configPath = join(dir, "sync.json");
    const settingsPath = join(dir, "settings.yml");
    const logPath = join(dir, "run.log");

    await mkdir(join(dataRoot, "raw"), { recursive: true });
    await mkdir(join(dataRoot, "wiki"), { recursive: true });
    await writeFile(
      join(dataRoot, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
    );
    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
    await gitRun(["init", "--quiet", "--initial-branch=main"], dataRoot);
    await gitRun(["config", "user.email", "t@t"], dataRoot);
    await gitRun(["config", "user.name", "t"], dataRoot);
    await gitRun(["add", "-A"], dataRoot);
    await gitRun(["commit", "--quiet", "-m", "init"], dataRoot);
    await gitRun(
      [
        "init",
        "--quiet",
        "--bare",
        "--initial-branch=main",
        join(dir, "upstream.git"),
      ],
      dir,
    );
    await gitRun(
      ["remote", "add", "origin", join(dir, "upstream.git")],
      dataRoot,
    );
    await gitRun(["push", "--quiet", "-u", "origin", "main"], dataRoot);
    await writeFile(configPath, JSON.stringify({ vaults: [], dataRoot }));
    await writeFile(
      settingsPath,
      "command: /usr/bin/true\nmodel: M\nreasoning: low\n",
    );

    const { exitCode } = await runMain(
      ["--settings", settingsPath, configPath, join(dataRoot, "raw")],
      { KWIKI_SCHEDULED_LOG: logPath },
    );

    const log = await readFile(logPath, "utf8");

    expect(`${exitCode}|${log}`).toContain("0|");
    expect(log).toContain("cycle complete");

    await rm(dir, { recursive: true, force: true });
  });
});
