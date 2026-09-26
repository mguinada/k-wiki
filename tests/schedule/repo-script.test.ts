import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnRepoScript } from "../../src/schedule/repo-script.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Repo {
  readonly repoRoot: string;
  readonly write: (name: string, body: string) => Promise<void>;
}

/** A temp repo whose bin/ holds scripts run by the real spawner. */
async function tempRepo(): Promise<Repo> {
  const repoRoot = await mkdtemp(join(tmpdir(), "k-wiki-repo-script-"));

  tempDirs.push(repoRoot);
  await mkdir(join(repoRoot, "bin"), { recursive: true });

  return {
    repoRoot,
    write: async (name, body) => {
      await writeFile(join(repoRoot, "bin", name), body);
    },
  };
}

describe("spawnRepoScript", () => {
  it("streams the child's stdout and stderr into the log", async () => {
    const repo = await tempRepo();
    const lines: string[] = [];

    await repo.write(
      "wiki-sync",
      [
        'console.log("digest-from-stdout");',
        'console.error("progress-from-stderr");',
      ].join("\n"),
    );

    await expect(
      spawnRepoScript(repo.repoRoot, "wiki-sync", [], (line) =>
        lines.push(line),
      ),
    ).resolves.toBeUndefined();

    expect(lines).toEqual(["digest-from-stdout", "progress-from-stderr"]);
  });

  it("rejects naming the script and its exit code", async () => {
    const repo = await tempRepo();

    await repo.write("wiki-sync", "process.exit(3);");

    await expect(
      spawnRepoScript(repo.repoRoot, "wiki-sync", [], () => {}),
    ).rejects.toThrow("wiki-sync exited 3");
  });

  it("rejects naming the signal when the child is killed", async () => {
    const repo = await tempRepo();

    await repo.write("wiki-sync", "process.kill(process.pid, 'SIGKILL');");

    await expect(
      spawnRepoScript(repo.repoRoot, "wiki-sync", [], () => {}),
    ).rejects.toThrow("wiki-sync exited by signal SIGKILL");
  });

  it("hands the launcher-resolved agent path to the child environment", async () => {
    const repo = await tempRepo();
    const lines: string[] = [];

    await repo.write(
      "wiki-sync",
      'console.log("KWIKI_AGENT_COMMAND=" + process.env.KWIKI_AGENT_COMMAND);',
    );

    await spawnRepoScript(
      repo.repoRoot,
      "wiki-sync",
      [],
      (line) => lines.push(line),
      "/abs/resolved/pi",
    );

    expect(lines).toEqual(["KWIKI_AGENT_COMMAND=/abs/resolved/pi"]);
  });

  it("leaves the agent key unset when the cycle resolved nothing", async () => {
    const repo = await tempRepo();
    const lines: string[] = [];

    await repo.write(
      "wiki-sync",
      'console.log("agent-env=" + String(process.env.KWIKI_AGENT_COMMAND));',
    );

    await spawnRepoScript(repo.repoRoot, "wiki-sync", [], (line) =>
      lines.push(line),
    );

    expect(lines).toEqual(["agent-env=undefined"]);
  });
});
