import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { seedDataRepo } from "../src/data/init-data-repo.ts";

const tempDirs: string[] = [];
const run = promisify(execFile);

const repoRoot = new URL("../", import.meta.url).pathname;

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: "k-wiki test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "k-wiki test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  HOME: process.env.HOME,
};

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-data-init-"));

  tempDirs.push(dir);

  return dir;
}

async function writeConfig(dataRoot: string): Promise<string> {
  const dir = await makeTempDir();
  const path = join(dir, "sync.json");

  await writeFile(
    path,
    JSON.stringify({
      vaults: [],
      dataRoot,
    }),
  );

  return path;
}

function git(dataRoot: string, ...args: string[]) {
  return run("git", ["-C", dataRoot, ...args], { env: GIT_ENV });
}

describe("seedDataRepo", () => {
  it("seeds the skeleton, README, and an initial commit at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot,
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "wiki/AGENTS.md"))).toBe(true);
    expect(existsSync(join(dataRoot, "wiki/index.md"))).toBe(true);
    expect(existsSync(join(dataRoot, "raw/notes/.gitkeep"))).toBe(true);
    expect(existsSync(join(dataRoot, "README.md"))).toBe(true);

    const { stdout } = await git(dataRoot, "rev-parse", "HEAD");

    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it("is a no-op when the data root is already seeded", async () => {
    const dataRoot = await makeTempDir();
    const configPath = await writeConfig(dataRoot);

    await seedDataRepo({ configPath, repoRoot, env: GIT_ENV });

    const before = (
      await git(dataRoot, "rev-list", "--count", "HEAD")
    ).stdout.trim();

    const result = await seedDataRepo({ configPath, repoRoot, env: GIT_ENV });

    const after = (
      await git(dataRoot, "rev-list", "--count", "HEAD")
    ).stdout.trim();

    expect(result).toBe("already-seeded");
    expect(after).toBe(before);
  });

  it("rejects a config without a data root", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    await expect(
      seedDataRepo({ configPath, repoRoot, env: GIT_ENV }),
    ).rejects.toThrow(/no "dataRoot"/);
  });
});
