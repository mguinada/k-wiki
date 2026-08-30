import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../src/data/git.ts";
import {
  main,
  seedDataRepo,
  seedStandingIgnores,
} from "../../src/data/init-data-repo.ts";

const tempDirs: string[] = [];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
      "init-data-repo [-h | --help] [--second-brain] [--meta] [<config>]",
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

  it("documents the seeded standing .gitignore", async () => {
    expect((await runInitCli(["--help"])).out).toContain(".gitignore");
  });

  it("leaves the exit code unset for --help", async () => {
    await runInitCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the config-read failure", async () => {
    const dir = await makeTempDir();

    const { err } = await runInitCli([join(dir, "nope.json")]);

    expect(err).toContain("cannot read sync config");
  });

  it("exits 1 when the config is missing", async () => {
    const dir = await makeTempDir();

    const { err: _err } = await runInitCli([join(dir, "nope.json")]);

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
  });

  it("leaves the exit code unset when already seeded", async () => {
    const dataRoot = await makeTempDir();
    const configPath = await writeConfig(dataRoot);

    await seedDataRepo({
      configPath,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    await runInitCli([configPath]);

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
  return runGit(dataRoot, args, GIT_ENV);
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
  await writeFile(join(dir, "wiki", "AGENTS.meta.md"), "# meta contract\n");
  await writeFile(join(dir, "wiki", "index.md"), "# index\n");
  await git(dir, "init", "--quiet");
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "fixture skeleton");

  return dir;
}

describe("seedDataRepo", () => {
  it("seeds the wiki contract at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "wiki/AGENTS.md"))).toBe(true);
  });

  it("seeds the wiki index at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "wiki/index.md"))).toBe(true);
  });

  it("seeds the raw skeleton at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "raw/notes/.gitkeep"))).toBe(true);
  });

  it("writes the README at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "README.md"))).toBe(true);
  });

  it("makes an initial commit at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

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

    const result = await seedDataRepo({ configPath, repoRoot, env: GIT_ENV });

    expect(result).toBe("already-seeded");
  });

  it("makes no new commit when already seeded", async () => {
    const dataRoot = await makeTempDir();
    const configPath = await writeConfig(dataRoot);
    const repoRoot = await makeCodeRepoFixture();

    await seedDataRepo({ configPath, repoRoot, env: GIT_ENV });

    const before = (
      await git(dataRoot, "rev-list", "--count", "HEAD")
    ).stdout.trim();

    await seedDataRepo({ configPath, repoRoot, env: GIT_ENV });

    const after = (
      await git(dataRoot, "rev-list", "--count", "HEAD")
    ).stdout.trim();

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
  });

  it("writes the README into the new data root", async () => {
    const dir = await makeTempDir();
    const dataRoot = join(dir, "nested", "data");

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

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

  it("refuses to seed into a data root whose wiki/ directory holds no index.md", async () => {
    const dataRoot = await makeTempDir();

    await mkdir(join(dataRoot, "wiki"), { recursive: true });

    await expect(
      seedDataRepo({
        configPath: await writeConfig(dataRoot),
        repoRoot: await makeCodeRepoFixture(),
        env: GIT_ENV,
      }),
    ).rejects.toThrow("refusing to seed into it");
  });

  it("writes the k-wiki data README at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(await readFile(join(dataRoot, "README.md"), "utf8")).toContain(
      "Generated by the k-wiki code repo",
    );
  });

  it("writes no second-brain marker without the secondBrain option", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, ".second-brain"))).toBe(false);
  });

  it("writes the second-brain marker into the seed commit when asked", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
      secondBrain: true,
    });

    const { stdout } = await git(dataRoot, "ls-files", "--", ".second-brain");

    expect(stdout.trim()).toBe(".second-brain");
  });

  it("writes an empty second-brain marker", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
      secondBrain: true,
    });

    expect(await readFile(join(dataRoot, ".second-brain"), "utf8")).toBe("");
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

describe("git discovery ceiling (issue #52)", () => {
  it("seeds a data root nested inside another git repository", async () => {
    const enclosing = await makeCodeRepoFixture();
    const dataRoot = join(enclosing, "nested", "data");

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    const dataCommits = (
      await git(dataRoot, "rev-list", "--count", "HEAD")
    ).stdout.trim();
    const enclosingCommits = (
      await git(enclosing, "rev-list", "--count", "HEAD")
    ).stdout.trim();

    expect(`${dataCommits}:${enclosingCommits}`).toBe("1:1");
  });
});

describe("data:init bin launcher", () => {
  /**
   * A staged copy of src/ and bin/ inside the test tree, importable
   * in-process with a controlled argv — the same trick as
   * tests/sync/cli-spawn.test.ts: under Stryker the sandbox holds the
   * mutated sources next to the tests, and a dynamic import executes
   * them here, where the active-mutant globals live.
   */
  const stagingRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    ".data-init-import-staging",
  );

  afterAll(async () => {
    await rm(stagingRoot, { recursive: true, force: true });
  });

  /** A staged code repo: skeleton tracked in git, plus sync.json. */
  async function stageRepo(): Promise<string> {
    const dir = join(stagingRoot, randomUUID());
    const testsDir = dirname(fileURLToPath(import.meta.url));

    await mkdir(join(dir, "raw", "notes"), { recursive: true });
    await writeFile(join(dir, "raw", "notes", ".gitkeep"), "");
    await mkdir(join(dir, "wiki"), { recursive: true });
    await writeFile(join(dir, "wiki", "index.md"), "# index\n");
    await cp(join(testsDir, "../../src"), join(dir, "src"), {
      recursive: true,
    });
    await cp(join(testsDir, "../../bin"), join(dir, "bin"), {
      recursive: true,
    });
    await writeFile(
      join(dir, "sync.json"),
      JSON.stringify({ vaults: [], dataRoot: join(dir, "data") }),
    );
    await git(dir, "init", "--quiet");
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "-m", "staged skeleton");

    return dir;
  }

  interface ImportOutcome {
    readonly out: string;
    readonly err: string;
  }

  async function importWithArgv(
    modulePath: string,
    args: readonly string[],
  ): Promise<ImportOutcome> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [argv[0] ?? "node", modulePath, ...args];

    const savedEnv = new Map(
      Object.keys(GIT_ENV).map((key) => [key, process.env[key]]),
    );

    Object.assign(process.env, GIT_ENV);

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await import(pathToFileURL(modulePath).href);
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

  it("seeds the data root named by the default sync.json when imported through its bin launcher", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "bin", "init-data-repo.ts");

    const { out } = await importWithArgv(modulePath, []);

    expect(out).toBe(`data:init: seeded ${join(repo, "data")}`);
  });

  it("seeds the data root of the config given as an argument, not the default one", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "bin", "init-data-repo.ts");
    const argDataRoot = join(repo, "data-arg");
    const configPath = join(repo, "arg-sync.json");

    await writeFile(
      configPath,
      JSON.stringify({ vaults: [], dataRoot: argDataRoot }),
    );

    const { out } = await importWithArgv(modulePath, [configPath]);

    expect(out).toBe(`data:init: seeded ${argDataRoot}`);
  });

  it("seeds the second-brain marker when --second-brain is passed", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "bin", "init-data-repo.ts");

    const { out } = await importWithArgv(modulePath, ["--second-brain"]);

    expect(out).toBe(`data:init: seeded ${join(repo, "data")}`);
  });

  it("creates the marker file from the --second-brain flag", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "bin", "init-data-repo.ts");

    await importWithArgv(modulePath, ["--second-brain"]);

    expect(existsSync(join(repo, "data", ".second-brain"))).toBe(true);
  });
});

describe("data:init standing .gitignore (issue #146)", () => {
  const STANDING_GITIGNORE = [
    "# Obsidian UI state: never part of the wiki (external writer; guardrail 1 hazard)",
    ".obsidian/",
    "wiki/.obsidian/",
    "# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)",
    "outputs/last-ingested-manifest.json",
    "",
  ].join("\n");

  it("seeds the standing ignore rules both live repos converged on", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(await readFile(join(dataRoot, ".gitignore"), "utf8")).toBe(
      STANDING_GITIGNORE,
    );
  });

  it("commits the seeded .gitignore with the skeleton", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    const { stdout } = await git(dataRoot, "ls-files", "--", ".gitignore");

    expect(stdout.trim()).toBe(".gitignore");
  });

  it("merges the missing standing rules into an existing .gitignore", async () => {
    const dataRoot = await makeTempDir();

    await writeFile(join(dataRoot, ".gitignore"), "scratch/\n");
    await seedStandingIgnores(dataRoot);

    expect(await readFile(join(dataRoot, ".gitignore"), "utf8")).toBe(
      `scratch/\n${STANDING_GITIGNORE}`,
    );
  });

  it("terminates an unterminated .gitignore before appending", async () => {
    const dataRoot = await makeTempDir();

    await writeFile(join(dataRoot, ".gitignore"), "scratch/");
    await seedStandingIgnores(dataRoot);

    expect(await readFile(join(dataRoot, ".gitignore"), "utf8")).toBe(
      `scratch/\n${STANDING_GITIGNORE}`,
    );
  });

  it("leaves a .gitignore that already carries every standing rule untouched", async () => {
    const dataRoot = await makeTempDir();
    const before = `${STANDING_GITIGNORE}operator-rule/\n`;

    await writeFile(join(dataRoot, ".gitignore"), before);
    await seedStandingIgnores(dataRoot);

    expect(await readFile(join(dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("treats a whitespace-padded standing rule as already present", async () => {
    const dataRoot = await makeTempDir();

    await writeFile(join(dataRoot, ".gitignore"), "  .obsidian/  \n");
    await seedStandingIgnores(dataRoot);

    expect(await readFile(join(dataRoot, ".gitignore"), "utf8")).toBe(
      `  .obsidian/  \n# Obsidian UI state: never part of the wiki (external writer; guardrail 1 hazard)\nwiki/.obsidian/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n`,
    );
  });
});

describe("seedDataRepo meta contract (issue #74)", () => {
  it("seeds the meta contract as wiki/AGENTS.md when meta is set", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
      meta: true,
    });

    expect(await readFile(join(dataRoot, "wiki/AGENTS.md"), "utf8")).toBe(
      "# meta contract\n",
    );
  });

  it("never copies the canonical meta contract file into a seeded data repo", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
      meta: true,
    });

    expect(existsSync(join(dataRoot, "wiki/AGENTS.meta.md"))).toBe(false);
  });

  it("keeps the canonical wiki contract and skips the meta template for an ordinary seed", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      configPath: await writeConfig(dataRoot),
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(await readFile(join(dataRoot, "wiki/AGENTS.md"), "utf8")).toBe(
      "# wiki contract\n",
    );
  });
});
