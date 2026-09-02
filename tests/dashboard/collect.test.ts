import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { collectData, parseAdditionLog } from "../../src/dashboard/collect.ts";

/**
 * The collector's contract (issue #73): read every artifact the
 * dashboard consumes — wiki pages, raw notes, the raw manifest, the
 * ingest snapshot, git history, last-query.md — into one pure
 * DashboardInput, degrading to defaults when an artifact is absent.
 * Asserted by deep equality against a fully specified expected input.
 */

const run = promisify(execFileCb);
const NOW = new Date("2026-09-01T12:00:00.000Z");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
  });
}

async function commit(
  cwd: string,
  date: string,
  message: string,
): Promise<void> {
  await git(
    cwd,
    "commit",
    "--quiet",
    "--allow-empty",
    `--date=${date}T10:00:00Z`,
    "-m",
    message,
  );
}

/** A page's closed frontmatter block plus optional body. */
function page(lines: string[], body = ""): string {
  return `${["---", ...lines, "---"].join("\n")}\n${body}`;
}

/** A data repo with every artifact present: two vaults of raw notes,
 *  a manifest with junk entries, an ingest snapshot, wiki pages that
 *  exercise every frontmatter edge, git history with ingest runs, a
 *  status flip, and page additions. */
async function makeRichRepo(): Promise<{
  dataRoot: string;
  head: string;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-collect-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw", "notes", "Engineering"), {
    recursive: true,
  });
  await mkdir(join(dataRoot, "raw", "notes", "Research"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "outputs"), { recursive: true });

  await writeFile(join(dataRoot, "raw", "notes", "Engineering", "a.md"), "a");
  await writeFile(join(dataRoot, "raw", "notes", "Engineering", "b.md"), "b");
  await writeFile(join(dataRoot, "raw", "notes", "Research", "c.md"), "c");
  await writeFile(join(dataRoot, "raw", "notes", "Engineering", "x.txt"), "x");
  await writeFile(join(dataRoot, "raw", "notes", ".gitkeep"), "");

  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({
      vaults: {
        Research: {
          "c.md": { hash: "c", last_synced: "2026-08-20T00:00:00.000Z" },
          junk: "not-an-object",
        },
        Engineering: {
          "b.md": { hash: "b", last_synced: "2026-08-25T00:00:00.000Z" },
          "a.md": { hash: "a", last_synced: "2026-08-10T00:00:00.000Z" },
          "null.md": null,
        },
        Broken: "not-a-vault",
      },
    })}\n`,
  );

  await writeFile(
    join(dataRoot, "outputs", "last-ingested-manifest.json"),
    `${JSON.stringify({
      vaults: {
        Engineering: { "a.md": { hash: "a" } },
        Bad: null,
      },
    })}\n`,
  );

  await writeFile(join(dataRoot, "wiki", "AGENTS.md"), "contract\n");
  await writeFile(join(dataRoot, "wiki", "AGENTS.meta.md"), "meta\n");
  await writeFile(join(dataRoot, "wiki", "notes.txt"), "not markdown\n");

  await writeFile(
    join(dataRoot, "wiki", "agent-evals.md"),
    page(
      [
        'title: "Agent evals"',
        "type: concept",
        "updated: 2026-08-20",
        "status: stable",
        "sources:",
        '  - "notes/Engineering/a.md"',
      ],
      "See [[beginner-roadmap]] and [[missing-page]].",
    ),
  );
  await writeFile(
    join(dataRoot, "wiki", "beginner-roadmap.md"),
    page(["type: source", "updated: 2026-08-15", "status: stable"], "Body."),
  );
  await writeFile(
    join(dataRoot, "wiki", "no-frontmatter.md"),
    "Just a body with a [[beginner-roadmap]] link.\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "concepts", "deep note.md"),
    page(["type: concept", "status: 'filed'"], "Body."),
  );
  await writeFile(
    join(dataRoot, "outputs", "last-query.md"),
    '---\nquestion: "Why?"\npages: []\ntimestamp: "2026-08-30T10:00:00.000Z"\n---\n\nBecause.\n',
  );

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await git(dataRoot, "add", "-A");
  await commit(dataRoot, "2026-08-10", "init");

  await writeFile(
    join(dataRoot, "wiki", "agent-evals.md"),
    page(
      [
        'title: "Agent evals"',
        "type: concept",
        "updated: 2026-08-20",
        "status: needs-review",
        "sources:",
        '  - "notes/Engineering/a.md"',
      ],
      "See [[beginner-roadmap]] and [[missing-page]].",
    ),
  );
  await git(dataRoot, "add", "-A");
  await commit(dataRoot, "2026-08-20", "flip a page to needs-review");

  await commit(dataRoot, "2026-08-25", "wiki-sync: 12 sources processed");

  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], {
    cwd: dataRoot,
  });

  return { dataRoot, head: stdout.trim() };
}

describe("collectData", () => {
  it("counts a wiki file named like a date marker in the growth series", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-collect-datename-"));

    tempDirs.push(dataRoot);
    await mkdir(join(dataRoot, "wiki"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "A2025-01-01.md"), "body\n");
    await writeFile(join(dataRoot, "wiki", "normal.md"), "body\n");
    await run("git", ["init", "--quiet"], { cwd: dataRoot });
    await git(dataRoot, "add", "-A");
    await commit(dataRoot, "2026-08-10", "add pages");

    const input = await collectData(dataRoot, { now: () => NOW });

    expect(input.firstAdded).toContainEqual({
      path: "wiki/A2025-01-01.md",
      date: "2026-08-10",
    });
  });

  it("reads every artifact of a fully populated data repo into the exact expected input", async () => {
    const { dataRoot, head } = await makeRichRepo();

    const input = await collectData(dataRoot, { now: () => NOW });

    expect(input).toEqual({
      now: NOW,
      head,
      pages: [
        {
          path: "agent-evals.md",
          title: "Agent evals",
          type: "concept",
          updated: "2026-08-20",
          status: "needs-review",
          sourcesCount: 1,
          sources: ["notes/Engineering/a.md"],
          outbound: ["beginner-roadmap", "missing-page"],
        },
        {
          path: "beginner-roadmap.md",
          title: "beginner-roadmap",
          type: "source",
          updated: "2026-08-15",
          status: "stable",
          sourcesCount: 0,
          sources: [],
          outbound: [],
        },
        {
          path: "concepts/deep note.md",
          title: "deep note",
          type: "concept",
          updated: null,
          status: "filed",
          sourcesCount: 0,
          sources: [],
          outbound: [],
        },
        {
          path: "no-frontmatter.md",
          title: "no-frontmatter",
          type: "unset",
          updated: null,
          status: null,
          sourcesCount: 0,
          sources: [],
          outbound: ["beginner-roadmap"],
        },
      ],
      rawNoteKeys: ["Engineering/a.md", "Engineering/b.md", "Research/c.md"],
      ingestedKeys: ["Engineering/a.md"],
      lastSync: "2026-08-25T00:00:00.000Z",
      rawNoteSyncDates: [
        { key: "Research/c.md", lastSynced: "2026-08-20T00:00:00.000Z" },
        { key: "Engineering/b.md", lastSynced: "2026-08-25T00:00:00.000Z" },
        { key: "Engineering/a.md", lastSynced: "2026-08-10T00:00:00.000Z" },
      ],
      statusFlips: [
        { date: "2026-08-20", subject: "flip a page to needs-review" },
      ],
      commits: [
        { date: "2026-08-25", subject: "wiki-sync: 12 sources processed" },
        { date: "2026-08-20", subject: "flip a page to needs-review" },
        { date: "2026-08-10", subject: "init" },
      ],
      firstAdded: [
        { path: "wiki/agent-evals.md", date: "2026-08-10" },
        { path: "wiki/beginner-roadmap.md", date: "2026-08-10" },
        { path: "wiki/concepts/deep note.md", date: "2026-08-10" },
        { path: "wiki/no-frontmatter.md", date: "2026-08-10" },
      ],
      lastQuery: "2026-08-30T10:00:00.000Z",
    });
  });

  it("degrades to pure defaults in an empty directory with no git repo", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-collect-empty-"));

    tempDirs.push(dataRoot);

    const input = await collectData(dataRoot, { now: () => NOW });

    expect(input).toEqual({
      now: NOW,
      head: "",
      pages: [],
      rawNoteKeys: [],
      ingestedKeys: null,
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });
  });
});

describe("collectData page fields", () => {
  async function collectPagesFrom(
    name: string,
    content: string,
  ): Promise<{ updated: string | null; status: string | null }> {
    const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-collect-page-"));

    tempDirs.push(dataRoot);

    await mkdir(join(dataRoot, "wiki"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", name), content);

    const input = await collectData(dataRoot, { now: () => NOW });
    const first = input.pages[0];

    return {
      updated: first === undefined ? "no page" : first.updated,
      status: first === undefined ? "no page" : first.status,
    };
  }

  it("returns the first matching scalar field when a key repeats", async () => {
    const fields = await collectPagesFrom(
      "repeat.md",
      page(["updated: 2026-08-01", "updated: 2026-08-02", "status: stable"]),
    );

    expect(fields).toEqual({ updated: "2026-08-01", status: "stable" });
  });

  it("parses scalar fields when the frontmatter has no closing delimiter", async () => {
    const fields = await collectPagesFrom(
      "unclosed.md",
      "---\nupdated: 2026-08-03\nstatus: filed\nbody text\n",
    );

    expect(fields).toEqual({ updated: "2026-08-03", status: "filed" });
  });

  it("trims matching quotes from both ends of a scalar value", async () => {
    const fields = await collectPagesFrom(
      "quoted.md",
      page(['updated: "2026-08-04"', "status: 'filed'"]),
    );

    expect(fields).toEqual({ updated: "2026-08-04", status: "filed" });
  });

  it("collapses surrounding whitespace around a scalar value", async () => {
    const fields = await collectPagesFrom(
      "spaced.md",
      "---\nupdated:    2026-08-05   \n---\n",
    );

    expect(fields.updated).toBe("2026-08-05");
  });

  it("treats an empty scalar value as absent", async () => {
    const fields = await collectPagesFrom(
      "empty.md",
      page(["updated:", "status:"]),
    );

    expect(fields).toEqual({ updated: null, status: null });
  });

  it("ignores keys that are a suffix of the requested key", async () => {
    const fields = await collectPagesFrom(
      "suffix.md",
      page(["coupdated: 2026-08-06", "status: stable"]),
    );

    expect(fields.updated).toBeNull();
  });

  it("reports no lastQuery when the artifact lacks a timestamp line", async () => {
    const { dataRoot } = await makeRichRepo();

    await writeFile(
      join(dataRoot, "outputs", "last-query.md"),
      '---\nquestion: "Why?"\n---\n\nNo timestamp.\n',
    );

    const input = await collectData(dataRoot, { now: () => NOW });

    expect(input.lastQuery).toBeNull();
  });

  it("reads the timestamp from a multi-line last-query artifact", async () => {
    const { dataRoot } = await makeRichRepo();

    await writeFile(
      join(dataRoot, "outputs", "last-query.md"),
      '---\nquestion: "Why?"\ntimestamp: "2026-08-29T08:00:00.000Z"\npages: []\n---\n\nBecause.\n',
    );

    const input = await collectData(dataRoot, { now: () => NOW });

    expect(input.lastQuery).toBe("2026-08-29T08:00:00.000Z");
  });
});

describe("parseAdditionLog", () => {
  it("treats a path named like the format marker as a path, not a date marker", () => {
    const additions = parseAdditionLog("A2026-02-02\n\nA2025-01-01.md\n");

    expect(additions).toEqual([{ path: "A2025-01-01.md", date: "2026-02-02" }]);
  });

  it("switches the date only on the full-line A + short-ISO marker", () => {
    const additions = parseAdditionLog(
      "A2026-02-02\nnormal.md\nAnot-a-date.md\n",
    );

    expect(additions).toEqual([
      { path: "normal.md", date: "2026-02-02" },
      { path: "Anot-a-date.md", date: "2026-02-02" },
    ]);
  });
});
