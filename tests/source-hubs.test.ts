import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  citationAlias,
  loadSourceHubIndex,
  wikilinkFor,
} from "../src/wiki/source-hubs.ts";

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
    expect(index.ambiguous.has("notes/V/chapter.md")).toBe(true);
  });

  it("exposes every page's type by page name", async () => {
    const wikiDir = await makeWiki({
      "sources/hub.md": page({ title: "Hub", type: "source" }, []),
      "concepts/cite.md": page({ title: "Cite", type: "concept" }, ["[[hub]]"]),
    });

    const index = await loadSourceHubIndex(wikiDir);

    expect(index.fields.get("hub")?.type).toBe("source");
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
