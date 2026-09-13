import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  computeWikiWorklists,
  filterWorklistsToWindow,
  renderWorklists,
} from "../../src/wiki/worklists.ts";

/**
 * The deterministic lint pre-pass (issue #359 B): every worklist is a
 * candidate list computed in one tree pass — the agent judges, the
 * code never decides.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeWiki(pages: Record<string, string>): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-worklists-"));
  const wikiDir = join(tmp, "wiki");

  dirs.push(tmp);
  await mkdir(wikiDir, { recursive: true });

  for (const [file, body] of Object.entries(pages)) {
    await mkdir(join(wikiDir, file, ".."), { recursive: true });
    await writeFile(join(wikiDir, file), body, "utf8");
  }

  return wikiDir;
}

const FULL_FRONTMATTER = [
  "---",
  'title: "X"',
  "type: concept",
  "created: 2026-01-01",
  "updated: 2026-01-01",
  "tags:",
  "  - llm",
  "sources:",
  '  - "[[hub]]"',
  '  - "[[hub-2]]"',
  "---",
  "",
].join("\n");

function page(overrides: string[] = []): string {
  return `${FULL_FRONTMATTER}${overrides.join("\n")}\nbody\n`;
}

/** The clean non-source page: exactly one sources entry ([[hub]]). */
function singleSourcePage(overrides: string[] = []): string {
  return `${FULL_FRONTMATTER.replace('  - "[[hub-2]]"\n', "")}${overrides.join("\n")}\nbody\n`;
}

const SOURCE_PAGE = [
  "---",
  'title: "Hub"',
  "type: source",
  "created: 2026-01-01",
  "updated: 2026-01-01",
  "tags:",
  "  - source",
  "---",
  "",
].join("\n");

describe("computeWikiWorklists", () => {
  it("flags pages with no inbound links as orphan candidates", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n\n- [[a]]\n",
      "a.md": page(["see [[b]]"]),
      "b.md": page(),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    // b has an inbound link from a; nothing links to a except index
    // — still an orphan candidate? No: index links to a, and index
    // links count as inbound.
    expect(worklists.orphans).toEqual([]);
  });

  it("flags an unlinked content page as an orphan candidate", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n",
      "a.md": page(),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.orphans).toEqual([
      { page: "a.md", detail: "no inbound links" },
    ]);
  });

  it("does not flag structural pages as orphans", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n",
      "overview.md": "# Overview\n",
      "log.md": "# Log\n",
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.orphans).toEqual([]);
  });

  it("lists single-source pages with their one entry", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n",
      "hub.md": SOURCE_PAGE,
      "a.md": singleSourcePage(["see [[hub]]"]),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.singleSource).toEqual([
      { page: "a.md", detail: "sources: [[hub]]" },
    ]);
  });

  it("flags sources entries citing a non-source page", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n",
      "hub.md": SOURCE_PAGE,
      "a.md": singleSourcePage().replace('  - "[[hub]]"', '  - "[[b]]"'),
      "b.md": singleSourcePage(),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.nonSourceEdges).toEqual([
      { page: "a.md", detail: "sources entry [[b]] cites type: concept" },
    ]);
  });

  it("flags sources entries with no page target", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n",
      "hub.md": SOURCE_PAGE,
      "a.md": page().replace('  - "[[hub-2]]"', '  - "[[ghost]]"'),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.nonSourceEdges).toEqual([
      { page: "a.md", detail: "sources entry [[ghost]] has no page target" },
    ]);
  });

  it("flags missing required frontmatter fields", async () => {
    const wikiDir = await makeWiki({
      "index.md":
        "---\ntitle: I\ntype: topic\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - nav\n---\n# Index\n",
      "a.md": "---\ntitle: A\ntype: concept\n---\nbody\n",
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.frontmatterMisses).toEqual([
      {
        page: "a.md",
        detail: "missing: created, updated, tags, sources",
      },
    ]);
  });

  it("invents no sources requirement for source pages and index", async () => {
    const wikiDir = await makeWiki({
      "index.md":
        "---\ntitle: I\ntype: topic\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - nav\n---\n# Index\n",
      "hub.md": SOURCE_PAGE,
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.frontmatterMisses).toEqual([]);
  });

  it("collects the tag inventory", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n- [[a]]\n- [[b]]\n",
      "a.md": page(),
      "b.md": page().replace("  - llm", "  - rag"),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.tagDrift).toEqual([
      { page: "a.md", detail: "llm" },
      { page: "b.md", detail: "rag" },
    ]);
  });

  it("flags content pages missing from index.md", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n- [[a]]\n",
      "a.md": page(),
      "b.md": page(),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.indexMisses).toEqual([
      { page: "b.md", detail: "not listed in index.md" },
    ]);
  });

  it("flags dangling index entries separately", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n- [[ghost]]\n",
      "a.md": page(),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.danglingIndexEntries).toEqual([
      "index.md -> [[ghost]] has no page",
    ]);
  });

  it("flags duplicate titles by their kebab slug", async () => {
    const wikiDir = await makeWiki({
      "index.md": "# Index\n",
      "a.md": page(),
      "b.md": page().replace('title: "X"', 'title: "x"'),
    });

    const worklists = await computeWikiWorklists(wikiDir);

    expect(worklists.duplicateTitles).toEqual([
      { page: "a.md", detail: 'title slug "x" shared with b.md' },
      { page: "b.md", detail: 'title slug "x" shared with a.md' },
    ]);
  });
});

describe("filterWorklistsToWindow", () => {
  it("keeps only window pages, and the index's own dangling entries", () => {
    const worklists = {
      orphans: [
        { page: "a.md", detail: "no inbound links" },
        { page: "c.md", detail: "no inbound links" },
      ],
      singleSource: [{ page: "c.md", detail: "sources: [[hub]]" }],
      nonSourceEdges: [],
      frontmatterMisses: [],
      tagDrift: [{ page: "a.md", detail: "llm" }],
      indexMisses: [],
      duplicateTitles: [],
      danglingIndexEntries: ["index.md -> [[ghost]] has no page"],
    };

    expect(filterWorklistsToWindow(worklists, ["a.md"])).toEqual({
      orphans: [{ page: "a.md", detail: "no inbound links" }],
      singleSource: [],
      nonSourceEdges: [],
      frontmatterMisses: [],
      tagDrift: [{ page: "a.md", detail: "llm" }],
      indexMisses: [],
      duplicateTitles: [],
      danglingIndexEntries: ["index.md -> [[ghost]] has no page"],
    });
  });
});

describe("renderWorklists", () => {
  it("renders one evidence line per candidate and (none) sections", () => {
    const text = renderWorklists({
      orphans: [{ page: "a.md", detail: "no inbound links" }],
      singleSource: [],
      nonSourceEdges: [],
      frontmatterMisses: [],
      tagDrift: [],
      indexMisses: [],
      duplicateTitles: [],
      danglingIndexEntries: [],
    });

    expect(text).toContain("- a.md — no inbound links");
    expect(text).toContain("### Orphan candidates (1)");
    expect(text).toContain("### Single-source pages (0)");
    expect(text).toContain("(none)");
  });
});
