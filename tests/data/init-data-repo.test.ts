import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGit } from "../../src/data/git.ts";
import {
  seedDataRepo,
  seedStandingIgnores,
} from "../../src/data/init-data-repo.ts";

const tempDirs: string[] = [];

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
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "wiki/AGENTS.md"))).toBe(true);
  });

  it("seeds the wiki index at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "wiki/index.md"))).toBe(true);
  });

  it("seeds the raw skeleton at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "raw/notes/.gitkeep"))).toBe(true);
  });

  it("writes the README at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "README.md"))).toBe(true);
  });

  it("makes an initial commit at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    const { stdout } = await git(dataRoot, "rev-parse", "HEAD");

    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it('returns "seeded" after the first seed', async () => {
    const dataRoot = await makeTempDir();

    const result = await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(result).toBe("seeded");
  });

  it("is a no-op when the data root is already seeded", async () => {
    const dataRoot = await makeTempDir();
    const repoRoot = await makeCodeRepoFixture();

    await seedDataRepo({ dataRoot, repoRoot, env: GIT_ENV });

    const result = await seedDataRepo({ dataRoot, repoRoot, env: GIT_ENV });

    expect(result).toBe("already-seeded");
  });

  it("makes no new commit when already seeded", async () => {
    const dataRoot = await makeTempDir();
    const repoRoot = await makeCodeRepoFixture();

    await seedDataRepo({ dataRoot, repoRoot, env: GIT_ENV });

    const before = (
      await git(dataRoot, "rev-list", "--count", "HEAD")
    ).stdout.trim();

    await seedDataRepo({ dataRoot, repoRoot, env: GIT_ENV });

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
        dataRoot,
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
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(result).toBe("seeded");
  });

  it("writes the README into the new data root", async () => {
    const dir = await makeTempDir();
    const dataRoot = join(dir, "nested", "data");

    await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, "README.md"))).toBe(true);
  });

  it("commits with the author from the given environment", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
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
        dataRoot,
        repoRoot: await makeCodeRepoFixture(),
        env: GIT_ENV,
      }),
    ).rejects.toThrow("refusing to seed into it");
  });

  it("refuses on an interrupted seed whose wiki/index.md landed but whose commit did not", async () => {
    const dataRoot = await makeTempDir();

    await mkdir(join(dataRoot, "wiki"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "index.md"), "# index\n");
    await git(dataRoot, "init", "--quiet");

    await expect(
      seedDataRepo({
        dataRoot,
        repoRoot: await makeCodeRepoFixture(),
        env: GIT_ENV,
      }),
    ).rejects.toThrow("refusing to seed into it");
  });

  it("refuses to seed into an unrelated committed git repo at the data root", async () => {
    const dataRoot = await makeTempDir();

    await writeFile(join(dataRoot, "notes.md"), "personal notes");
    await git(dataRoot, "init", "--quiet");
    await git(dataRoot, "add", "-A");
    await git(dataRoot, "commit", "--quiet", "-m", "personal notes repo");

    await expect(
      seedDataRepo({
        dataRoot,
        repoRoot: await makeCodeRepoFixture(),
        env: GIT_ENV,
      }),
    ).rejects.toThrow("refusing to seed into it");
  });

  it("writes the k-wiki data README at the data root", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
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
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(existsSync(join(dataRoot, ".second-brain"))).toBe(false);
  });

  it("writes the second-brain marker into the seed commit when asked", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
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
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
      secondBrain: true,
    });

    expect(await readFile(join(dataRoot, ".second-brain"), "utf8")).toBe("");
  });
});

describe("git discovery ceiling (issue #52)", () => {
  it("seeds a data root nested inside another git repository", async () => {
    const enclosing = await makeCodeRepoFixture();
    const dataRoot = join(enclosing, "nested", "data");

    await seedDataRepo({
      dataRoot,
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
      dataRoot,
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
      dataRoot,
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
      dataRoot,
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
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
      meta: true,
    });

    expect(existsSync(join(dataRoot, "wiki/AGENTS.meta.md"))).toBe(false);
  });

  it("keeps the canonical wiki contract and skips the meta template for an ordinary seed", async () => {
    const dataRoot = await makeTempDir();

    await seedDataRepo({
      dataRoot,
      repoRoot: await makeCodeRepoFixture(),
      env: GIT_ENV,
    });

    expect(await readFile(join(dataRoot, "wiki/AGENTS.md"), "utf8")).toBe(
      "# wiki contract\n",
    );
  });
});
