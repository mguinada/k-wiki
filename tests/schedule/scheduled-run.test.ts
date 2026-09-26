import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AGENT_COMMAND_ENV } from "../../src/cli/env.ts";
import { buildScheduledEnv } from "../../src/schedule/repo-script.ts";
import {
  main,
  parseScheduledRunArgs,
  resolveDataRoot,
  runScheduledCycle,
  type ScheduledRunOptions,
} from "../../src/schedule/scheduled-run.ts";
import { acquireLock, releaseLock } from "../../src/sync/run-lock.ts";

const runExec = promisify(execFile);

async function gitRun(args: readonly string[], cwd: string): Promise<void> {
  await runExec("git", [...args], { cwd });
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "k-wiki-sched-"));
}

describe("runScheduledCycle (issue #240 kill batch)", () => {
  it("treats a whitespace-only porcelain status as a clean tree", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();

    git.status = "   \n";

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      log: () => {},
    });

    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["pull", "--rebase"],
      ["wiki-sync"],
      ["push"],
    ]);

    await rm(dir, { recursive: true, force: true });
    expect(outcome).toEqual({ status: "ok" });
  });
});

describe("runScheduledCycle --lint-full (issue #359)", () => {
  it("runs the full sweep after the pull and before the cycle", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const sweeps: string[][] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      runLintFull: async (sweepArgs) => {
        sweeps.push([...sweepArgs]);
        git.calls.push(["wiki-lint", ...sweepArgs]);
      },
      lintFullSettings: "s.yml",
      lintFull: true,
      log: () => {},
    });

    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["pull", "--rebase"],
      [
        "wiki-lint",
        "--full",
        "--timeout",
        "7200",
        "--settings",
        "s.yml",
        join(dir, "raw"),
      ],
      ["wiki-sync"],
      ["push"],
    ]);
    expect(sweeps).toEqual([
      ["--full", "--timeout", "7200", "--settings", "s.yml", join(dir, "raw")],
    ]);
    expect(outcome).toEqual({ status: "ok" });

    await rm(dir, { recursive: true, force: true });
  });

  it("honors an explicit timeout for the sweep budget", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const sweeps: string[][] = [];

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      runLintFull: async (sweepArgs) => {
        sweeps.push([...sweepArgs]);
      },
      lintFull: true,
      lintFullTimeoutMs: 3_600_000,
      log: () => {},
    });

    expect(sweeps).toEqual([["--full", "--timeout", "3600", join(dir, "raw")]]);

    await rm(dir, { recursive: true, force: true });
  });

  it("fails the run without the cycle when the sweep fails", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      runLintFull: async () => {
        throw new Error("wiki-lint exited 1");
      },
      lintFull: true,
      log: () => {},
    });

    expect(outcome).toEqual({
      status: "failed",
      error: "wiki-lint exited 1",
    });
    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["pull", "--rebase"],
    ]);

    await rm(dir, { recursive: true, force: true });
  });

  it("skips loud naming the holder when the lock is busy", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lockPath = join(dir, ".scheduled-run.lock");

    await mkdir(join(dir, "outputs"), { recursive: true });
    await acquireLock(lockPath, { pid: 4242 });

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
      lintFull: true,
      log: () => {},
    });

    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toContain("4242");
    }
    expect(git.calls).toEqual([]);

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("parseScheduledRunArgs", () => {
  it("accepts the lint-full boolean with the shared value flags", () => {
    const parsed = parseScheduledRunArgs([
      "--lint-full",
      "--timeout",
      "3600",
      "config.json",
      "raw",
    ]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.flags.has("--lint-full")).toBe(true);
    expect(parsed.values.get("--timeout")).toBe("3600");
  });

  it("keeps the boolean optional", () => {
    const parsed = parseScheduledRunArgs([]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.flags.has("--lint-full")).toBe(false);
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

  it("marks the run lock as held so the wiki-sync child does not re-acquire it", () => {
    const env = buildScheduledEnv("/Users/me", "/opt/node/bin/node");

    expect(env.KWIKI_RUN_LOCK_HELD).toBe("1");
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
  it("skips before pipeline work when quota pre-flight reports exhaustion", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, ".scheduled-run.lock");
    const lines: string[] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep: fakeGit().runGitStep,
      runQuotaPreflight: async () => ({
        status: "skip",
        reason:
          "ingest provider zai exhausted_now, reset 2026-09-26T05:00:00.000Z",
      }),
      log: (line) => lines.push(line),
    });

    expect({
      outcome,
      lockExists: await stat(lockPath).then(
        () => true,
        () => false,
      ),
      heartbeat: JSON.parse(
        await readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
      ).outcome,
      lines: lines.filter(
        (line) => line.includes("starting cycle") || line.includes("quota"),
      ),
    }).toEqual({
      outcome: {
        status: "skipped",
        reason:
          "ingest provider zai exhausted_now, reset 2026-09-26T05:00:00.000Z",
      },
      lockExists: false,
      heartbeat: "skipped",
      lines: [expect.stringContaining("starting cycle")],
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("proceeds with the dim availability line when agent settings cannot load", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: ["--settings", join(dir, "absent-settings.yml")],
      log: (line) => lines.push(line),
    });

    expect({
      status: outcome.status,
      quotaLines: lines.filter((line) => line.includes("quota")),
    }).toEqual({
      status: "ok",
      quotaLines: ["scheduled-run: quota pre-flight unavailable — proceeding"],
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("persists a dormant pre-flight state on the ok stamp", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      runQuotaPreflight: async () => ({
        status: "proceed",
        preflight: "unavailable",
      }),
      log: () => {},
    });

    expect({
      outcome,
      preflight: JSON.parse(
        await readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
      ).preflight,
    }).toEqual({ outcome: { status: "ok" }, preflight: "unavailable" });

    await rm(dir, { recursive: true, force: true });
  });

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

  it("names the busy lock's holder (PID and start time) in the skip reason", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lockPath = join(dir, ".scheduled-run.lock");

    await mkdir(join(dir, "outputs"), { recursive: true });
    await acquireLock(lockPath, { pid: 4242 });

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
    });

    expect(outcome).toEqual({
      status: "skipped",
      reason: expect.stringMatching(
        /another run holds the lock \(fresh, in progress since \d{2}:\d{2} \(PID 4242\)\) — skipping this tick/,
      ),
    });

    await releaseLock(lockPath, 4242);
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

describe("runScheduledCycle conflicted rebase recovery", () => {
  it("aborts a mid-rebase state before the pre-run pull", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();

    await mkdir(join(dir, ".git", "rebase-merge"), { recursive: true });

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
    });

    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["rebase", "--abort"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["pull", "--rebase"],
      ["wiki-sync"],
      ["push"],
    ]);

    await rm(dir, { recursive: true, force: true });
  });

  it("aborts a mid-rebase state before the push-retry pull", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit(async (args, calls) => {
      if (
        args[0] === "push" &&
        calls.filter((call) => call[0] === "push").length === 1
      ) {
        await mkdir(join(dir, ".git", "rebase-apply"), { recursive: true });
        throw new Error("! [rejected] fetch first");
      }
    });

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
    });

    expect(git.calls).toEqual([
      ["remote", "get-url", "origin"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["pull", "--rebase"],
      ["wiki-sync"],
      ["push"],
      ["rebase", "--abort"],
      ["pull", "--rebase"],
      ["push"],
    ]);

    await rm(dir, { recursive: true, force: true });
  });

  it("logs the aborted conflicted rebase", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(dir, ".git", "rebase-merge"), { recursive: true });

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).toContain(
      "scheduled-run: aborted a conflicted rebase left by a previous tick",
    );

    await rm(dir, { recursive: true, force: true });
  });
});

describe("resolveDataRoot", () => {
  it("derives the data repo from the raw-dir positional like wiki-sync", async () => {
    const resolution = await resolveDataRoot("/no/sync.json", "/other/raw");

    expect(resolution.dataRoot).toBe("/other");
  });

  it("reads the config's dataRoot when no raw-dir positional is given", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({ vaults: [], dataRoot: "/data/repo" }),
    );

    expect((await resolveDataRoot(configPath, undefined)).dataRoot).toBe(
      "/data/repo",
    );

    await rm(dir, { recursive: true, force: true });
  });

  it("returns the no-dataRoot reason instead of printing it", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    try {
      const resolution = await resolveDataRoot(configPath, undefined);

      expect(resolution.error).toContain("no dataRoot");
      expect(resolution.dataRoot).toBeUndefined();
    } finally {
      errors.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints nothing while resolving the data repo", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    try {
      await resolveDataRoot(configPath, undefined);

      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the config loader's error for an unreadable config", async () => {
    const resolution = await resolveDataRoot("/no/such/sync.json", undefined);

    expect(resolution.error).toContain("/no/such/sync.json");
    expect(resolution.dataRoot).toBeUndefined();
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
      join(repoRoot, "bin", "wiki-sync"),
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
    await writeFile(join(repoRoot, "bin", "wiki-sync"), "process.exit(3);");

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

  it("names the signal when the spawned wiki-sync is killed", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      `process.kill(process.pid, ${JSON.stringify("SIGKILL")});`,
    );

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
    });

    expect(outcome).toEqual({
      status: "failed",
      error: "wiki-sync exited by signal SIGKILL",
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

  it("timestamps the start line with the injected clock", async () => {
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
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      log: (line) => lines.push(line),
    });

    expect(lines[0]).toBe(
      "scheduled-run: 2026-01-01T00:00:00.000Z — starting cycle",
    );

    await rm(dir, { recursive: true, force: true });
  });

  it("marks a taken-over stale lock in the start line", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, ".scheduled-run.lock");
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 1,
        takenAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      log: (line) => lines.push(line),
    });

    expect(lines[0]).toBe(
      "scheduled-run: 2026-01-01T00:00:00.000Z — took over a stale lock; starting cycle",
    );

    await rm(dir, { recursive: true, force: true });
  });

  it("releases the lock it re-acquired with the injected pid", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, ".scheduled-run.lock");
    const { git, runGitStep } = fakeGit();

    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 1,
        takenAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep,
      runSync: syncRecorder(git),
      args: [],
      pid: 4242,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    expect([outcome, await stat(lockPath).catch(() => null)]).toEqual([
      { status: "ok" },
      null,
    ]);

    await rm(dir, { recursive: true, force: true });
  });

  it("logs the pushed-after-retry line on a recovered push", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit((args, calls) => {
      if (
        args[0] === "push" &&
        calls.filter((c) => c[0] === "push").length === 1
      ) {
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

    expect(lines.join("\n")).toContain("scheduled-run: pushed after retry");

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
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
      "0|Usage: scheduled-run [-h | --help] [--lint-full] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    const withLong = await runMain(["--help"]);

    expect((await runMain(["-h"])).out).toBe(withLong.out);
  });

  it("documents the lock takeover and the push retry in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("older than four hours is taken over");
  });

  it("documents the push rejection sequence in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("gets one pull --rebase + retry");
  });

  it("documents the no-retry recovery rule in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("no retry/backoff by design");
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
  it("rejects an unknown option with exit 1, red per the shared rendering", async () => {
    const { err, exitCode } = await runMain(["--bogus"]);

    expect(`${exitCode}|${err}`).toBe(
      '1|\u001b[31mscheduled-run: unknown option "--bogus"\u001b[39m',
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

  it("leaves a previously-unset env key absent after the run", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "sync.json");
    const prevLog = process.env.KWIKI_SCHEDULED_LOG;

    delete process.env.KWIKI_SCHEDULED_LOG;
    await writeFile(configPath, JSON.stringify({ vaults: [], dataRoot: dir }));
    await writeFile(
      join(dir, ".scheduled-run.lock"),
      `${JSON.stringify({ pid: 1, takenAt: new Date().toISOString() })}\n`,
    );

    try {
      await runMain([configPath, join(dir, "raw")], {
        KWIKI_SCHEDULED_LOG: join(dir, "run.log"),
      });

      expect(process.env.KWIKI_SCHEDULED_LOG).toBeUndefined();
    } finally {
      if (prevLog === undefined) {
        delete process.env.KWIKI_SCHEDULED_LOG;
      } else {
        process.env.KWIKI_SCHEDULED_LOG = prevLog;
      }

      await rm(dir, { recursive: true, force: true });
    }
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

describe("gitStdout defensiveness", () => {
  async function statusReturns(
    value: unknown,
  ): Promise<{ calls: string[][]; outcome: { status: string } }> {
    const dir = await tempDir();
    const calls: string[][] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep: async (_dir, args) => {
        calls.push([...args]);

        if (args[0] === "status") {
          return value as unknown;
        }

        return { stdout: "" };
      },
      runSync: async () => {},
      args: [],
    });

    await rm(dir, { recursive: true, force: true });

    return { calls, outcome };
  }

  it("treats a status result without a stdout field as a clean tree", async () => {
    const { calls } = await statusReturns(undefined);

    expect(calls.some((args) => args[0] === "pull")).toBe(true);
  });

  it("treats a null status result as a clean tree", async () => {
    const { calls } = await statusReturns(null);

    expect(calls.some((args) => args[0] === "pull")).toBe(true);
  });
});

describe("runScheduledCycle streamed output hygiene", () => {
  it("drops blank lines from the streamed child output", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      [
        'console.log("kept-stdout");',
        "console.log();",
        'console.error("kept-stderr");',
        "console.error();",
      ].join("\n"),
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).not.toContain("");

    await rm(dir, { recursive: true, force: true });
  });

  it("joins a child line torn across stdout chunk boundaries before recording it", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      [
        'process.stdout.write("torn-");',
        'setTimeout(() => { process.stdout.write("line\\n"); }, 30);',
      ].join("\n"),
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).toContain("torn-line");

    await rm(dir, { recursive: true, force: true });
  });

  it("joins a child line torn across stderr chunk boundaries before recording it", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      [
        'process.stderr.write("torn-err");',
        'setTimeout(() => { process.stderr.write("or\\n"); }, 30);',
      ].join("\n"),
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).toContain("torn-error");

    await rm(dir, { recursive: true, force: true });
  });

  it("joins a multi-byte character torn across stdout chunk boundaries before recording it", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      [
        "process.stdout.write(Buffer.from([0xc3]));",
        'setTimeout(() => { process.stdout.write(Buffer.concat([Buffer.from([0xa9]), Buffer.from("\\n")])); }, 30);',
      ].join("\n"),
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).toContain("é");

    await rm(dir, { recursive: true, force: true });
  });

  it("records each line of a chunk that carries several complete lines", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      'process.stdout.write("first\\nsecond\\n");',
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).toEqual(expect.arrayContaining(["first", "second"]));

    await rm(dir, { recursive: true, force: true });
  });

  it("records a final fragment that ends without a newline", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      'process.stdout.write("tail-without-newline");',
    );

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    expect(lines).toContain("tail-without-newline");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("runScheduledCycle heartbeat (issue #362)", () => {
  it("writes an ok stamp after a completed cycle", async () => {
    const dir = await tempDir();
    const { runGitStep } = fakeGit();

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: async () => {},
      pid: 4321,
    });

    expect(outcome).toEqual({ status: "ok" });
    expect(
      JSON.parse(
        await readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
      ),
    ).toMatchObject({ outcome: "ok", pid: 4321 });

    await rm(dir, { recursive: true, force: true });
  });

  it("writes a failed stamp and notifies when the cycle fails", async () => {
    const dir = await tempDir();
    const { runGitStep } = fakeGit((args) => {
      if (args[0] === "remote") {
        throw new Error("fatal: no origin configured");
      }
    });
    const notified: string[] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: async () => {},
      notify: (message) => {
        notified.push(message);
      },
    });

    expect(outcome.status).toBe("failed");
    expect(
      JSON.parse(
        await readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
      ),
    ).toMatchObject({ outcome: "failed" });

    await rm(dir, { recursive: true, force: true });
    expect(notified).toHaveLength(1);
  });

  it("keeps the previous ok stamp's lastOk when a later cycle fails", async () => {
    const dir = await tempDir();
    const okGit = fakeGit();
    const failGit = fakeGit((args) => {
      if (args[0] === "remote") {
        throw new Error("fatal: no origin configured");
      }
    });

    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep: okGit.runGitStep,
      runSync: async () => {},
      now: () => new Date("2026-09-20T10:00:00.000Z"),
    });
    await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep: failGit.runGitStep,
      runSync: async () => {},
      now: () => new Date("2026-09-20T10:30:00.000Z"),
    });

    expect(
      JSON.parse(
        await readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
      ),
    ).toMatchObject({ lastOk: "2026-09-20T10:00:00.000Z" });

    await rm(dir, { recursive: true, force: true });
  });

  it("writes no stamp when the tick skips on a held lock", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, ".scheduled-run.lock");

    await acquireLock(lockPath, { pid: 1 });

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep: fakeGit().runGitStep,
      runSync: async () => {},
    });

    expect(outcome.status).toBe("skipped");
    await expect(
      readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
    ).rejects.toThrow();

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("logs a warning instead of failing when the stamp write fails", async () => {
    const dir = await tempDir();
    const lines: string[] = [];

    // A file where the outputs directory must go makes the stamp
    // write fail (ENOTDIR) while the cycle itself succeeds.
    await writeFile(join(dir, "outputs"), "not a directory", "utf8");

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep: fakeGit().runGitStep,
      runSync: async () => {},
      log: (line) => lines.push(line),
    });

    expect(outcome).toEqual({ status: "ok" });
    expect(lines.some((line) => line.includes("heartbeat write failed"))).toBe(
      true,
    );

    await rm(dir, { recursive: true, force: true });
  });
});

describe("runScheduledCycle agent resolution (issue #399)", () => {
  it("alerts and runs no stage when the agent binary cannot be resolved", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    await writeFile(
      join(dir, "settings.yml"),
      "command: missing-agent-399\nmodel: M\nreasoning: low\n",
    );

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: ["--settings", join(dir, "settings.yml")],
      log: (line) => lines.push(line),
    });

    const text = lines.join("\n");

    expect({
      outcome,
      gitCalls: git.calls,
      lockExists: await stat(join(dir, ".scheduled-run.lock")).then(
        () => true,
        () => false,
      ),
      heartbeat: JSON.parse(
        await readFile(join(dir, "outputs", "last-cycle.json"), "utf8"),
      ).outcome,
      alertedCommand: text.includes("ALERT agent missing-agent-399"),
      namedLookup: text.includes("login shell"),
    }).toEqual({
      outcome: {
        status: "failed",
        error: expect.stringContaining("missing-agent-399"),
      },
      gitCalls: [],
      lockExists: false,
      heartbeat: "failed",
      alertedCommand: true,
      namedLookup: true,
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the agent before the quota gate is consulted", async () => {
    const dir = await tempDir();
    const quota = vi.fn(async () => ({ status: "proceed" as const }));

    await writeFile(
      join(dir, "settings.yml"),
      "command: missing-agent-399\nmodel: M\nreasoning: low\n",
    );

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep: fakeGit().runGitStep,
      runQuotaPreflight: quota,
      args: ["--settings", join(dir, "settings.yml")],
      log: () => {},
    });

    expect({ outcome, quotaRuns: quota.mock.calls.length }).toEqual({
      outcome: { status: "failed", error: expect.any(String) },
      quotaRuns: 0,
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("hands the resolved absolute path to the spawned child environment", async () => {
    const dir = await tempDir();
    const repoRoot = join(dir, "repo");
    const agentPath = join(repoRoot, "bin", "fake-agent");
    const { runGitStep } = fakeGit();
    const lines: string[] = [];

    await mkdir(join(repoRoot, "bin"), { recursive: true });
    await writeFile(agentPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      join(repoRoot, "settings.yml"),
      `command: ${agentPath}\nmodel: M\nreasoning: low\n`,
    );
    await writeFile(
      join(repoRoot, "bin", "wiki-sync"),
      'console.log("KWIKI_AGENT_COMMAND=" + process.env.KWIKI_AGENT_COMMAND);',
    );

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      args: [],
      log: (line) => lines.push(line),
    });

    const text = lines.join("\n");

    expect({
      outcome,
      resolutionLine: text.includes(
        `scheduled-run: agent ${agentPath} resolved to ${agentPath}`,
      ),
      childEnv: text.includes(`KWIKI_AGENT_COMMAND=${agentPath}`),
    }).toEqual({
      outcome: { status: "ok" },
      resolutionLine: true,
      childEnv: true,
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("proceeds without an override when agent settings cannot load", async () => {
    const dir = await tempDir();
    const { git, runGitStep } = fakeGit();
    const lines: string[] = [];

    const outcome = await runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath: join(dir, ".scheduled-run.lock"),
      runGitStep,
      runSync: syncRecorder(git),
      args: ["--settings", join(dir, "absent-settings.yml")],
      log: (line) => lines.push(line),
    });

    const text = lines.join("\n");

    expect({
      outcome,
      gitCalls: git.calls,
      skippedLine: text.includes("agent resolution skipped"),
    }).toEqual({
      outcome: { status: "ok" },
      gitCalls: [
        ["remote", "get-url", "origin"],
        ["status", "--porcelain", "--untracked-files=no"],
        ["pull", "--rebase"],
        ["wiki-sync", "--settings", join(dir, "absent-settings.yml")],
        ["push"],
      ],
      skippedLine: true,
    });

    await rm(dir, { recursive: true, force: true });
  });
});

describe("buildScheduledEnv agent path (issue #399)", () => {
  it("carries the launcher-resolved absolute path for spawned children", () => {
    expect(
      buildScheduledEnv("/home/me", "/node/bin/node", "/abs/pi")[
        AGENT_COMMAND_ENV
      ],
    ).toBe("/abs/pi");
  });

  it("omits the agent key when the cycle resolved nothing", () => {
    expect(
      buildScheduledEnv("/home/me", "/node/bin/node")[AGENT_COMMAND_ENV],
    ).toBeUndefined();
  });
});
