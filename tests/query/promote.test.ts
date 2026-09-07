import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { RunContext } from "../../src/cli/run-context.ts";
import {
  promoteLogEntry,
  promoteSandboxNote,
  templatePromotedPage,
} from "../../src/query/promote.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The fixed run clock: 2026-08-20T12:00:00Z — deterministic dates. */
const NOW = () => new Date("2026-08-20T12:00:00.000Z");

/** The sandbox note under test: a stamped concept proposal whose
 *  agent-written sources are fabrication the promotion replaces. */
const NOTE_TEXT = [
  "---",
  'title: "Attention notes"',
  "type: concept",
  "created: 2026-08-18",
  "updated: 2026-08-18",
  "tags:",
  "  - attention",
  "sources:",
  '  - "[[fabricated-agent-source]]"',
  "via: agent",
  "expires: 2026-08-27",
  "---",
  "",
  "Proposal body citing [[rag-notes]].",
  "",
].join("\n");

/** The promoted page the deterministic template must produce: the
 *  note's own frontmatter minus the sandbox stamps, the agent's
 *  sources dropped, the human's approved sources and the promotion
 *  date in, the body byte-exact. */
const PROMOTED_TEXT = [
  "---",
  'title: "Attention notes"',
  "type: concept",
  "created: 2026-08-18",
  "tags:",
  "  - attention",
  "updated: 2026-08-20",
  "sources:",
  '  - "[[rag-notes]]"',
  "---",
  "",
  "Proposal body citing [[rag-notes]].",
  "",
].join("\n");

/** The source hub page the human's approved sources must trace
 *  through to raw/. */
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

const INDEX_TEXT = [
  "# Wiki Index",
  "",
  "## Concepts",
  "",
  "## Entities",
  "",
  "## Sources",
  "",
  "## Queries",
  "",
  "## Comparisons",
  "",
].join("\n");

/** A run context over the repo, as the CLI boundary builds one. */
function contextAt(dataRoot: string): RunContext {
  return {
    dataRoot,
    rawDir: join(dataRoot, "raw"),
    wikiDir: join(dataRoot, "wiki"),
    env: process.env,
    now: NOW,
    onProgress: () => {},
  };
}

/** Commit everything in the temp repo (CI has no git identity). */
async function commitAll(dataRoot: string, message: string): Promise<void> {
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", message], { cwd: dataRoot });
}

/** One promotion input, with the overridable fixture knobs. */
function promote(
  dataRoot: string,
  input: {
    readonly slug?: string;
    readonly sources?: readonly string[];
  } = {},
) {
  return promoteSandboxNote({
    run: contextAt(dataRoot),
    slug: input.slug ?? "attention-notes",
    sources: input.sources ?? ["rag-notes"],
  });
}

/** A temp data repo: index, log, a traceable source hub, its raw
 *  origin, and the stamped sandbox note — all committed. */
async function makeRepo(
  input: {
    readonly noteText?: string;
    readonly withPeer?: boolean;
    readonly withConcept?: string;
    readonly collide?: boolean;
    readonly removeOrigin?: boolean;
  } = {},
): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-promote-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "raw", "notes", "myvault"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), INDEX_TEXT);
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log\n");
  await writeFile(
    join(dataRoot, "wiki", "sources", "rag-notes.md"),
    SOURCE_PAGE,
  );
  if (input.removeOrigin !== true) {
    await writeFile(
      join(dataRoot, "raw", "notes", "myvault", "rag.md"),
      "vault note\n",
    );
  }

  if (input.withConcept !== undefined) {
    await writeFile(
      join(dataRoot, "wiki", "concepts", `${input.withConcept}.md`),
      '---\ntitle: "Other"\ntype: concept\n---\n',
    );
  }

  if (input.collide === true) {
    await writeFile(
      join(dataRoot, "wiki", "concepts", "attention-notes.md"),
      '---\ntitle: "Attention notes"\ntype: concept\n---\n',
    );
  }
  await writeFile(
    join(dataRoot, "wiki", "sandbox", "attention-notes.md"),
    input.noteText ?? NOTE_TEXT,
  );

  if (input.withPeer === true) {
    await writeFile(
      join(dataRoot, "wiki", "sandbox", "peer-note.md"),
      "---\ntype: concept\nvia: agent\nexpires: 2026-08-27\n---\npeer\n",
    );
  }

  await run("git", ["init", "--quiet", "-b", "main"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await commitAll(dataRoot, "init");

  return dataRoot;
}

describe("templatePromotedPage", () => {
  it("keeps the note's body byte-exact", () => {
    const page = templatePromotedPage(NOTE_TEXT, ["rag-notes"], "2026-08-20");

    expect(page.endsWith("Proposal body citing [[rag-notes]].\n")).toBe(true);
  });

  it("drops the via and expires stamps", () => {
    const page = templatePromotedPage(NOTE_TEXT, ["rag-notes"], "2026-08-20");

    expect(page).not.toContain("via:");
    expect(page).not.toContain("expires:");
  });

  it("writes the human-approved sources and the promotion date", () => {
    const page = templatePromotedPage(NOTE_TEXT, ["rag-notes"], "2026-08-20");

    expect(page).toBe(PROMOTED_TEXT);
  });

  it("renders multiple approved sources in the given order", () => {
    const page = templatePromotedPage(
      NOTE_TEXT,
      ["rag-notes", "other-notes"],
      "2026-08-20",
    );

    expect(page).toContain(
      'sources:\n  - "[[rag-notes]]"\n  - "[[other-notes]]"',
    );
  });
});

describe("promoteLogEntry", () => {
  it("renders the parseable promote header with the audit body", () => {
    expect(
      promoteLogEntry({
        date: "2026-08-20",
        title: "Attention notes",
        notePath: "wiki/sandbox/attention-notes.md",
        pagePath: "wiki/concepts/attention-notes.md",
        sources: ["rag-notes"],
      }),
    ).toBe(
      [
        "## [2026-08-20] promote | Attention notes",
        "",
        "Promoted wiki/sandbox/attention-notes.md to wiki/concepts/attention-notes.md; sources: [[rag-notes]].",
        "",
      ].join("\n"),
    );
  });
});

describe("promoteSandboxNote", () => {
  it("lands the promoted page under its type directory", async () => {
    const dataRoot = await makeRepo();
    const result = await promote(dataRoot);

    expect(result.pagePath).toBe("wiki/concepts/attention-notes.md");
    expect(
      await readFile(
        join(dataRoot, "wiki", "concepts", "attention-notes.md"),
        "utf8",
      ),
    ).toBe(PROMOTED_TEXT);
  });

  it("removes the sandbox note in the same unit", async () => {
    const dataRoot = await makeRepo();
    await promote(dataRoot);

    await expect(
      readFile(join(dataRoot, "wiki", "sandbox", "attention-notes.md")),
    ).rejects.toThrow();
  });

  it("inserts the index entry under the page type's section", async () => {
    const dataRoot = await makeRepo();
    await promote(dataRoot);

    const index = await readFile(join(dataRoot, "wiki", "index.md"), "utf8");

    expect(index).toContain(
      "## Concepts\n- [[attention-notes]] — Attention notes\n",
    );
  });

  it("appends the promote audit entry to log.md", async () => {
    const dataRoot = await makeRepo();
    await promote(dataRoot);

    const log = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(log).toContain("## [2026-08-20] promote | Attention notes");
    expect(log).toContain(
      "Promoted wiki/sandbox/attention-notes.md to wiki/concepts/attention-notes.md; sources: [[rag-notes]].",
    );
  });

  it("leaves exactly one promote commit and a clean tree", async () => {
    const dataRoot = await makeRepo();
    const result = await promote(dataRoot);

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(subjects.trim().split("\n")).toEqual([
      "promote: attention-notes",
      "init",
    ]);

    // --no-renames: git would fold the sandbox-copy deletion into a
    // rename R<score> line and --name-only would hide the source.
    const { stdout: files } = await run(
      "git",
      ["show", "--name-only", "--no-renames", "--format=", "HEAD"],
      { cwd: dataRoot },
    );

    expect(files.trim().split("\n").sort()).toEqual([
      "wiki/concepts/attention-notes.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/sandbox/attention-notes.md",
    ]);

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status).toBe("");
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("accepts a bracketed sources entry as the same page name", async () => {
    const dataRoot = await makeRepo();
    const result = await promote(dataRoot, { sources: ["[[rag-notes]]"] });

    expect(result.pagePath).toBe("wiki/concepts/attention-notes.md");
  });

  it("promotes a note whose expiry is today (not yet dead)", async () => {
    const dataRoot = await makeRepo({
      noteText: NOTE_TEXT.replace("expires: 2026-08-27", "expires: 2026-08-20"),
    });
    const result = await promote(dataRoot);

    expect(result.pagePath).toBe("wiki/concepts/attention-notes.md");
  });

  it("refuses a dirty tree before anything runs", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), `${INDEX_TEXT}dirty\n`);

    const failure = await promote(dataRoot).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("dirty");
    expect(failure?.message).toContain("wiki/index.md");
    expect(
      await readFile(
        join(dataRoot, "wiki", "sandbox", "attention-notes.md"),
        "utf8",
      ),
    ).toBe(NOTE_TEXT);
  });

  it("refuses a source that names no wiki page", async () => {
    const dataRoot = await makeRepo();

    await expect(promote(dataRoot, { sources: ["Nope"] })).rejects.toThrow(
      /no wiki page named "Nope"/,
    );
  });

  it("refuses a source that is not a source page", async () => {
    const dataRoot = await makeRepo({ withConcept: "other-notes" });

    await expect(
      promote(dataRoot, { sources: ["other-notes"] }),
    ).rejects.toThrow(/is not a source page/);
  });

  it("refuses a source whose origin does not trace to raw/", async () => {
    const dataRoot = await makeRepo({ removeOrigin: true });

    await expect(promote(dataRoot)).rejects.toThrow(/does not trace to raw\//);
  });

  it("refuses an empty sources list", async () => {
    const dataRoot = await makeRepo();

    await expect(promote(dataRoot, { sources: [] })).rejects.toThrow(
      /at least one source/,
    );
  });

  it("refuses a slug that collides with an existing main page", async () => {
    const dataRoot = await makeRepo({ collide: true });

    await expect(promote(dataRoot)).rejects.toThrow(/already exists/);
    expect(
      await readFile(
        join(dataRoot, "wiki", "concepts", "attention-notes.md"),
        "utf8",
      ),
    ).not.toContain("sources");
  });

  it("refuses an expired note", async () => {
    const dataRoot = await makeRepo({
      noteText: NOTE_TEXT.replace("expires: 2026-08-27", "expires: 2026-08-19"),
    });

    await expect(promote(dataRoot)).rejects.toThrow(/expired/);
  });

  it("refuses a missing note as nothing to promote", async () => {
    const dataRoot = await makeRepo();

    await rm(join(dataRoot, "wiki", "sandbox", "attention-notes.md"));

    await expect(promote(dataRoot)).rejects.toThrow(/nothing to promote/);
  });

  it("refuses a note whose type is not a wiki page type", async () => {
    const dataRoot = await makeRepo({
      noteText: NOTE_TEXT.replace("type: concept", "type: musing"),
    });

    await expect(promote(dataRoot)).rejects.toThrow(/type/);
  });

  it("refuses an invalid slug", async () => {
    const dataRoot = await makeRepo();

    await expect(promote(dataRoot, { slug: "Not A Slug" })).rejects.toThrow(
      /kebab-case/,
    );
  });

  it("rolls back every artifact when the citation wall trips", async () => {
    const dataRoot = await makeRepo({
      noteText: NOTE_TEXT.replace(
        "Proposal body citing [[rag-notes]].",
        "Proposal body citing [[rag-notes]] and [[peer-note]].",
      ),
      withPeer: true,
    });

    const failure = await promote(dataRoot).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("citation wall");
    expect(failure?.message).toContain("peer-note");

    expect(
      await readFile(
        join(dataRoot, "wiki", "sandbox", "attention-notes.md"),
        "utf8",
      ),
    ).toContain("peer-note");
    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      INDEX_TEXT,
    );
    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      "# Wiki Log\n",
    );

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status).toBe("");
  });
});
