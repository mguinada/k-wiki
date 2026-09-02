import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assertCleanTree,
  gitRepoRoot,
  parseStatus,
  pathUntouched,
  renameOriginsOf,
  runGit,
  statusSince,
} from "../../src/data/git.ts";
import { sha256 } from "../../src/cli/shared.ts";
import { capturePreRunState } from "../../src/ingest/guardrails.ts";

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

describe("gitRepoRoot", () => {
  it("returns the repository root containing a directory", async () => {
    const repo = await makeCodeRepoFixture();

    await expect(gitRepoRoot(join(repo, "wiki"), GIT_ENV)).resolves.toBe(
      realpathSync(repo),
    );
  });

  it("returns undefined outside any git repository", async () => {
    const dir = await makeTempDir();

    await expect(
      gitRepoRoot(dir, { ...GIT_ENV, GIT_CEILING_DIRECTORIES: dirname(dir) }),
    ).resolves.toBeUndefined();
  });
});

describe("assertCleanTree", () => {
  it("passes a clean tree", async () => {
    const repo = await makeCodeRepoFixture();

    await expect(
      assertCleanTree(join(repo, "wiki"), "clean-test", GIT_ENV),
    ).resolves.toBeUndefined();
  });

  it("refuses a dirty tree naming the diff surface", async () => {
    const repo = await makeCodeRepoFixture();

    await writeFile(join(repo, "wiki", "index.md"), "# edited\n");

    await expect(
      assertCleanTree(join(repo, "wiki"), "dirty-test", GIT_ENV),
    ).rejects.toThrow("uncommitted changes — commit or stash first");
  });

  it("warns without color codes under NO_COLOR outside a git repo", async () => {
    const dir = await makeTempDir();
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => {
        errors.push(parts.join(" "));
      });

    try {
      await assertCleanTree(dir, "no-repo-test", {
        ...GIT_ENV,
        NO_COLOR: "1",
      });
    } finally {
      spy.mockRestore();
    }

    expect(errors[0]).toBe(
      `no-repo-test: no git repo at ${dir} — proceeding without the git safety net`,
    );
  });
});

/** A committed raw+wiki repo for the statusSince comparisons: the
 *  guardrail fixture minus frontmatter — status comparison reads
 *  only git state, never page content. */
async function makeRepo(): Promise<string> {
  const dataRoot = await makeTempDir();

  await mkdir(join(dataRoot, "raw", "notes"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# src\n");
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await git(dataRoot, "init", "--quiet");
  await git(dataRoot, "add", "-A");
  await git(
    dataRoot,
    "-c",
    "user.email=k-wiki@test",
    "-c",
    "user.name=k-wiki test",
    "commit",
    "--quiet",
    "-m",
    "init",
  );

  return dataRoot;
}

/** Commit everything in the data repo. */
async function commit(dataRoot: string, message: string): Promise<void> {
  await git(dataRoot, "add", "-A");
  await git(
    dataRoot,
    "-c",
    "user.email=k-wiki@test",
    "-c",
    "user.name=k-wiki test",
    "commit",
    "--quiet",
    "-m",
    message,
  );
}

describe("pathUntouched", () => {
  it("holds when the pre-run snapshot carried the path and the content still matches", async () => {
    const dataRoot = await makeRepo();

    expect(
      await pathUntouched(
        dataRoot,
        true,
        "raw/notes/src.md",
        sha256(Buffer.from("# src\n")),
      ),
    ).toBe(true);
  });

  it("fails when the pre-run snapshot did not carry the path", async () => {
    const dataRoot = await makeRepo();

    expect(
      await pathUntouched(dataRoot, false, "raw/notes/src.md", "absent"),
    ).toBe(false);
  });

  it("fails when the content no longer matches the snapshot", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# edited\n");

    expect(
      await pathUntouched(
        dataRoot,
        true,
        "raw/notes/src.md",
        sha256(Buffer.from("# src\n")),
      ),
    ).toBe(false);
  });
});

describe("parseStatus", () => {
  it("splits each porcelain line into code and path", () => {
    expect(
      parseStatus(" M wiki/index.md\n?? wiki/new.md\n D wiki/gone.md\n"),
    ).toEqual([
      { code: " M", path: "wiki/index.md" },
      { code: "??", path: "wiki/new.md" },
      { code: " D", path: "wiki/gone.md" },
    ]);
  });

  it("reports the target and origin of a rename", () => {
    expect(parseStatus("R  wiki/old.md -> wiki/new.md\n")).toEqual([
      { code: "R ", path: "wiki/new.md", origin: "wiki/old.md" },
    ]);
  });

  it("keeps a non-rename path containing ' -> ' whole", () => {
    expect(parseStatus('?? "raw/notes/draft -> final.md"\n')).toEqual([
      { code: "??", path: "raw/notes/draft -> final.md" },
    ]);
  });

  it("unquotes a C-quoted path", () => {
    expect(parseStatus(' M "wiki/my page.md"\n')).toEqual([
      { code: " M", path: "wiki/my page.md" },
    ]);
  });

  it("unquotes an escaped quote inside a quoted path", () => {
    expect(parseStatus('?? "weird\\"name.md"\n')).toEqual([
      { code: "??", path: 'weird"name.md' },
    ]);
  });

  it("decodes a quoted path holding both a quote and non-ASCII (core.quotePath=false, C-2)", () => {
    // Real git, quotePath=false, emits exactly this form: the path
    // is quoted for the quote character, the non-ASCII stays raw.
    expect(parseStatus('?? "wiki/caf\u00e9 \\"quoted\\".md"\n')).toEqual([
      { code: "??", path: 'wiki/caf\u00e9 "quoted".md' },
    ]);
  });

  it("keeps an astral-plane character whole in a quoted path", () => {
    // An emoji filename is quoted for the space with the astral
    // character raw (a surrogate pair in JS); encoding it one
    // UTF-16 code unit at a time would corrupt it to two U+FFFDs
    // and yield a path that does not exist.
    expect(parseStatus('?? "wiki/idea \u{1F600} v2.md"\n')).toEqual([
      { code: "??", path: "wiki/idea \u{1F600} v2.md" },
    ]);
  });

  it("keeps a leading byte-order mark in a quoted path", () => {
    // A U+FEFF-prefixed filename is quoted for the space with the
    // mark raw (quotePath=false); a decoder that honors the BOM
    // would strip it and yield a path that does not exist.
    expect(parseStatus('?? "\uFEFFname with space.md"\n')).toEqual([
      { code: "??", path: "\uFEFFname with space.md" },
    ]);
  });

  it("unquotes both paths of a quoted rename", () => {
    expect(parseStatus('R  "wiki/a b.md" -> "wiki/c d.md"\n')).toEqual([
      { code: "R ", path: "wiki/c d.md", origin: "wiki/a b.md" },
    ]);
  });

  it("splits a rename whose quoted origin contains ' -> '", () => {
    expect(parseStatus('R  "wiki/a -> b.md" -> wiki/c.md\n')).toEqual([
      { code: "R ", path: "wiki/c.md", origin: "wiki/a -> b.md" },
    ]);
  });

  it("decodes octal escapes byte-wise in a quoted rename origin", () => {
    expect(parseStatus('R  "wiki/caf\xc3\xa9.md" -> wiki/c.md\n')).toEqual([
      { code: "R ", path: "wiki/c.md", origin: "wiki/caf\u00c3\u00a9.md" },
    ]);
  });

  it("keeps an unknown escaped character as its bare character in a rename origin", () => {
    expect(parseStatus('R  "wiki/a\\qb.md" -> wiki/c.md\n')).toEqual([
      { code: "R ", path: "wiki/c.md", origin: "wiki/aqb.md" },
    ]);
  });

  it("treats a rename line without a separator as a plain path with no origin", () => {
    expect(parseStatus("R  wiki/lonely.md\n")).toEqual([
      { code: "R ", path: "wiki/lonely.md" },
    ]);
  });

  it("decodes every C escape in a quoted path", () => {
    expect(parseStatus('?? "a\\ab\\bc\\fd\\ne\\rf\\tg\\vh\\\\i.md"\n')).toEqual(
      [{ code: "??", path: "a\x07b\bc\fd\ne\rf\tg\vh\\i.md" }],
    );
  });

  it("decodes three-digit and one-digit octal escapes", () => {
    expect(parseStatus('R  "wiki/caf\\303\\251\\7.md" -> wiki/c.md\n')).toEqual(
      [
        {
          code: "R ",
          path: "wiki/c.md",
          origin: "wiki/caf\u00e9\x07.md",
        },
      ],
    );
  });

  it("keeps a path with only a leading quote verbatim", () => {
    expect(parseStatus('?? "partial\n')).toEqual([
      { code: "??", path: '"partial' },
    ]);
  });

  it("keeps a path with only a trailing quote verbatim", () => {
    expect(parseStatus('?? partial"\n')).toEqual([
      { code: "??", path: 'partial"' },
    ]);
  });

  it("keeps a trailing backslash in a quoted path", () => {
    expect(parseStatus('?? "end\\"\n')).toEqual([
      { code: "??", path: "end\\" },
    ]);
  });

  it("keeps an unknown escape followed by octal digits verbatim", () => {
    expect(parseStatus('?? "x\\8a7.md"\n')).toEqual([
      { code: "??", path: "x8a7.md" },
    ]);
  });

  it("treats a quoted rename without a separator as a plain path", () => {
    expect(parseStatus('R  "quoted lonely.md"\n')).toEqual([
      { code: "R ", path: "quoted lonely.md" },
    ]);
  });

  it("splits a rename whose origin contains an escaped quote before the separator", () => {
    expect(parseStatus('R  "a\\" -> b.md" -> c.md\n')).toEqual([
      { code: "R ", path: "c.md", origin: 'a" -> b.md' },
    ]);
  });

  it("keeps a non-rename unquoted path containing ' -> ' whole", () => {
    expect(parseStatus("?? raw/notes/draft -> final.md\n")).toEqual([
      { code: "??", path: "raw/notes/draft -> final.md" },
    ]);
  });

  it("returns no entries for empty output", () => {
    expect(parseStatus("")).toEqual([]);
  });
});

describe("statusSince", () => {
  it("reports no change for an untouched tree", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    expect(await statusSince(dataRoot, GIT_ENV, pre, "wiki")).toEqual({
      entries: [],
      changed: [],
      headMoved: false,
    });
  });

  it("reports a wiki file created during the run", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "queries", "q.md"), "Q\n");

    const { entries, changed } = await statusSince(
      dataRoot,
      GIT_ENV,
      pre,
      "wiki",
    );

    expect({ changed, entries }).toEqual({
      changed: ["wiki/queries/q.md"],
      entries: [{ code: "??", path: "wiki/queries/q.md" }],
    });
  });

  it("reports a committed wiki file modified during the run", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/index.md"],
    );
  });

  it("reports a wiki file deleted during the run", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await rm(join(dataRoot, "wiki", "index.md"));

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/index.md"],
    );
  });

  it("ignores a wiki page that was already dirty before the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "# dirty\n");

    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      [],
    );
  });

  it("reports an agent re-edit of an already-dirty page", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "# dirty\n");

    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await writeFile(join(dataRoot, "wiki", "index.md"), "# dirtier\n");

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/index.md"],
    );
  });

  it("ignores changes outside the prefix", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await writeFile(join(dataRoot, "raw", "notes", "new.md"), "# new\n");

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      [],
    );
  });

  it("reports a pre-run untracked wiki page deleted during the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "draft.md"), "Draft\n");

    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await rm(join(dataRoot, "wiki", "draft.md"));

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/draft.md"],
    );
  });

  it("reports a rename whose origin is under the prefix and target outside", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await mkdir(join(dataRoot, "notes"), { recursive: true });
    await git(dataRoot, "mv", "wiki/index.md", "notes/index.md");

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/index.md"],
    );
  });

  it("ignores a rename origin already staged before the run", async () => {
    const dataRoot = await makeRepo();

    await git(dataRoot, "mv", "wiki/index.md", "wiki/renamed.md");

    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    const result = await statusSince(dataRoot, GIT_ENV, pre, "wiki");

    expect(result).toMatchObject({ changed: [], headMoved: false });
  });

  it("reports headMoved when the run commits", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await writeFile(join(dataRoot, "wiki", "new.md"), "N\n");
    await commit(dataRoot, "rogue");

    const result = await statusSince(dataRoot, GIT_ENV, pre, "wiki");

    expect(result).toMatchObject({ changed: [], headMoved: true });
  });

  it("returns the full post-run entries, not only the prefix", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await writeFile(join(dataRoot, "raw", "notes", "new.md"), "# new\n");
    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "queries", "q.md"), "Q\n");

    const { entries } = await statusSince(dataRoot, GIT_ENV, pre, "wiki");

    expect(entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["wiki/queries/q.md", "raw/notes/new.md"]),
    );
  });

  it("reports a wiki page the run staged into the index", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "draft.md"), "Draft\n");

    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await git(dataRoot, "add", "wiki/draft.md");

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/draft.md"],
    );
  });

  it("lists changed paths sorted, not in discovery order", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "m.md"), "M\n");
    await commit(dataRoot, "m");

    const pre = await capturePreRunState(dataRoot, GIT_ENV);

    await mkdir(join(dataRoot, "notes"), { recursive: true });
    await git(dataRoot, "mv", "wiki/m.md", "notes/m.md");
    await writeFile(join(dataRoot, "wiki", "a.md"), "A\n");

    expect((await statusSince(dataRoot, GIT_ENV, pre, "wiki")).changed).toEqual(
      ["wiki/a.md", "wiki/m.md"],
    );
  });
});

describe("renameOriginsOf", () => {
  it("collects only the origins of rename entries", () => {
    const status = parseStatus(
      "R  wiki/old.md -> wiki/new.md\n M wiki/index.md\n?? wiki/fresh.md\nR  wiki/x.md -> wiki/y.md\n",
    );

    expect(renameOriginsOf(status)).toEqual(
      new Set(["wiki/old.md", "wiki/x.md"]),
    );
  });

  it("is empty when no entry carries an origin", () => {
    const status = parseStatus(" M wiki/index.md\n?? wiki/fresh.md\n");

    expect(renameOriginsOf(status)).toEqual(new Set());
  });
});
