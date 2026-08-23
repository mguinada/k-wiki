import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildPageIndex,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  parsePageFields,
  readPageFields,
  wikilinkTarget,
} from "../src/wiki/pages.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parsePageFields", () => {
  it("reads a plain origin scalar", () => {
    expect(
      parsePageFields(
        "---\ntitle: T\norigin: raw/notes/Documents/AI/RAG.md\n---\nbody",
      ),
    ).toMatchObject({ origin: "raw/notes/Documents/AI/RAG.md" });
  });

  it("unquotes a quoted origin scalar", () => {
    expect(
      parsePageFields('---\norigin: "raw/notes/V/a.md"\n---\n'),
    ).toMatchObject({ origin: "raw/notes/V/a.md" });
  });

  it("reads the page type scalar like origin", () => {
    expect(parsePageFields('---\ntype: "source"\n---\n')).toMatchObject({
      type: "source",
    });
  });

  it("treats a whitespace-only scalar as absent", () => {
    expect(parsePageFields("---\norigin:   \n---\n")).toMatchObject({
      origin: undefined,
    });
  });

  it("trims a whitespace-only sources item to an empty entry", () => {
    expect(parsePageFields("---\nsources:\n  -   \n---\n").sources).toEqual([
      "",
    ]);
  });

  it("collects sources entries as written", () => {
    const fields = parsePageFields(
      '---\nsources:\n  - "[[Temp research]]"\n  - "notes/V/RAG.md"\n  - https://example.com\n---\n',
    );

    expect(fields.sources).toEqual([
      "[[Temp research]]",
      "notes/V/RAG.md",
      "https://example.com",
    ]);
  });

  it("unquotes each sources entry", () => {
    const fields = parsePageFields("---\nsources:\n  - 'notes/V/a.md'\n---\n");

    expect(fields.sources).toEqual(["notes/V/a.md"]);
  });

  it("returns empty fields for a page without frontmatter", () => {
    expect(parsePageFields("# Just a page\n")).toEqual({ sources: [] });
  });

  it("returns empty fields when the frontmatter is never closed", () => {
    expect(parsePageFields("---\norigin: raw/notes/V/a.md\n")).toEqual({
      sources: [],
    });
  });

  it("stops the sources list at the next top-level key", () => {
    const fields = parsePageFields(
      '---\nsources:\n  - "[[A]]"\ntags:\n  - "[[B]]"\n---\n',
    );

    expect(fields.sources).toEqual(["[[A]]"]);
  });

  it("ignores list items under keys other than sources", () => {
    const fields = parsePageFields(
      '---\nrelated:\n  - "[[A]]"\nauthor: someone\n---\n',
    );

    expect(fields.sources).toEqual([]);
    expect(fields.origin).toBeUndefined();
  });
  it("does not read origin from the page body", () => {
    expect(
      parsePageFields("---\ntitle: T\n---\norigin: raw/notes/V/a.md"),
    ).toMatchObject({ origin: undefined });
  });

  it("keeps the last origin when the key repeats", () => {
    expect(
      parsePageFields(
        "---\norigin: raw/notes/V/a.md\norigin: raw/notes/V/b.md\n---\n",
      ),
    ).toMatchObject({ origin: "raw/notes/V/b.md" });
  });

  it("returns empty fields for empty text", () => {
    expect(parsePageFields("")).toEqual({ origin: undefined, sources: [] });
  });

  it("ignores an indented opening fence", () => {
    expect(parsePageFields("  ---\norigin: raw/notes/V/a.md\n---\n")).toEqual({
      origin: undefined,
      sources: [],
    });
  });

  it("ignores sources-like lines in a body without frontmatter", () => {
    expect(
      parsePageFields('# Not frontmatter\nsources:\n  - "[[A]]"\n'),
    ).toEqual({ origin: undefined, sources: [] });
  });

  it("ignores list items that appear before any key", () => {
    const fields = parsePageFields(
      '---\n  - "[[A]]"\nsources:\n  - "[[B]]"\n---\n',
    );

    expect(fields.sources).toEqual(["[[B]]"]);
  });

  it("accepts an indented closing fence", () => {
    expect(
      parsePageFields("---\norigin: raw/notes/V/a.md\n  ---\n"),
    ).toMatchObject({ origin: "raw/notes/V/a.md" });
  });

  it("parses an origin written without a space after the colon", () => {
    expect(parsePageFields("---\norigin:raw/notes/V/a.md\n---\n")).toEqual({
      origin: "raw/notes/V/a.md",
      sources: [],
    });
  });

  it("keeps a colon inside a sources entry", () => {
    const fields = parsePageFields(
      '---\nsources:\n  - "url: https://example.com"\n---\n',
    );

    expect(fields.sources).toEqual(["url: https://example.com"]);
  });

  it("skips prose lines between frontmatter keys", () => {
    expect(
      parsePageFields(
        "---\ntitle: T\njust prose\norigin: raw/notes/V/a.md\n---\n",
      ),
    ).toEqual({ origin: "raw/notes/V/a.md", sources: [] });
  });

  it("leaves origin unset for an empty value", () => {
    expect(parsePageFields("---\norigin:\n---\n")).toEqual({
      origin: undefined,
      sources: [],
    });
  });

  it("trims trailing whitespace from the origin value", () => {
    expect(
      parsePageFields("---\norigin: raw/notes/V/a.md \n---\n"),
    ).toMatchObject({ origin: "raw/notes/V/a.md" });
  });

  it("skips prose lines inside the sources list", () => {
    const fields = parsePageFields(
      '---\nsources:\nprose line\n  - "[[A]]"\n---\n',
    );

    expect(fields.sources).toEqual(["[[A]]"]);
  });

  it("does not treat a mid-line dash as a list item", () => {
    const fields = parsePageFields(
      '---\nsources:\nchat - asides\n  - "[[A]]"\n---\n',
    );

    expect(fields.sources).toEqual(["[[A]]"]);
  });

  it("accepts extra spaces after the list dash", () => {
    const fields = parsePageFields('---\nsources:\n  -   "[[A]]"\n---\n');

    expect(fields.sources).toEqual(["[[A]]"]);
  });

  it("trims trailing whitespace from a sources entry", () => {
    const fields = parsePageFields(
      '---\nsources:\n  - "notes/V/a.md"  \n---\n',
    );

    expect(fields.sources).toEqual(["notes/V/a.md"]);
  });
});

describe("wikilink classification", () => {
  it("classifies bracketed entries as wikilinks", () => {
    expect(isWikilinkEntry("[[Temp research]]")).toBe(true);
    expect(isWikilinkEntry("notes/V/a.md")).toBe(false);
  });

  it("rejects an entry with only an opening or closing bracket", () => {
    expect(isWikilinkEntry("[[partial")).toBe(false);
    expect(isWikilinkEntry("partial]]")).toBe(false);
  });

  it("keeps only the page name of an aliased or anchored link", () => {
    expect(wikilinkTarget("[[vector-database|my db]]")).toBe("vector-database");
    expect(wikilinkTarget("[[RAG#Why]]")).toBe("RAG");
    expect(wikilinkTarget("[[Temp research]]")).toBe("Temp research");
  });

  it("trims whitespace around the page name", () => {
    expect(wikilinkTarget("[[ vector-db ]]")).toBe("vector-db");
  });
});

describe("normalizeRawPath", () => {
  it("strips only a leading raw/ prefix", () => {
    expect(normalizeRawPath("raw/notes/V/a.md")).toBe("notes/V/a.md");
    expect(normalizeRawPath("notes/raw/a.md")).toBe("notes/raw/a.md");
  });
});

describe("buildPageIndex", () => {
  it("maps page names to their wiki-relative paths", () => {
    expect(
      buildPageIndex(["index.md", "sources/temp research.md", "img.png"]),
    ).toEqual(
      new Map([
        ["index", "index.md"],
        ["temp research", "sources/temp research.md"],
      ]),
    );
  });
});

describe("listWikiPages", () => {
  it("lists markdown pages recursively, skipping AGENTS.md, sorted", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-pages-"));

    tempDirs.push(root);

    await mkdir(join(root, "concepts"), { recursive: true });
    await mkdir(join(root, "sources"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Index");
    await writeFile(join(root, "overview.md"), "# Overview");
    await writeFile(join(root, "concepts", "b.md"), "b");
    await writeFile(join(root, "concepts", "a.md"), "a");
    await writeFile(join(root, "sources", "s.md"), "s");
    await writeFile(join(root, "AGENTS.md"), "# Contract");
    await writeFile(join(root, "concepts", "notes.txt"), "not markdown");

    expect(await listWikiPages(root)).toEqual([
      "concepts/a.md",
      "concepts/b.md",
      "index.md",
      "overview.md",
      "sources/s.md",
    ]);
  });

  it("returns an empty list for an empty wiki directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-pages-"));

    tempDirs.push(root);

    await mkdir(root, { recursive: true });

    expect(await listWikiPages(root)).toEqual([]);
  });

  it("sorts upper before lower case regardless of write order", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-pages-"));

    tempDirs.push(root);

    await writeFile(join(root, "B.md"), "b");
    await writeFile(join(root, "a.md"), "a");

    expect(await listWikiPages(root)).toEqual(["B.md", "a.md"]);
  });

  it("rejects a wiki directory path that is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-pages-"));

    tempDirs.push(root);

    const file = join(root, "page.md");

    await writeFile(file, "x");

    await expect(listWikiPages(file)).rejects.toThrow(
      `wiki directory is not a directory: ${file}`,
    );
  });

  it("fails naming the directory when the wiki root is missing", async () => {
    await expect(listWikiPages("/no/such/wiki")).rejects.toThrow(
      "wiki directory does not exist: /no/such/wiki",
    );
  });
});

describe("readPageFields", () => {
  it("returns empty fields for a missing file", async () => {
    await expect(readPageFields("/no/such/page.md")).resolves.toEqual({
      origin: undefined,
      sources: [],
    });
  });

  it("reads the fields of an existing page", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-pages-"));

    tempDirs.push(root);

    const page = join(root, "page.md");

    await writeFile(page, "---\norigin: raw/notes/V/a.md\n---\n");

    await expect(readPageFields(page)).resolves.toMatchObject({
      origin: "raw/notes/V/a.md",
    });
  });
});
