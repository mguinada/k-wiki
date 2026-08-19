import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main, seedDataRepo } from "../src/data/init-data-repo.ts";

const tempDirs: string[] = [];
const run = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

afterEach(() => {
  process.exitCode = undefined;
});

describe("data:init CLI help", () => {
  async function runInitCli(args: string[]): Promise<{
    out: string;
    err: string;
  }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    const savedEnv = new Map(
      Object.keys(GIT_ENV).map((key) => [key, process.env[key]]),
    );

    process.argv = [...argv.slice(0, 2), ...args];
    Object.assign(process.env, GIT_ENV);

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

      for (const [key, value] of savedEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("prints the usage line for --help", async () => {
    expect((await runInitCli(["--help"])).out).toContain(
      "init-data-repo [-h | --help] [<config>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runInitCli(["-h"])).out).toBe(
      (await runInitCli(["--help"])).out,
    );
  });

  it("documents the -h and --help switches themselves", async () => {
    expect((await runInitCli(["--help"])).out).toContain("-h, --help");
  });

  it("states the default config path", async () => {
    expect((await runInitCli(["--help"])).out).toContain(
      "Default: the repo's own sync.json",
    );
  });

  it("leaves the exit code unset for --help", async () => {
    await runInitCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("seeds and reports success when run with a config argument", async () => {
    const dir = await makeTempDir();
    const dataRoot = join(dir, "data");
    const configPath = await writeConfig(dataRoot);

    const { out } = await runInitCli([configPath]);

    expect(out).toBe(`data:init: seeded ${dataRoot}`);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the failure and sets the exit code when the config is missing", async () => {
    const dir = await makeTempDir();

    const { err } = await runInitCli([join(dir, "nope.json")]);

    expect(err).toContain("cannot read sync config");
    expect(process.exitCode).toBe(1);
  });

  it("reports an already-seeded data root without reseeding", async () => {
    const dataRoot = await makeTempDir();
    const configPath = await writeConfig(dataRoot);

    await seedDataRepo({
      configPath,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    const { out } = await runInitCli([configPath]);

    expect(out).toBe(`data:init: ${dataRoot} already seeded`);
    expect(process.exitCode).toBeUndefined();
  });
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

/**
 * A hermetic stand-in for the code repo: a temp git repo whose tracked
 * files are the raw/wiki skeleton. Tests must not depend on the outer
 * repository — under Stryker's sandbox, `git ls-files` against the real
 * repo returns nothing (the sandbox has no .git and a mismatched
 * pathspec prefix), which breaks the seeding logic under test.
 */
async function makeCodeRepoFixture(): Promise<string> {
  const dir = await makeTempDir();

  await mkdir(join(dir, "raw", "notes"), { recursive: true });
  await writeFile(join(dir, "raw", "notes", ".gitkeep"), "");
  await mkdir(join(dir, "wiki"), { recursive: true });
  await writeFile(join(dir, "wiki", "AGENTS.md"), "# wiki contract\n");
  await writeFile(join(dir, "wiki", "index.md"), "# index\n");
  await git(dir, "init", "--quiet");
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "fixture skeleton");

  return dir;
}

describe("seedDataRepo", () => {
  it("seeds the skeleton, README, and an initial commit at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "wiki/AGENTS.md"))).toBe(true);
    expect(existsSync(join(dataRoot, "wiki/index.md"))).toBe(true);
    expect(existsSync(join(dataRoot, "raw/notes/.gitkeep"))).toBe(true);
    expect(existsSync(join(dataRoot, "README.md"))).toBe(true);

    const { stdout } = await git(dataRoot, "rev-parse", "HEAD");

    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it('returns "seeded" after the first seed', async () => {
    const dataRoot = await makeTempDir();

    const result = await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(result).toBe("seeded");
  });

  it("is a no-op when the data root is already seeded", async () => {
    const dataRoot = await makeTempDir();
    const configPath = await writeConfig(dataRoot);
    const repoRoot = await makeCodeRepoFixture();

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

  it("refuses to seed into a non-empty directory that is not a seeded data repo", async () => {
    const dataRoot = await makeTempDir();

    await writeFile(join(dataRoot, "unrelated.txt"), "user data");

    await expect(
      seedDataRepo({
        configPath: await writeConfig(dataRoot),
        repoRoot: await makeCodeRepoFixture(),
        env: GIT_ENV,
      }),
    ).rejects.toThrow(
      'is not empty and is not a seeded data repo; refusing to seed into it — move its contents or point "dataRoot" at an empty directory',
    );
  });

  it("seeds into a data root that does not exist yet", async () => {
    const dir = await makeTempDir();
    const dataRoot = join(dir, "nested", "data");

    const result = await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(result).toBe("seeded");
    expect(existsSync(join(dataRoot, "README.md"))).toBe(true);
  });

  it("commits with the author from the given environment", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    const { stdout } = await git(dataRoot, "log", "-1", "--format=%an");

    expect(stdout.trim()).toBe(GIT_ENV.GIT_AUTHOR_NAME);
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
