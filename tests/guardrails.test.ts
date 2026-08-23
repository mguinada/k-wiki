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
  revertToPreRun,
  runGuardrails,
} from "../src/ingest/guardrails.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A minimal wiki page body with valid frontmatter (guide §9). */
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
    '  - "[[index]]"',
    "---",
    "",
    body,
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
      checkWikiFrontmatter(page().replace('sources:\n  - "[[index]]"\n', "")),
    ).toEqual(['missing required frontmatter field "sources"']);
  });

  it("skips the sources check when skipSources is true", () => {
    expect(
      checkWikiFrontmatter(page().replace('sources:\n  - "[[index]]"\n', ""), {
        skipSources: true,
      }),
    ).toEqual([]);
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

/** A committed data repo: raw/notes + manifest, wiki/index.md. */
async function makeRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-guard-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw", "notes"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# src\n");
  await writeFile(join(dataRoot, "wiki", "index.md"), page("# Index\n"));
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

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.name).toBe("immutability");
    expect(post.failure?.problems[0]).toContain("raw/notes/src.md");
  });

  it("trips when the run creates a file outside the whitelist", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "settings.yml.bak"), "command: evil\n");
    });

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems[0]).toContain("settings.yml.bak");
  });

  it("trips when the run edits an already-dirty raw note", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# sync v2\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "raw", "notes", "src.md"), "# agent v3\n");

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain("raw/notes/src.md");
  });

  it("trips when the run edits a pre-run untracked file", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "settings.yml"), "command: pi\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "settings.yml"), "command: evil\n");

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain("settings.yml");
  });

  it("trips when the run renames a raw note into outputs/", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await mkdir(join(root, "outputs"), { recursive: true });
      await run("git", ["mv", "raw/notes/src.md", "outputs/src.md"], {
        cwd: root,
      });
    });

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems[0]).toContain("raw/notes/src.md");
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

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain("raw/notes/src.md");
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

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain("raw/notes/src.md");
  });

  it("trips when the run rewrites the wiki/AGENTS.md contract", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "AGENTS.md"), "rogue contract\n");
    });

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.name).toBe("immutability");
    expect(post.failure?.problems[0]).toContain("wiki/AGENTS.md");
  });

  it("trips when the run edits a non-ASCII-named untracked file", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "raw", "notes", "ノート.md"), "# one\n");

    const pre = await capturePreRunState(dataRoot, process.env);

    await writeFile(join(dataRoot, "raw", "notes", "ノート.md"), "# two\n");

    const post = await runGuardrails(dataRoot, process.env, pre);

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain("ノート.md");
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

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain(
      "raw/notes/draft -> final.md",
    );
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

    expect(post.failure?.check).toBe(1);
    expect(post.failure?.problems.join("\n")).toContain("HEAD moved");
  });
});

describe("runGuardrails — check 2, frontmatter", () => {
  it("trips when a changed wiki page has no frontmatter", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(join(root, "wiki", "plain.md"), "no frontmatter\n");
    });

    expect(post.failure?.check).toBe(2);
    expect(post.failure?.name).toBe("frontmatter");
    expect(post.failure?.problems[0]).toContain("wiki/plain.md");
    expect(post.failure?.problems[0]).toContain("no frontmatter block");
  });

  it("names the missing required field of a changed page", async () => {
    const dataRoot = await makeRepo();
    const post = await guardedRun(dataRoot, async (root) => {
      await writeFile(
        join(root, "wiki", "new.md"),
        page().replace("tags:\n  - llm\n", ""),
      );
    });

    expect(post.failure?.check).toBe(2);
    expect(post.failure?.problems[0]).toContain(
      'missing required frontmatter field "tags"',
    );
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

describe("runGuardrails — check 3, wikilinks", () => {
  it("accepts a cross-wiki link in a changed page of a second brain", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "second-brain"), { recursive: true });
    await writeFile(
      join(dataRoot, "wiki", "second-brain", "profile.md"),
      "---\ntitle: Profile\ntype: profile\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - brain\n---\n\n# Profile\n",
    );
    await commit(dataRoot, "seed second-brain profile");

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

    await mkdir(join(dataRoot, "wiki", "second-brain"), { recursive: true });
    await writeFile(
      join(dataRoot, "wiki", "second-brain", "profile.md"),
      "---\ntitle: Profile\ntype: profile\ncreated: 2026-08-22\nupdated: 2026-08-22\ntags:\n  - brain\n---\n\n# Profile\n",
    );
    await commit(dataRoot, "seed second-brain profile");

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

    expect(post.failure?.check).toBe(3);
    expect(post.failure?.name).toBe("wikilinks");
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

    expect(post.failure?.check).toBe(3);
    expect(post.failure?.name).toBe("wikilinks");
    expect(post.failure?.problems[0]).toMatch(
      /^wiki\/new\.md:\d+ -> \[\[Does Not Exist\]\]$/,
    );
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

    expect(post.failure?.check).toBe(3);
    expect(post.failure?.problems[0]).toMatch(
      /^wiki\/linker\.md:\d+ -> \[\[target\]\]$/,
    );
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

    expect(post.failure?.check).toBe(3);
    expect(post.failure?.problems[0]).toMatch(
      /^wiki\/linker\.md:\d+ -> \[\[target\]\]$/,
    );
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

    expect(post.failure?.check).toBe(3);
    expect(post.failure?.problems[0]).toMatch(
      /^wiki\/linker\.md:\d+ -> \[\[target\]\]$/,
    );
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
