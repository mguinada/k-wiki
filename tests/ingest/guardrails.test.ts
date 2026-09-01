import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  capturePreRunState,
  checkWikiFrontmatter,
  parseStatus,
  renameOriginsOf,
  revertToPreRun,
  runGuardrails,
  statusSince,
} from "../../src/ingest/guardrails.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A minimal wiki page body with valid frontmatter (guide §9);
 *  `sources` cites the fixture's source page, wikilink form
 *  (issue #126). */
function page(body = "Body text."): string {
  return [
    "---",
    'title: "Page"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[src]]"',
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** The fixture's `type: source` hub: origin raw/notes/src.md, its
 *  own sources citing that same raw path. */
function hubPage(): string {
  return [
    "---",
    'title: "Src"',
    "type: source",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "origin: raw/notes/src.md",
    "sources:",
    '  - "notes/src.md"',
    "---",
    "",
    "Hub body.",
    "",
  ].join("\n");
}

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
          origin: "wiki/caf\u00c3\u00a9\x07.md",
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

describe("checkWikiFrontmatter", () => {
  it("accepts a derived page with all required fields", () => {
    expect(checkWikiFrontmatter(page())).toEqual([]);
  });

  it("accepts a source-typed page without sources", () => {
    expect(
      checkWikiFrontmatter(page().replace("type: concept", "type: source")),
    ).toEqual([]);
  });

  it("rejects a page without a frontmatter block", () => {
    expect(checkWikiFrontmatter("Just a heading.\n")).toEqual([
      "no frontmatter block",
    ]);
  });

  it("rejects an unclosed frontmatter block", () => {
    expect(checkWikiFrontmatter("---\ntitle: x\n")).toEqual([
      "no closing --- for the frontmatter block",
    ]);
  });

  it("names a missing required field", () => {
    expect(
      checkWikiFrontmatter(page().replace("tags:\n  - llm\n", "")),
    ).toEqual(['missing required frontmatter field "tags"']);
  });

  it("requires sources on every page not of type source", () => {
    expect(
      checkWikiFrontmatter(page().replace('sources:\n  - "[[src]]"\n', "")),
    ).toEqual(['missing required frontmatter field "sources"']);
  });

  it("skips the sources check when skipSources is true", () => {
    expect(
      checkWikiFrontmatter(page().replace('sources:\n  - "[[src]]"\n', ""), {
        skipSources: true,
      }),
    ).toEqual([]);
  });

  it("ignores an indented key: value line inside the frontmatter block", () => {
    const text = [
      "---",
      'title: "Page"',
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags: []",
      "sources:",
      '  - "[[src]]"',
      "  type: concept",
      "---",
      "",
      "Body.",
    ].join("\n");

    expect(checkWikiFrontmatter(text)).toEqual([
      'missing required frontmatter field "type"',
    ]);
  });

  it("ignores a key: value line in the body after the closing ---", () => {
    const text = [
      "---",
      'title: "Page"',
      "type: concept",
      "updated: 2026-08-20",
      "tags: []",
      "sources:",
      '  - "[[src]]"',
      "---",
      "",
      "created: 2020-01-01",
    ].join("\n");

    expect(checkWikiFrontmatter(text)).toEqual([
      'missing required frontmatter field "created"',
    ]);
  });

  it("strips quotes only at the edges of the type value", () => {
    const text = [
      "---",
      'title: "Page"',
      'type: so"urce',
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags: []",
      "---",
      "",
      "Body.",
    ].join("\n");

    expect(checkWikiFrontmatter(text)).toEqual([
      'missing required frontmatter field "sources"',
    ]);
  });

  it("unquotes a quoted type value before comparing it to source", () => {
    const text = [
      "---",
      'title: "Page"',
      "type: 'source'",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags: []",
      "---",
      "",
      "Body.",
    ].join("\n");

    expect(checkWikiFrontmatter(text)).toEqual([]);
  });
});

/** Commit everything in a fixture data repo. */
async function commit(root: string, message: string): Promise<void> {
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    { cwd: root },
  );
}

/** A committed data repo: raw/notes + manifest, wiki/index.md, and
 *  the wiki/sources/src.md hub every fixture page cites. */
async function makeRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-guard-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw", "notes"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# src\n");
  await writeFile(join(dataRoot, "wiki", "index.md"), page("# Index\n"));
  await writeFile(join(dataRoot, "wiki", "sources", "src.md"), hubPage());
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await commit(dataRoot, "init");

  return dataRoot;
}

/** Sabotage helper: the fake run the "agent" performs between capture and check. */
type Sabotage = (dataRoot: string) => Promise<void>;

async function guardedRun(
  dataRoot: string,
  sabotage?: Sabotage,
): Promise<ReturnType<typeof runGuardrails>> {
  const pre = await capturePreRunState(dataRoot, process.env);

  if (sabotage !== undefined) {
    await sabotage(dataRoot);
  }

  return runGuardrails(dataRoot, process.env, pre);
}

describe("capturePreRunState", () => {
  it("captures the head commit as the revert target", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    expect(pre.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a data repo without any commit", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-guard-"));

    tempDirs.push(dataRoot);

    await run("git", ["init", "--quiet"], { cwd: dataRoot });

    await expect(capturePreRunState(dataRoot, process.env)).rejects.toThrow(
      "no commit to revert to",
    );
  });
});

describe("runGuardrails — check 1, immutability", () => {
  it("passes a run that only adds and edits wiki pages", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "new.md"), page());
      await writeFile(join(root, "wiki", "index.md"), page("# Index v2\n"));
    });

    expect(post.failure).toBeUndefined();
  });

  it("passes changes to raw/manifest.json and outputs/", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "raw", "manifest.json"), '{"v":2}\n');
      await mkdir(join(root, "outputs"), { recursive: true });
      await writeFile(join(root, "outputs", "digest.md"), "# digest\n");
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when the run edits a committed raw note", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "raw", "notes", "src.md"), "# tampered\n");
    });

    expect(post.failure).toMatchObject({
      check: 1,
      name: "immutability",
      problems: expect.arrayContaining([
        expect.stringContaining("raw/notes/src.md"),
      ]),
    });
  });

  it("trips when the run creates a file outside the whitelist", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "settings.yml.bak"), "command: evil\n");
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("settings.yml.bak"),
      ]),
    });
  });

  it("trips when the run creates the second-brain identity marker", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, ".second-brain"), "");
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining(".second-brain"),
      ]),
    });
  });

  it("trips when the run creates a second-brain identity marker hidden from git status", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "exclude"), ".second-brain\n");
      await writeFile(join(root, ".second-brain"), "");
      await writeFile(
        join(root, "wiki", "new.md"),
        page("Leak: [[brain/decision-fast-tests]]."),
      );
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining(".second-brain"),
      ]),
    });
  });

  it("trips when the run edits an already-dirty raw note", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# sync v2\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# agent v3\n");

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("raw/notes/src.md"),
      ]),
    });
  });

  it("passes over a pre-run dirty wiki page the run leaves untouched", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "no frontmatter\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "sources", "new.md"), hubPage());

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure).toBeUndefined();
  });

  it("trips when the run edits a pre-run untracked file", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "settings.yml"), "command: pi\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "settings.yml"), "command: evil\n");

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("settings.yml"),
      ]),
    });
  });

  it("trips when the run renames a raw note into outputs/", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await mkdir(join(root, "outputs"), { recursive: true });
      await run("git", ["mv", "raw/notes/src.md", "outputs/src.md"], {
        cwd: root,
      });
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("raw/notes/src.md"),
      ]),
    });
  });

  it("trips when the run renames a raw note onto a pre-run rename target", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "a.md"), page("# A\n"));
    await commit(dataRoot, "a");
    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "wiki/a.md", "outputs/x.md"], { cwd: dataRoot });

    const post = await guardedRun(dataRoot, async (root) => {
      await run("git", ["mv", "-f", "raw/notes/src.md", "outputs/x.md"], {
        cwd: root,
      });
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("raw/notes/src.md"),
      ]),
    });
  });

  it("passes a run that writes the target of a rename staged before the run", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "raw/notes/src.md", "outputs/y.md"], {
      cwd: dataRoot,
    });

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "outputs", "y.md"), "# y v2\n");
    });

    expect(post.failure).toBeUndefined();
  });

  it("passes a run that restores the target of a pre-run modified rename", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "raw/notes/src.md", "outputs/y.md"], {
      cwd: dataRoot,
    });
    await writeFile(join(dataRoot, "outputs", "y.md"), "# dirty\n");

    const post = await guardedRun(dataRoot, async (root) => {
      await run("git", ["checkout", "--", "outputs/y.md"], { cwd: root });
    });

    expect(post.failure).toBeUndefined();
  });

  it("passes a run that renames the target of a pre-run staged rename", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "raw/notes/src.md", "outputs/y.md"], {
      cwd: dataRoot,
    });

    const post = await guardedRun(dataRoot, async (root) => {
      await run("git", ["mv", "outputs/y.md", "outputs/z.md"], { cwd: root });
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when the run moves a pre-run rename target back onto the raw note", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "raw/notes/src.md", "outputs/y.md"], {
      cwd: dataRoot,
    });

    const post = await guardedRun(dataRoot, async (root) => {
      await run("git", ["mv", "-f", "outputs/y.md", "raw/notes/src.md"], {
        cwd: root,
      });
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("raw/notes/src.md"),
      ]),
    });
  });

  it("trips when the run rewrites the wiki/AGENTS.md contract", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "AGENTS.md"), "rogue contract\n");
    });

    expect(post.failure).toMatchObject({
      check: 1,
      name: "immutability",
      problems: expect.arrayContaining([
        expect.stringContaining("wiki/AGENTS.md"),
      ]),
    });
  });

  it("trips when the run edits a non-ASCII-named untracked file", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "raw", "notes", "ノート.md"), "# one\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "raw", "notes", "ノート.md"), "# two\n");

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([expect.stringContaining("ノート.md")]),
    });
  });

  it("trips when the run edits a pre-run-dirty note whose name contains ' -> '", async () => {
    const dataRoot = await makeRepo();

    await writeFile(
      join(dataRoot, "raw", "notes", "draft -> final.md"),
      "# one\n",
    );

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(
      join(dataRoot, "raw", "notes", "draft -> final.md"),
      "# tampered\n",
    );

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([
        expect.stringContaining("raw/notes/draft -> final.md"),
      ]),
    });
  });

  it("passes a run that creates a wiki page with a space in its name", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "my page.md"), page());
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when the run moves HEAD with its own commit", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "index.md"), page("# rogue\n"));
      await commit(root, "rogue");
    });

    expect(post.failure).toMatchObject({
      check: 1,
      problems: expect.arrayContaining([expect.stringContaining("HEAD moved")]),
    });
  });
});

describe("runGuardrails — check 2, frontmatter", () => {
  it("trips when a changed wiki page has no frontmatter", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "plain.md"), "no frontmatter\n");
    });

    expect(post.failure).toMatchObject({
      check: 2,
      name: "frontmatter",
      problems: expect.arrayContaining([
        expect.stringContaining("wiki/plain.md"),
        expect.stringContaining("no frontmatter block"),
      ]),
    });
  });

  it("names the missing required field of a changed page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page().replace("tags:\n  - llm\n", ""),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining('missing required frontmatter field "tags"'),
      ]),
    });
  });

  it("does not check a wiki page the run deleted", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await rm(join(root, "wiki", "index.md"));
    });

    expect(post.failure).toBeUndefined();
  });

  it("exempts wiki/index.md and wiki/overview.md from the sources field", async () => {
    const dataRoot = await makeRepo();

    await writeFile(
      join(dataRoot, "wiki", "overview.md"),
      "---\ntitle: Overview\ntype: topic\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - wiki\n---\n\n# Overview\n",
    );
    await commit(dataRoot, "add overview");

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "index.md"),
        "---\ntitle: Index\ntype: topic\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - wiki\n---\n\n# Index v2\n",
      );
    });

    expect(post.failure).toBeUndefined();
  });

  it("exempts a changed wiki/log.md from frontmatter entirely", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "log.md"), "- no frontmatter entry\n");
    });

    expect(post.failure).toBeUndefined();
  });

  it("exempts a run-changed wiki/overview.md from the sources field", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "overview.md"),
        "---\ntitle: Overview\ntype: topic\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - wiki\n---\n\n# Overview v2\n",
      );
    });

    expect(post.failure).toBeUndefined();
  });

  it("exempts wiki/second-brain/profile.md from the sources field", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await mkdir(join(root, "wiki", "second-brain"), { recursive: true });
      await writeFile(
        join(root, "wiki", "second-brain", "profile.md"),
        "---\ntitle: Profile\ntype: profile\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - brain\n---\n\n# Profile\n",
      );
    });

    expect(post.failure).toBeUndefined();
  });
});

describe("runGuardrails — check 2, sources entry format", () => {
  it("accepts a sources wikilink to an existing type: source page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "cites.md"), page());
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when a changed page cites a raw path that is a hub's origin", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace('"[[src]]"', '"notes/src.md"'),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          'wiki/cites.md: sources entry "notes/src.md" cites a path that has a hub — use "[[src]]"',
        ),
      ]),
    });
  });

  it("trips when a changed page cites a raw path covered by a hub's own sources", async () => {
    const dataRoot = await makeRepo();
    await writeFile(
      join(dataRoot, "wiki", "sources", "sdn.md"),
      hubPage()
        .replace('title: "Src"', 'title: "Sdn"')
        .replace("origin: raw/notes/src.md", "origin: raw/notes/sdn.md")
        .replace(
          '"notes/src.md"',
          '"notes/Books/SDN/04. Rate Limiter/Readme.md"',
        ),
    );
    await commit(dataRoot, "add multi-part hub");

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace(
          '"[[src]]"',
          '"notes/Books/SDN/04. Rate Limiter/Readme.md"',
        ),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          'cites a path that has a hub — use "[[sdn#04. Rate Limiter]]"',
        ),
      ]),
    });
  });

  it("trips when a changed page cites a chapter path of a migrated multi-part hub", async () => {
    const dataRoot = await makeRepo();

    await writeFile(
      join(dataRoot, "wiki", "sources", "sdn.md"),
      hubPage()
        .replace('title: "Src"', 'title: "Sdn"')
        .replace(
          "origin: raw/notes/src.md",
          "origin: raw/notes/Books/SDN/Readme.md",
        )
        .replace('"notes/src.md"', '"[[sdn#04. Rate Limiter]]"'),
    );
    await commit(dataRoot, "add migrated multi-part hub");

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace(
          '"[[src]]"',
          '"notes/Books/SDN/04. Rate Limiter/Readme.md"',
        ),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          'cites a path that has a hub — use "[[sdn#04. Rate Limiter]]"',
        ),
      ]),
    });
  });

  it("passes a path-form entry whose raw path has no hub", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace('"[[src]]"', '"notes/unhubbed.md"'),
      );
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when a sources wikilink targets a page that is not type: source", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace('"[[src]]"', '"[[index]]"'),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          "wiki/cites.md: sources entry [[index]] does not cite a type: source page",
        ),
      ]),
    });
  });

  it("trips when a sources wikilink targets a missing page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace('"[[src]]"', '"[[missing]]"'),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          "sources entry [[missing]] does not cite a type: source page",
        ),
      ]),
    });
  });

  it("trips when a sources wikilink is a cross-wiki target", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace('"[[src]]"', '"[[engineering/hub]]"'),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          "sources entry [[engineering/hub]] is a cross-wiki target",
        ),
      ]),
    });
  });

  it("trips when a sources wikilink has no page target", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "cites.md"),
        page().replace('"[[src]]"', '"[[|alias]]"'),
      );
    });

    expect(post.failure).toMatchObject({
      check: 2,
      problems: expect.arrayContaining([
        expect.stringContaining(
          "wiki/cites.md: sources entry [[|alias]] has no page target",
        ),
      ]),
    });
  });

  it("does not check the sources format of a changed type: source page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "sources", "second.md"),
        hubPage()
          .replace('title: "Src"', 'title: "Second"')
          .replace("origin: raw/notes/src.md", "origin: raw/notes/second.md")
          .replace('"notes/src.md"', '"notes/second.md"'),
      );
    });

    expect(post.failure).toBeUndefined();
  });
});

describe("runGuardrails — check 3, wikilinks", () => {
  it("accepts a cross-wiki link in a changed page of a second brain", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, ".second-brain"), "");
    await commit(dataRoot, "mark second brain");

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page("Backed by [[engineering/retrieval-augmented-generation]]."),
      );
    });

    expect(post.failure).toBeUndefined();
  });

  it("still trips on a dangling internal link inside a second brain", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, ".second-brain"), "");
    await commit(dataRoot, "mark second brain");

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page("See [[Does Not Exist]]."),
      );
    });

    expect(post.failure?.check).toBe(3);
  });

  it("trips on a cross-wiki link in a wiki that is not a second brain", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page(
          "References second-brain material: [[brain/decision-fast-tests]].",
        ),
      );
    });

    expect(post.failure).toMatchObject({
      check: 3,
      name: "wikilinks",
    });
  });

  it("accepts a cross-wiki link in a second brain marked by an uncommitted marker", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, ".second-brain"), "");

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page("Backed by [[engineering/retrieval-augmented-generation]]."),
      );
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips on a cross-wiki link when the run itself creates the profile", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await mkdir(join(root, "wiki", "second-brain"), { recursive: true });
      await writeFile(
        join(root, "wiki", "second-brain", "profile.md"),
        "---\ntitle: Profile\ntype: profile\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - brain\n---\n\n# Profile\n",
      );
      await writeFile(
        join(root, "wiki", "new.md"),
        page("Self-granted identity: [[brain/decision-fast-tests]]."),
      );
    });

    expect(post.failure).toMatchObject({
      check: 3,
      name: "wikilinks",
    });
  });

  it("passes the wikilinks check when the run deletes every wiki page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await rm(join(root, "wiki"), { recursive: true });
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips on a dangling wikilink naming the file and line", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page("See [[Does Not Exist]]."),
      );
    });

    expect(post.failure).toMatchObject({
      check: 3,
      name: "wikilinks",
      problems: expect.arrayContaining([
        expect.stringMatching(/^wiki\/new\.md:\d+ -> \[\[Does Not Exist\]\]$/),
      ]),
    });
  });

  it("accepts a wikilink to an existing page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "new.md"), page("See [[index]]."));
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when a changed page links to a page the run deleted", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page().replace("Body text.", "[[index]]"),
      );
      await rm(join(root, "wiki", "index.md"));
    });

    expect(post.failure?.check).toBe(3);
  });

  it("reports a changed page's link to a run-deleted page once, not twice", async () => {
    const dataRoot = await makeRepo();
    const body = "[[index]]";
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "new.md"), page(body));
      await rm(join(root, "wiki", "index.md"));
    });

    const line = page(body).split("\n").indexOf(body) + 1;

    expect(post.failure?.problems).toEqual([
      `wiki/new.md:${line} -> [[index]]`,
    ]);
  });

  it("trips when the run deletes a page other pages link to", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "target.md"), page("# Target\n"));
    await writeFile(
      join(dataRoot, "wiki", "linker.md"),
      page("See [[target]]."),
    );
    await commit(dataRoot, "linker");

    const post = await guardedRun(dataRoot, async (root) => {
      await rm(join(root, "wiki", "target.md"));
    });

    expect(post.failure).toMatchObject({
      check: 3,
      problems: expect.arrayContaining([
        expect.stringMatching(/^wiki\/linker\.md:\d+ -> \[\[target\]\]$/),
      ]),
    });
  });

  it("trips when the run deletes an untracked page other pages link to", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "target.md"), page("# Target\n"));
    await writeFile(
      join(dataRoot, "wiki", "linker.md"),
      page("See [[target]]."),
    );

    const post = await guardedRun(dataRoot, async (root) => {
      await rm(join(root, "wiki", "target.md"));
    });

    expect(post.failure).toMatchObject({
      check: 3,
      problems: expect.arrayContaining([
        expect.stringMatching(/^wiki\/linker\.md:\d+ -> \[\[target\]\]$/),
      ]),
    });
  });

  it("passes a deleted page whose name still resolves to a surviving page", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
    await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
    await writeFile(
      join(dataRoot, "wiki", "sources", "target.md"),
      page("# Source\n"),
    );
    await writeFile(
      join(dataRoot, "wiki", "concepts", "target.md"),
      page("# Concept\n"),
    );
    await writeFile(
      join(dataRoot, "wiki", "linker.md"),
      page("See [[target]]."),
    );
    await commit(dataRoot, "targets");

    const post = await guardedRun(dataRoot, async (root) => {
      await rm(join(root, "wiki", "sources", "target.md"));
    });

    expect(post.failure).toBeUndefined();
  });

  it("trips when the run renames a linked wiki page away", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "target.md"), page("# Target\n"));
    await writeFile(
      join(dataRoot, "wiki", "linker.md"),
      page("See [[target]]."),
    );
    await commit(dataRoot, "linker");

    const post = await guardedRun(dataRoot, async (root) => {
      await mkdir(join(root, "outputs"), { recursive: true });
      await run("git", ["mv", "wiki/target.md", "outputs/target.md"], {
        cwd: root,
      });
    });

    expect(post.failure).toMatchObject({
      check: 3,
      problems: expect.arrayContaining([
        expect.stringMatching(/^wiki\/linker\.md:\d+ -> \[\[target\]\]$/),
      ]),
    });
  });

  it("passes a legitimate run after a rename was staged before the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "target.md"), page("# Target\n"));
    await writeFile(
      join(dataRoot, "wiki", "linker.md"),
      page("See [[target]]."),
    );
    await commit(dataRoot, "linker");
    await run("git", ["mv", "wiki/target.md", "wiki/renamed.md"], {
      cwd: dataRoot,
    });

    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "new.md"), page());
    });

    expect(post.failure).toBeUndefined();
  });

  it("reports only the first tripped check", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "raw", "notes", "src.md"), "# tampered\n");
      await writeFile(join(root, "wiki", "plain.md"), "no frontmatter\n");
    });

    expect(post.failure?.check).toBe(1);
  });
});

describe("revertToPreRun", () => {
  it("restores tracked files and removes files the run created", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# wrecked\n"));
    await rm(join(dataRoot, "raw", "notes", "src.md"));
    await writeFile(join(dataRoot, "wiki", "new.md"), page());

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      page("# Index\n"),
    );
    expect(
      await readFile(join(dataRoot, "raw", "notes", "src.md"), "utf8"),
    ).toBe("# src\n");
    await expect(
      readFile(join(dataRoot, "wiki", "new.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps untracked files that existed before the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "settings.yml"), "command: pi\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "new.md"), page());

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    expect(await readFile(join(dataRoot, "settings.yml"), "utf8")).toBe(
      "command: pi\n",
    );
  });

  it("removes an ignored marker the run created when reverting", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, ".gitignore"), ".second-brain\n");
    await writeFile(join(dataRoot, ".second-brain"), "");

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    await expect(
      readFile(join(dataRoot, ".second-brain"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a rogue commit the run made", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# rogue\n"));
    await commit(dataRoot, "rogue");

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    const head = await run("git", ["rev-parse", "HEAD"], { cwd: dataRoot });

    expect(head.stdout.trim()).toBe(pre.commit);
    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      page("# Index\n"),
    );
  });

  it("restores uncommitted work that preceded the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# prior run\n"));

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# wrecked\n"));

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      page("# prior run\n"),
    );
  });

  it("keeps a file deleted before the run deleted after the revert", async () => {
    const dataRoot = await makeRepo();

    await rm(join(dataRoot, "raw", "notes", "src.md"));

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# wrecked\n"));

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    await expect(
      readFile(join(dataRoot, "raw", "notes", "src.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a raw note the run renamed into outputs/", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "raw/notes/src.md", "outputs/src.md"], {
      cwd: dataRoot,
    });

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    expect(
      await readFile(join(dataRoot, "raw", "notes", "src.md"), "utf8"),
    ).toBe("# src\n");
    await expect(
      readFile(join(dataRoot, "outputs", "src.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a pre-run staged rename the run moved back onto the raw note", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await run("git", ["mv", "raw/notes/src.md", "outputs/y.md"], {
      cwd: dataRoot,
    });

    const pre = await capturePreRunState(dataRoot, process.env);

    await run("git", ["mv", "-f", "outputs/y.md", "raw/notes/src.md"], {
      cwd: dataRoot,
    });

    const post = await runGuardrails(dataRoot, process.env, pre);

    await revertToPreRun(dataRoot, process.env, pre, post.entries);

    expect(await readFile(join(dataRoot, "outputs", "y.md"), "utf8")).toBe(
      "# src\n",
    );
    await expect(
      readFile(join(dataRoot, "raw", "notes", "src.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("statusSince", () => {
  it("reports no change for an untouched tree", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    expect(await statusSince(dataRoot, process.env, pre, "wiki")).toEqual({
      entries: [],
      changed: [],
      headMoved: false,
    });
  });

  it("reports a wiki file created during the run", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "queries", "q.md"), "Q\n");

    const { entries, changed } = await statusSince(
      dataRoot,
      process.env,
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
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# Index v2\n"));

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/index.md"]);
  });

  it("reports a wiki file deleted during the run", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await rm(join(dataRoot, "wiki", "index.md"));

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/index.md"]);
  });

  it("ignores a wiki page that was already dirty before the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# dirty\n"));

    const pre = await capturePreRunState(dataRoot, process.env);

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual([]);
  });

  it("reports an agent re-edit of an already-dirty page", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# dirty\n"));

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "index.md"), page("# dirtier\n"));

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/index.md"]);
  });

  it("ignores changes outside the prefix", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "raw", "notes", "new.md"), "# new\n");

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual([]);
  });

  it("reports a pre-run untracked wiki page deleted during the run", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "draft.md"), "Draft\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await rm(join(dataRoot, "wiki", "draft.md"));

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/draft.md"]);
  });

  it("reports a rename whose origin is under the prefix and target outside", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await mkdir(join(dataRoot, "notes"), { recursive: true });
    await run("git", ["mv", "wiki/index.md", "notes/index.md"], {
      cwd: dataRoot,
    });

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/index.md"]);
  });

  it("ignores a rename origin already staged before the run", async () => {
    const dataRoot = await makeRepo();

    await run("git", ["mv", "wiki/index.md", "wiki/renamed.md"], {
      cwd: dataRoot,
    });

    const pre = await capturePreRunState(dataRoot, process.env);

    const result = await statusSince(dataRoot, process.env, pre, "wiki");

    expect(result).toMatchObject({ changed: [], headMoved: false });
  });

  it("reports headMoved when the run commits", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "wiki", "new.md"), "N\n");
    await commit(dataRoot, "rogue");

    const result = await statusSince(dataRoot, process.env, pre, "wiki");

    expect(result).toMatchObject({ changed: [], headMoved: true });
  });

  it("returns the full post-run entries, not only the prefix", async () => {
    const dataRoot = await makeRepo();
    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "raw", "notes", "new.md"), "# new\n");
    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "queries", "q.md"), "Q\n");

    const { entries } = await statusSince(dataRoot, process.env, pre, "wiki");

    expect(entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["wiki/queries/q.md", "raw/notes/new.md"]),
    );
  });

  it("reports a wiki page the run staged into the index", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "draft.md"), "Draft\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await run("git", ["add", "wiki/draft.md"], { cwd: dataRoot });

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/draft.md"]);
  });

  it("lists changed paths sorted, not in discovery order", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "m.md"), "M\n");
    await commit(dataRoot, "m");

    const pre = await capturePreRunState(dataRoot, process.env);

    await mkdir(join(dataRoot, "notes"), { recursive: true });
    await run("git", ["mv", "wiki/m.md", "notes/m.md"], { cwd: dataRoot });
    await writeFile(join(dataRoot, "wiki", "a.md"), "A\n");

    expect(
      (await statusSince(dataRoot, process.env, pre, "wiki")).changed,
    ).toEqual(["wiki/a.md", "wiki/m.md"]);
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
