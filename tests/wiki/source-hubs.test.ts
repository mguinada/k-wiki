import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  citationAlias,
  citationAnchor,
  citationChapter,
  isUnmigratableSelfCitation,
  loadSourceHubIndex,
  type SourceHubIndex,
  wikilinkFor,
} from "../../src/wiki/source-hubs.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A wiki tree at `<root>/wiki` with the given pages. */
async function makeWiki(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-hubs-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(pages)) {
    await mkdir(join(root, "wiki", dirname(file)), { recursive: true });
    await writeFile(join(root, "wiki", file), content);
  }

  return join(root, "wiki");
}

/** Frontmatter block builder: scalars plus one `sources` list. */
function page(
  fields: Record<string, string | undefined>,
  sources: readonly string[] = [],
): string {
  const lines = ["---"];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (sources.length > 0) {
    lines.push("sources:");

    for (const entry of sources) {
      lines.push(`  - "${entry}"`);
    }
  }

  lines.push("---", "", "body", "");

  return lines.join("\n");
}

describe("citationAlias", () => {
  it("derives the alias from the cited path's parent directory name", () => {
    expect(citationAlias("notes/Books/SDN/04. Rate Limiter/Readme.md")).toBe(
      "04. Rate Limiter",
    );
  });

  it("returns undefined for a path without a directory part", () => {
    expect(citationAlias("note.md")).toBeUndefined();
  });
});

describe("citationAnchor", () => {
  it("reads no chapter from a plain self-citation without anchor or alias", () => {
    expect(citationChapter("[[hub]]")).toBeUndefined();
  });

  it("reads no chapter from a whitespace-only alias", () => {
    expect(citationChapter("[[hub| ]]")).toBeUndefined();
  });

  it("reads the anchor of an anchored citation", () => {
    expect(citationAnchor("[[sdn#04. Rate Limiter]]")).toBe("04. Rate Limiter");
  });

  it("keeps a multi-level anchor as written", () => {
    expect(citationAnchor("[[sdn#Part One#Details]]")).toBe("Part One#Details");
  });

  it("returns undefined without an anchor", () => {
    expect(citationAnchor("[[sdn]]")).toBeUndefined();
  });

  it("returns undefined for a block reference", () => {
    expect(citationAnchor("[[sdn#^block-id]]")).toBeUndefined();
  });
});

describe("citationChapter", () => {
  it("reads the chapter from an anchored wikilink's # segment", () => {
    expect(citationChapter("[[sdn#04. Rate Limiter]]")).toBe(
      "04. Rate Limiter",
    );
  });

  it("reads the chapter from a legacy aliased wikilink's pipe segment", () => {
    expect(citationChapter("[[sdn|04. Rate Limiter]]")).toBe(
      "04. Rate Limiter",
    );
  });

  it("prefers the anchor when a wikilink carries both anchor and alias", () => {
    expect(citationChapter("[[sdn#04. Rate Limiter|display]]")).toBe(
      "04. Rate Limiter",
    );
  });

  it("returns undefined for a plain wikilink", () => {
    expect(citationChapter("[[sdn]]")).toBeUndefined();
  });
});

describe("loadSourceHubIndex", () => {
  it("maps a source page's normalized origin to its page name", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page(
        { title: "Hub", type: "source", origin: "raw/notes/V/note.md" },
        ["notes/V/note.md"],
      ),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.byOrigin.get("notes/V/note.md")).toBe("hub");
  });

  it("maps a raw path cited in a hub's own sources to that hub's name", async () => {
    const wikiDir = await makeWiki({
      "sources/sdn.md": page({ title: "Sdn", type: "source" }, [
        "notes/Books/SDN/04. Rate Limiter/Readme.md",
      ]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(
      index.byCitation.get("notes/Books/SDN/04. Rate Limiter/Readme.md"),
    ).toBe("sdn");
  });

  it("keeps non-source pages out of the origin map", async () => {
    const wikiDir = await makeWiki({
      "concepts/cite.md": page(
        { title: "Cite", type: "concept", origin: "raw/notes/V/note.md" },
        [],
      ),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.byOrigin.has("notes/V/note.md")).toBe(false);
  });

  it("marks a raw path covered by two hubs' origins as ambiguous", async () => {
    const wikiDir = await makeWiki({
      "sources/one.md": page(
        { title: "One", type: "source", origin: "raw/notes/V/note.md" },
        [],
      ),
      "sources/two.md": page(
        { title: "Two", type: "source", origin: "raw/notes/V/note.md" },
        [],
      ),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.byOrigin.has("notes/V/note.md")).toBe(false);
  });

  it("does not map an ambiguous raw path by origin", async () => {
    const wikiDir = await makeWiki({
      "sources/one.md": page(
        { title: "One", type: "source", origin: "raw/notes/V/note.md" },
        [],
      ),
      "sources/two.md": page(
        { title: "Two", type: "source", origin: "raw/notes/V/note.md" },
        [],
      ),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.ambiguous.has("notes/V/note.md")).toBe(true);
  });

  it("marks a raw path cited by two hubs as ambiguous", async () => {
    const wikiDir = await makeWiki({
      "sources/one.md": page({ title: "One", type: "source" }, [
        "notes/V/chapter.md",
      ]),
      "sources/two.md": page({ title: "Two", type: "source" }, [
        "notes/V/chapter.md",
      ]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.byCitation.has("notes/V/chapter.md")).toBe(false);
  });

  it("does not map an ambiguous raw path by citation", async () => {
    const wikiDir = await makeWiki({
      "sources/one.md": page({ title: "One", type: "source" }, [
        "notes/V/chapter.md",
      ]),
      "sources/two.md": page({ title: "Two", type: "source" }, [
        "notes/V/chapter.md",
      ]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.ambiguous.has("notes/V/chapter.md")).toBe(true);
  });

  it("exposes every page's type by page name", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, []),
      "concepts/cite.md": page({ title: "Cite", type: "concept" }, ["[[hub]]"]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.fields.get("hub")?.type).toBe("source");
  });

  it("exposes a concept page's type by page name", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, []),
      "concepts/cite.md": page({ title: "Cite", type: "concept" }, ["[[hub]]"]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.fields.get("cite")?.type).toBe("concept");
  });

  it("ignores wikilink entries when building the citation map", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, ["[[other]]"]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.byCitation.has("[[other]]")).toBe(false);
  });

  it("throws when the wiki directory does not exist", async () => {
    await expect(loadSourceHubIndex("/nonexistent-wiki")).rejects.toThrow(
      "wiki directory does not exist",
    );
  });
});

describe("citationAlias edge segments", () => {
  it("returns undefined when the parent directory segment is empty", () => {
    expect(citationAlias("/note.md")).toBeUndefined();
  });
});

describe("wikilinkFor", () => {
  it("returns the plain hub link when a covered cited path has no directory part", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, ["note.md"]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(wikilinkFor("note.md", index)).toEqual({ wikilink: "[[hub]]" });
  });

  it("reports the reason when no hub covers the path", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, ["note.md"]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(wikilinkFor("notes/other.md", index)).toEqual({
      reason: "no hub covers this path",
    });
  });

  it("emits the anchored wikilink for a chapter path a hub's own sources cite", async () => {
    const wikiDir = await makeWiki({
      "sources/sdn.md": page({ title: "Sdn", type: "source" }, [
        "notes/Books/SDN/04. Rate Limiter/Readme.md",
      ]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(
      wikilinkFor("notes/Books/SDN/04. Rate Limiter/Readme.md", index),
    ).toEqual({ wikilink: "[[sdn#04. Rate Limiter]]" });
  });
});

describe("loadSourceHubIndex duplicate self-citation", () => {
  it("does not mark a path ambiguous when one hub cites it twice", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, [
        "notes/V/x.md",
        "notes/V/x.md",
      ]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(
      `${index.byCitation.get("notes/V/x.md")}:${index.ambiguous.has("notes/V/x.md")}`,
    ).toBe("hub:false");
  });
});

describe("derived citation coverage (migrated multi-part hubs)", () => {
  async function migratedWiki(
    pages: Record<string, string>,
  ): Promise<SourceHubIndex> {
    return loadSourceHubIndex(await makeWiki(pages));
  }

  const MIGRATED_SDN = {
    "sources/sdn.md": page(
      { title: "Sdn", type: "source", origin: "raw/notes/Books/SDN/Readme.md" },
      ["[[sdn]]", "[[sdn|04. Rate Limiter]]"],
    ),
  } as const;
  const CHAPTER = "notes/Books/SDN/04. Rate Limiter/Readme.md";

  it("records one rule per aliased self-citation of a hub with an origin", async () => {
    const index = await migratedWiki(MIGRATED_SDN);

    expect(index.selfCitations).toEqual([
      { hub: "sdn", originDir: "notes/Books/SDN", alias: "04. Rate Limiter" },
    ]);
  });

  it("maps a chapter path under the hub origin to the anchored self-wikilink", async () => {
    const index = await migratedWiki(MIGRATED_SDN);

    expect(wikilinkFor(CHAPTER, index)).toEqual({
      wikilink: "[[sdn#04. Rate Limiter]]",
    });
  });

  it("records the rule for an anchored self-citation too", async () => {
    const index = await migratedWiki({
      "sources/sdn.md": page(
        {
          title: "Sdn",
          type: "source",
          origin: "raw/notes/Books/SDN/Readme.md",
        },
        ["[[sdn#04. Rate Limiter]]"],
      ),
    });

    expect(index.selfCitations).toEqual([
      { hub: "sdn", originDir: "notes/Books/SDN", alias: "04. Rate Limiter" },
    ]);
  });

  it("leaves a sibling chapter directory uncovered when no self-citation names it", async () => {
    const index = await migratedWiki(MIGRATED_SDN);

    expect(wikilinkFor("notes/Books/SDN/05. Proxy/Readme.md", index)).toEqual({
      reason: "no hub covers this path",
    });
  });

  it("leaves a deeper path inside a covered chapter directory uncovered", async () => {
    const index = await migratedWiki(MIGRATED_SDN);

    expect(
      wikilinkFor("notes/Books/SDN/04. Rate Limiter/sub/Readme.md", index),
    ).toEqual({ reason: "no hub covers this path" });
  });

  it("reports ambiguity when two hubs' self-citations cover the same chapter path", async () => {
    const index = await migratedWiki({
      "sources/one.md": page(
        { title: "One", type: "source", origin: "raw/notes/V/one/Readme.md" },
        ["[[one|Chap]]"],
      ),
      "sources/two.md": page(
        { title: "Two", type: "source", origin: "raw/notes/V/one/Toc.md" },
        ["[[two|Chap]]"],
      ),
    });

    expect(wikilinkFor("notes/V/one/Chap/Readme.md", index)).toEqual({
      reason: "covered by more than one hub",
    });
  });

  it("records no rule for a hub's wikilink to another page", async () => {
    const index = await migratedWiki({
      "sources/hub.md": page(
        { title: "Hub", type: "source", origin: "raw/notes/V/Readme.md" },
        ["[[other|Chap]]"],
      ),
    });

    expect(index.selfCitations).toEqual([]);
  });

  it("records no rule for a self-citation in a hub without an origin", async () => {
    const index = await migratedWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, [
        "[[hub|Chap]]",
      ]),
    });

    expect(index.selfCitations).toEqual([]);
  });

  it("dedupes identical rules from a repeated aliased self-citation", async () => {
    const index = await migratedWiki({
      "sources/hub.md": page(
        { title: "Hub", type: "source", origin: "raw/notes/V/Readme.md" },
        ["[[hub|Chap]]", "[[hub|Chap]]"],
      ),
    });

    expect(wikilinkFor("notes/V/Chap/Readme.md", index)).toEqual({
      wikilink: "[[hub#Chap]]",
    });
  });
});

describe("isUnmigratableSelfCitation", () => {
  const UNANCHORED = {
    "sources/sdn.md": page({ title: "Sdn", type: "source" }, [
      "notes/Books/SDN/04. Rate Limiter/Readme.md",
    ]),
    "concepts/cite.md": page({ title: "Cite", type: "concept" }, [
      "notes/Books/SDN/04. Rate Limiter/Readme.md",
    ]),
  } as const;
  const CHAPTER = "notes/Books/SDN/04. Rate Limiter/Readme.md";

  it("flags a no-origin hub's own aliased chapter citation", async () => {
    const index = await loadSourceHubIndex(await makeWiki(UNANCHORED));

    expect(isUnmigratableSelfCitation("sdn", CHAPTER, index)).toBe(true);
  });

  it("does not flag the same entry on a citing concept page", async () => {
    const index = await loadSourceHubIndex(await makeWiki(UNANCHORED));

    expect(isUnmigratableSelfCitation("cite", CHAPTER, index)).toBe(false);
  });

  it("does not flag a self-cited path that maps to a bare wikilink", async () => {
    const index = await loadSourceHubIndex(
      await makeWiki({
        "sources/sdn.md": page({ title: "Sdn", type: "source" }, ["Readme.md"]),
      }),
    );

    expect(isUnmigratableSelfCitation("sdn", "Readme.md", index)).toBe(false);
  });

  it("does not flag a hub's own citation when the hub has an origin", async () => {
    const index = await loadSourceHubIndex(
      await makeWiki({
        "sources/sdn.md": page(
          {
            title: "Sdn",
            type: "source",
            origin: "raw/notes/Books/SDN/Readme.md",
          },
          ["notes/Books/SDN/04. Rate Limiter/Readme.md"],
        ),
      }),
    );

    expect(isUnmigratableSelfCitation("sdn", CHAPTER, index)).toBe(false);
  });

  it("does not flag a chapter covered by another hub's origin", async () => {
    const index = await loadSourceHubIndex(
      await makeWiki({
        "sources/sdn.md": page({ title: "Sdn", type: "source" }, [
          "notes/Books/SDN/Readme.md",
        ]),
        "sources/other.md": page(
          {
            title: "Other",
            type: "source",
            origin: "raw/notes/Books/SDN/Readme.md",
          },
          [],
        ),
      }),
    );

    expect(
      isUnmigratableSelfCitation("sdn", "notes/Books/SDN/Readme.md", index),
    ).toBe(false);
  });

  it("does not flag an unwikilinkable raw path", async () => {
    const index = await loadSourceHubIndex(await makeWiki(UNANCHORED));

    expect(isUnmigratableSelfCitation("sdn", "notes/uncovered.md", index)).toBe(
      false,
    );
  });
});
