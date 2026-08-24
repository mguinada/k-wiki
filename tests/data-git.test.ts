import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGit } from "../src/data/git.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-data-git-"));

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

/**
 * The rogue-commit shape of issue #52: a committed repo whose working
 * tree holds a dirty tracked file — what `git add -A` would stage if
 * discovery escaped to it from a nested directory without `.git`.
 */
async function makeEnclosingRepoWithDirtyFile(): Promise<string> {
  const enclosing = await makeCodeRepoFixture();
  const dirtyFile = join(enclosing, "dirty-tracked.txt");

  await writeFile(dirtyFile, "tracked");
  await git(enclosing, "add", "dirty-tracked.txt");
  await git(enclosing, "commit", "--quiet", "-m", "track dirty file");
  await writeFile(dirtyFile, "edited while dirty");

  return enclosing;
}

describe("git discovery ceiling (issue #52)", () => {
  it("rejects a git call aimed at a directory that owns no .git", async () => {
    const enclosing = await makeEnclosingRepoWithDirtyFile();
    const orphan = join(enclosing, "staging", "data");

    await mkdir(orphan, { recursive: true });

    await expect(runGit(orphan, ["add", "-A"], GIT_ENV)).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("leaves the enclosing repository untouched when the git target owns no .git", async () => {
    const enclosing = await makeEnclosingRepoWithDirtyFile();
    const orphan = join(enclosing, "staging", "data");

    await mkdir(orphan, { recursive: true });

    await runGit(orphan, ["add", "-A"], GIT_ENV).catch(() => undefined);
    await runGit(
      orphan,
      ["commit", "--quiet", "-m", "Seed data repo from k-wiki skeleton"],
      GIT_ENV,
    ).catch(() => undefined);

    const commits = (
      await git(enclosing, "rev-list", "--count", "HEAD")
    ).stdout.trim();
    const staged = (await git(enclosing, "diff", "--cached", "--name-only"))
      .stdout;

    expect(`${commits}:${staged}`).toBe("2:");
  });
});
