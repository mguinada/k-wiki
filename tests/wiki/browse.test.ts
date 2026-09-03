import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  filteredLines,
  groupedLines,
  groupPages,
  isPageType,
  listablePages,
  lookupPage,
} from "../../src/wiki/browse.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A fresh wiki tree with one frontmatter page written into it. */
async function makeWiki(
  path: string,
  type: string | undefined,
  title: string | undefined,
  body = "Body.",
): Promise<string> {
  const wikiDir = await mkdtemp(join(tmpdir(), "k-wiki-browse-"));

  tempDirs.push(wikiDir);

  const full = join(wikiDir, path);

  await mkdir(dirname(full), { recursive: true });

  const front = [
    ...(type === undefined ? [] : [`type: ${type}`]),
    ...(title === undefined ? [] : [`title: ${title}`]),
  ];
  const text =
    front.length === 0 ? body : ["---", ...front, "---", body].join("\n");

  await writeFile(full, text);

  return wikiDir;
}

/** The slug part of every listed page, in listing order. */
function slugs(pages: readonly { readonly slug: string }[]): string[] {
  return pages.map((page) => page.slug);
}

describe("isPageType", () => {
  it("accepts a type from the wiki page-type vocabulary", () => {
    expect(isPageType("concept")).toBe(true);
  });

  it("rejects a type outside the vocabulary", () => {
    expect(isPageType("wikignome")).toBe(false);
  });
});

describe("listablePages", () => {
  it("collects slug and frontmatter type and title for a page", async () => {
    const wikiDir = await makeWiki("concepts/rag.md", "concept", "RAG");

    expect(await listablePages(wikiDir)).toEqual([
      { path: "concepts/rag.md", slug: "rag", type: "concept", title: "RAG" },
    ]);
  });

  it("omits the navigation pages from the listing", async () => {
    const wikiDir = await makeWiki("notes.md", "concept", "Notes");
    await makeWiki(join(wikiDir, "placeholder"), undefined, undefined);

    await writeFile(join(wikiDir, "index.md"), "# Index");
    await writeFile(join(wikiDir, "log.md"), "# Wiki Log");
    await writeFile(join(wikiDir, "overview.md"), "# Overview");

    expect(slugs(await listablePages(wikiDir))).toEqual(["notes"]);
  });

  it("lists a page without a type with an undefined type", async () => {
    const wikiDir = await makeWiki("plain.md", undefined, undefined);

    expect(slugs(await listablePages(wikiDir))).toEqual(["plain"]);
    expect((await listablePages(wikiDir))[0]?.type).toBeUndefined();
  });
});

describe("filteredLines", () => {
  it("renders one slug-title line per page of the requested type", () => {
    const pages = [
      { path: "a.md", slug: "rag", type: "concept", title: "RAG" },
      { path: "b.md", slug: "hub", type: "source", title: "Hub" },
    ];

    expect(filteredLines(pages, "concept")).toEqual(["rag — RAG"]);
  });

  it("falls back to the slug when a page has no title", () => {
    const pages = [
      { path: "a.md", slug: "plain", type: "concept", title: undefined },
    ];

    expect(filteredLines(pages, "concept")).toEqual(["plain — plain"]);
  });
});

describe("groupPages", () => {
  it("groups pages by their frontmatter type", () => {
    const pages = [
      { path: "a.md", slug: "rag", type: "concept", title: "RAG" },
      { path: "b.md", slug: "hub", type: "source", title: "Hub" },
    ];
    const groups = groupPages(pages);

    expect(groups.get("concept")).toEqual([pages[0]]);
    expect(groups.get("source")).toEqual([pages[1]]);
  });

  it("collects pages without a type under untyped", () => {
    const pages = [
      { path: "a.md", slug: "plain", type: undefined, title: undefined },
    ];

    expect(groupPages(pages).get("untyped")).toEqual([pages[0]]);
  });
});

describe("groupedLines", () => {
  it("orders the known type sections in the wiki type order", () => {
    const wiki = [
      { path: "q.md", slug: "when-rag", type: "query", title: "When RAG" },
      { path: "r.md", slug: "rag", type: "concept", title: "RAG" },
      { path: "c.md", slug: "vs", type: "comparison", title: "VS" },
      { path: "s.md", slug: "hub", type: "source", title: "Hub" },
      { path: "e.md", slug: "repo", type: "entity", title: "Repo" },
    ];

    expect(
      groupedLines(groupPages(wiki)).filter((l) => l.startsWith("##")),
    ).toEqual([
      "## concepts",
      "## entities",
      "## sources",
      "## queries",
      "## comparisons",
    ]);
  });

  it("pluralizes an unknown type section after the known ones", () => {
    const wiki = [
      { path: "w.md", slug: "wiki", type: "wikignome", title: "Wiki" },
      { path: "r.md", slug: "rag", type: "concept", title: "RAG" },
    ];

    expect(
      groupedLines(groupPages(wiki)).filter((l) => l.startsWith("##")),
    ).toEqual(["## concepts", "## wikignomes"]);
  });

  it("keeps the untyped section last without pluralizing it", () => {
    const wiki = [
      { path: "p.md", slug: "plain", type: undefined, title: undefined },
      { path: "r.md", slug: "rag", type: "concept", title: "RAG" },
    ];

    expect(
      groupedLines(groupPages(wiki)).filter((l) => l.startsWith("##")),
    ).toEqual(["## concepts", "## untyped"]);
  });

  it("renders the pages under a section header in group order", () => {
    const wiki = [
      { path: "a.md", slug: "rag", type: "concept", title: "RAG" },
      { path: "b.md", slug: "mem", type: "concept", title: "Memory" },
    ];

    expect(groupedLines(groupPages(wiki))).toEqual([
      "## concepts",
      "rag — RAG",
      "mem — Memory",
    ]);
  });
});

describe("lookupPage", () => {
  it("reads the matching page verbatim", async () => {
    const wikiDir = await makeWiki(
      "concepts/rag.md",
      "concept",
      "RAG",
      "Body.",
    );

    expect(await lookupPage(wikiDir, "rag")).toEqual({
      kind: "page",
      content: "---\ntype: concept\ntitle: RAG\n---\nBody.",
    });
  });

  it("reports the near matches for a slug substring", async () => {
    const wikiDir = await makeWiki("concepts/rag.md", "concept", "RAG");

    expect(await lookupPage(wikiDir, "rag-extra")).toEqual({
      kind: "missing",
      nearMatches: ["rag"],
    });
  });

  it("matches near slugs case-insensitively", async () => {
    const wikiDir = await makeWiki("concepts/rag.md", "concept", "RAG");

    expect(await lookupPage(wikiDir, "RAGX")).toEqual({
      kind: "missing",
      nearMatches: ["rag"],
    });
  });

  it("reports no near matches when none contain the slug", async () => {
    const wikiDir = await makeWiki("concepts/rag.md", "concept", "RAG");

    expect(await lookupPage(wikiDir, "nothing")).toEqual({
      kind: "missing",
      nearMatches: [],
    });
  });

  it("reports ambiguity when several pages share the file name", async () => {
    const wikiDir = await makeWiki("concepts/dupe.md", "concept", "A");

    await mkdir(join(wikiDir, "sources"), { recursive: true });
    await writeFile(join(wikiDir, "sources", "dupe.md"), "B");

    expect(await lookupPage(wikiDir, "dupe")).toEqual({
      kind: "ambiguous",
      matches: ["concepts/dupe.md", "sources/dupe.md"],
    });
  });
});
