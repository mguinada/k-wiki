import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers.ts";

/**
 * sync-watchdog e2e (issue #362): the real libexec door as a child
 * process, run the way its launchd job runs it, against a temp data
 * repo with a heartbeat stamp in each verdict class. The vitest
 * setup keeps every child's alert path from firing real macOS
 * notifications on the dev machine (tests/setup-env.ts).
 */

const WATCHDOG_SCRIPT = join(repoRoot, "bin", "libexec", "sync-watchdog");

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Repo {
  readonly tmp: string;
  readonly dataRoot: string;
  readonly configPath: string;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd });

  return stdout;
}

/** A temp data repo with one commit at `committedAt` (default now). */
async function makeRepo(committedAt?: Date): Promise<Repo> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-watchdog-e2e-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const configPath = join(tmp, "sync.json");

  await writeFile(configPath, JSON.stringify({ dataRoot, vaults: [] }), "utf8");
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

  await git(["init", "--quiet"], dataRoot);
  await git(["config", "user.email", "t@t"], dataRoot);
  await git(["config", "user.name", "t"], dataRoot);
  await git(["add", "-A"], dataRoot);
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot, env });

  return { tmp, dataRoot, configPath };
}

/** Put a heartbeat stamp into the repo. */
async function putStamp(
  repo: Repo,
  stamp: { timestamp: string; outcome: string },
): Promise<void> {
  await mkdir(join(repo.dataRoot, "outputs"), { recursive: true });
  await writeFile(
    join(repo.dataRoot, "outputs", "last-cycle.json"),
    JSON.stringify({ ...stamp, pid: 1, lastOk: null }),
    "utf8",
  );
}

function runWatchdog(
  repo: Repo,
  args: readonly string[] = [],
): Promise<{ code: number | null; out: string; err: string }> {
  return runCli(WATCHDOG_SCRIPT, [repo.configPath, ...args]);
}

describe("sync-watchdog e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(WATCHDOG_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: sync-watchdog/);
  });

  it("exits 0 on a fresh heartbeat, naming age and threshold", async () => {
    const repo = await makeRepo();

    await putStamp(repo, {
      timestamp: new Date().toISOString(),
      outcome: "ok",
    });

    const result = await runWatchdog(repo);

    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /fresh — last cycle 0m ago \(threshold 1h 30m\)/,
    );
  });

  it("exits 1 on a stale heartbeat, naming age and threshold", async () => {
    const repo = await makeRepo();

    await putStamp(repo, {
      timestamp: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      outcome: "failed",
    });

    const result = await runWatchdog(repo);

    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      /ALERT — last cycle 4h ago, past the 1h 30m threshold/,
    );
  });

  it("exits 1 on an unreadable heartbeat", async () => {
    const repo = await makeRepo();

    await mkdir(join(repo.dataRoot, "outputs"), { recursive: true });
    await writeFile(
      join(repo.dataRoot, "outputs", "last-cycle.json"),
      "garbage",
      "utf8",
    );

    const result = await runWatchdog(repo);

    expect(result.code).toBe(1);
    expect(result.out).toContain("heartbeat unreadable");
  });

  it("holds the grace window for a fresh install with no stamp yet", async () => {
    const repo = await makeRepo(new Date());

    const result = await runWatchdog(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("no heartbeat yet");
  });

  it("holds the grace on the installer's anchor even when commits are old", async () => {
    const repo = await makeRepo(new Date("2026-01-01T00:00:00.000Z"));

    await mkdir(join(repo.dataRoot, "outputs"), { recursive: true });
    await writeFile(
      join(repo.dataRoot, "outputs", "watchdog-since.txt"),
      `${new Date().toISOString()}\n`,
      "utf8",
    );

    const result = await runWatchdog(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("watchdog install");
  });

  it("alerts once a stamp-less repo's newest commit passes the threshold", async () => {
    const repo = await makeRepo(new Date("2026-01-01T00:00:00.000Z"));

    const result = await runWatchdog(repo);

    expect(result.code).toBe(1);
    expect(result.out).toContain("no heartbeat");
  });

  it("honors an explicit --stale-after threshold", async () => {
    const repo = await makeRepo();

    await putStamp(repo, {
      timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      outcome: "ok",
    });

    const strict = await runWatchdog(repo, ["--stale-after", "1hour"]);
    const lenient = await runWatchdog(repo, ["--stale-after", "3hours"]);

    expect(strict.code).toBe(1);
    expect(lenient.code).toBe(0);
  });

  it("reads the stamp the scheduled wrapper wrote, end to end", async () => {
    const repo = await makeRepo();
    const stamp = {
      timestamp: new Date().toISOString(),
      outcome: "ok",
      pid: 555,
      lastOk: new Date().toISOString(),
    };

    await mkdir(join(repo.dataRoot, "outputs"), { recursive: true });
    await writeFile(
      join(repo.dataRoot, "outputs", "last-cycle.json"),
      JSON.stringify(stamp),
      "utf8",
    );

    const result = await runWatchdog(repo);

    expect(result.code).toBe(0);
    expect(
      JSON.parse(
        await readFile(
          join(repo.dataRoot, "outputs", "last-cycle.json"),
          "utf8",
        ),
      ),
    ).toEqual(stamp);
  });
});
