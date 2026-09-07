import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers.ts";

const run = promisify(execFile);

const PROMOTE_SCRIPT = join(repoRoot, "bin", "libexec", "wiki-promote");

/**
 * wiki-promote e2e (issue #341): the human door's promotion of a
 * sandbox note through the real libexec launcher — the one-unit
 * landing (page + index + log + sandbox-copy deletion, one commit),
 * the citation-wall rollback, the dirty-tree refusal, the
 * already-promoted and untraceable-sources refusals. The agent-door
 * absence is pinned in k-wiki.e2e.test.ts's dispatcher suite; a
 * human review of a real promotion stays a human check.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The note's expiry: a week out from the real clock (the CLI stamps
 *  and judges against the wall clock, so the fixture must too). */
function futureExpiry(): string {
  return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
}

/** The stamped sandbox note under test. */
function noteText(body: string): string {
  return [
    "---",
    'title: "Attention notes"',
    "type: concept",
    "sources:",
    '  - "[[fabricated-agent-source]]"',
    "via: agent",
    `expires: ${futureExpiry()}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** The traceable source hub the approved sources name. */
const SOURCE_PAGE = [
  "---",
  'title: "RAG notes"',
  "type: source",
  "origin: raw/notes/myvault/rag.md",
  "---",
  "",
  "The RAG source page.",
  "",
].join("\n");

/** A temp data repo: index, log, the source hub, its raw origin,
 *  and the stamped sandbox note — all committed. */
async function makeRepo(
  input: { readonly noteBody?: string } = {},
): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-promote-e2e-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });
  await mkdir(join(dataRoot, "raw", "notes", "myvault"), { recursive: true });
  await writeFile(
    join(dataRoot, "wiki", "index.md"),
    "# Wiki Index\n\n## Concepts\n\n## Sources\n",
  );
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log\n");
  await writeFile(
    join(dataRoot, "wiki", "sources", "rag-notes.md"),
    SOURCE_PAGE,
  );
  await writeFile(
    join(dataRoot, "raw", "notes", "myvault", "rag.md"),
    "vault note\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "sandbox", "attention-notes.md"),
    noteText(input.noteBody ?? "Proposal body citing [[rag-notes]]."),
  );
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });

  return dataRoot;
}

/** Run the launcher against the repo's raw dir. */
function promoteCli(dataRoot: string, args: readonly string[]) {
  return runCli(PROMOTE_SCRIPT, ["--raw-dir", join(dataRoot, "raw"), ...args]);
}

describe("wiki-promote e2e", () => {
  it("walks a sandbox note into the main wiki as one unit", async () => {
    const dataRoot = await makeRepo();
    const result = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "rag-notes",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Promoted: wiki/concepts/attention-notes.md");

    const page = await readFile(
      join(dataRoot, "wiki", "concepts", "attention-notes.md"),
      "utf8",
    );

    expect(page).toContain("Proposal body citing [[rag-notes]].");
    expect(page).toContain('sources:\n  - "[[rag-notes]]"');
    expect(page).not.toContain("via:");
    expect(page).not.toContain("expires:");
    expect(page).not.toContain("fabricated-agent-source");

    expect(
      await readFile(join(dataRoot, "wiki", "index.md"), "utf8"),
    ).toContain("- [[attention-notes]] — Attention notes");

    const log = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(log).toContain("] promote | Attention notes");

    await expect(
      readFile(join(dataRoot, "wiki", "sandbox", "attention-notes.md")),
    ).rejects.toThrow();

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(subjects.trim().split("\n")).toEqual([
      "promote: attention-notes",
      "init",
    ]);

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status).toBe("");
  });

  it("refuses to promote the same slug twice (the note is gone)", async () => {
    const dataRoot = await makeRepo();
    const first = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "rag-notes",
    ]);

    expect(first.code).toBe(0);

    const second = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "rag-notes",
    ]);

    expect(second.code).toBe(1);
    expect(second.err).toContain("nothing to promote");
  });

  it("refuses a dirty data repo before anything runs", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "# dirty\n");

    const result = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "rag-notes",
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("dirty");

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status.trim()).toBe("M wiki/index.md");
  });

  it("refuses sources that do not trace to raw/", async () => {
    const dataRoot = await makeRepo();
    const result = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "no-such-page",
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('no wiki page named "no-such-page"');
  });

  it("promotes cleanly while unrelated sandbox peers exist", async () => {
    const dataRoot = await makeRepo();

    await writeFile(
      join(dataRoot, "wiki", "sandbox", "peer-note.md"),
      `---\ntype: concept\nvia: agent\nexpires: ${futureExpiry()}\n---\npeer\n`,
    );
    await run("git", ["add", "-A"], { cwd: dataRoot });
    await run("git", ["commit", "--quiet", "-m", "peer"], { cwd: dataRoot });

    const result = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "rag-notes",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Promoted: wiki/concepts/attention-notes.md");
  });

  it("rolls back the whole unit when the citation wall trips", async () => {
    const dataRoot = await makeRepo({
      noteBody: "Proposal body citing [[rag-notes]] and [[peer-note]].",
    });

    await writeFile(
      join(dataRoot, "wiki", "sandbox", "peer-note.md"),
      `---\ntype: concept\nvia: agent\nexpires: ${futureExpiry()}\n---\npeer\n`,
    );
    await run("git", ["add", "-A"], { cwd: dataRoot });
    await run("git", ["commit", "--quiet", "-m", "peer"], { cwd: dataRoot });

    const failure = await promoteCli(dataRoot, [
      "attention-notes",
      "--sources",
      "rag-notes",
    ]);

    expect(failure.code).toBe(1);
    expect(failure.err).toContain("citation wall");

    expect(
      await readFile(
        join(dataRoot, "wiki", "sandbox", "attention-notes.md"),
        "utf8",
      ),
    ).toContain("peer-note");
    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Wiki Index\n\n## Concepts\n\n## Sources\n",
    );

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status).toBe("");
  });
});
