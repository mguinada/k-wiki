import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkWikiProvenance } from "../../src/wiki/provenance.ts";

/** Unit tests for the dead-provenance core (src/wiki/provenance.ts,
 *  issue #65): the wikilink/path/origin liveness rules, exercised
 *  directly at the module's mirrored path (issue #260). The
 *  check-provenance CLI rendering stays at
 *  tests/scripts/check-provenance.test.ts. */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly wikiDir: string;
  readonly rawDir: string;
}

/** A wiki tree at `<root>/wiki` and a raw projection at `<root>/raw`. */
async function makeFixture(
  wikiFiles: Record<string, string>,
  rawFiles: Record<string, string> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(wikiFiles)) {
    await mkdir(join(root, "wiki", dirname(file)), { recursive: true });
    await writeFile(join(root, "wiki", file), content);
  }

  await mkdir(join(root, "raw"), { recursive: true });

  for (const [file, content] of Object.entries(rawFiles)) {
    await mkdir(join(root, "raw", dirname(file)), { recursive: true });
    await writeFile(join(root, "raw", file), content);
  }

  return { wikiDir: join(root, "wiki"), rawDir: join(root, "raw") };
}

describe("checkWikiProvenance", () => {
  it("rejects a raw directory that does not exist", async () => {
    const { wikiDir } = await makeFixture({ "index.md": "# Index" });
    const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

    tempDirs.push(root);

    await expect(
      checkWikiProvenance(wikiDir, join(root, "missing")),
    ).rejects.toThrow(`raw directory does not exist: ${join(root, "missing")}`);
  });

  it("rejects a raw path that is a file, not a directory", async () => {
    const { wikiDir } = await makeFixture({ "index.md": "# Index" });
    const fileAsRaw = join(dirname(wikiDir), "raw", "manifest.json");

    await writeFile(fileAsRaw, "{}\n");

    await expect(checkWikiProvenance(wikiDir, fileAsRaw)).rejects.toThrow(
      `raw directory is not a directory: ${fileAsRaw}`,
    );
  });

  it("passes when every sources link resolves and every origin exists", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
        "concepts/cites.md":
          '---\ntitle: Cites\nsources:\n  - "[[Temp research]]"\n---\nbody',
        "index.md": "# Index",
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
  });

  it("counts the fixture's sources, origins, and pages", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
        "concepts/cites.md":
          '---\ntitle: Cites\nsources:\n  - "[[Temp research]]"\n---\nbody',
        "index.md": "# Index",
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(`${report.sources}/${report.origins}/${report.pages}`).toBe("1/1/3");
  });

  it("reports a sources link whose page is missing", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/cites.md":
        '---\ntitle: Cites\nsources:\n  - "[[Temp research]]"\n---\nbody',
      "index.md": "# Index",
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/cites.md -> [[Temp research]] (missing source page)",
    ]);
  });

  it("reports a sources link whose page exists but is not type: source", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/cites.md":
        '---\ntitle: Cites\nsources:\n  - "[[index]]"\n---\nbody',
      "index.md": "---\ntitle: Index\ntype: topic\n---\nbody",
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/cites.md -> [[index]] (does not cite a type: source page)",
    ]);
  });

  it("passes an anchored citation whose target hub carries the chapter heading", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nprose\n\n## 04. Rate Limiter\n",
        "concepts/cites.md":
          '---\ntitle: Cites\nsources:\n  - "[[Temp research#04. Rate Limiter]]"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
  });

  it("reports an anchored citation whose target hub lacks the chapter heading, with page and line", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nprose without headings\n",
        "concepts/cites.md":
          '---\ntitle: Cites\nsources:\n  - "[[Temp research]]"\n  - "[[Temp research#04. Rate Limiter]]"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      'wiki/concepts/cites.md:5 -> [[Temp research#04. Rate Limiter]] (target has no heading "04. Rate Limiter")',
    ]);
  });

  it("matches the anchored heading byte-for-byte for names with double spaces", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nprose\n\n## 27. Digital Wallet\n",
        "concepts/cites.md":
          '---\ntitle: Cites\nsources:\n  - "[[Temp research#27.  Digital Wallet]]"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      'wiki/concepts/cites.md:4 -> [[Temp research#27.  Digital Wallet]] (target has no heading "27.  Digital Wallet")',
    ]);
  });

  it("reports a sources path that no raw file backs", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "concepts/cites.md":
          '---\nsources:\n  - "notes/V/Scratch/temp.md"\n---\nbody',
      },
      { "notes/V/Scratch/other.md": "other body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/cites.md -> sources notes/V/Scratch/temp.md (missing under raw/)",
    ]);
  });

  it("reports a path-form entry whose path a hub's origin covers", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/temp.md":
          "---\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
        "concepts/cites.md":
          '---\nsources:\n  - "notes/V/Scratch/temp.md"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/cites.md -> sources notes/V/Scratch/temp.md (path has hub [[temp]] — use the wikilink)",
    ]);
  });

  it("reports a citing page's path-form entry but exempts the no-origin hub's own cite", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/sdn.md":
          '---\ntype: source\nsources:\n  - "notes/Books/SDN/04. Rate Limiter/Readme.md"\n---\nbody',
        "concepts/rate-limiting.md":
          '---\nsources:\n  - "notes/Books/SDN/04. Rate Limiter/Readme.md"\n---\nbody',
      },
      { "notes/Books/SDN/04. Rate Limiter/Readme.md": "chapter body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/rate-limiting.md -> sources notes/Books/SDN/04. Rate Limiter/Readme.md (path has hub [[sdn#04. Rate Limiter]] — use the wikilink)",
    ]);
  });

  it("reports a chapter path covered only by a migrated hub's self-wikilink", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/sdn.md": [
          "---",
          "type: source",
          "origin: raw/notes/Books/SDN/Readme.md",
          "sources:",
          '  - "[[sdn]]"',
          '  - "[[sdn|04. Rate Limiter]]"',
          "---",
          "body",
        ].join("\n"),
        "concepts/rate-limiting.md":
          '---\nsources:\n  - "notes/Books/SDN/04. Rate Limiter/Readme.md"\n---\nbody',
      },
      {
        "notes/Books/SDN/Readme.md": "book body",
        "notes/Books/SDN/04. Rate Limiter/Readme.md": "chapter body",
      },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/rate-limiting.md -> sources notes/Books/SDN/04. Rate Limiter/Readme.md (path has hub [[sdn#04. Rate Limiter]] — use the wikilink)",
    ]);
  });

  it("reports a hub's own path-form cite of its covered origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/temp.md":
          '---\ntype: source\norigin: raw/notes/V/Scratch/temp.md\nsources:\n  - "notes/V/Scratch/temp.md"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/temp.md -> sources notes/V/Scratch/temp.md (path has hub [[temp]] — use the wikilink)",
    ]);
  });

  it("resolves a sources path written with the raw/ prefix", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "concepts/cites.md":
          '---\nsources:\n  - "raw/notes/V/Scratch/temp.md"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    expect((await checkWikiProvenance(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("reports a dangling origin that no raw file backs", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
      },
      { "notes/V/Scratch/other.md": "other body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/Temp research.md -> origin raw/notes/V/Scratch/temp.md (missing under raw/)",
    ]);
  });

  it("resolves an origin written without the raw/ prefix", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/prefixless.md": "---\norigin: notes/V/a.md\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    expect((await checkWikiProvenance(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("reports one line per problem, pages in sorted order", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "a-page.md": '---\nsources:\n  - "[[Missing one]]"\n---\n',
      "b-page.md": '---\nsources:\n  - "[[Missing two]]"\n---\n',
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/a-page.md -> [[Missing one]] (missing source page)",
      "wiki/b-page.md -> [[Missing two]] (missing source page)",
    ]);
  });

  it("does not read sources or origins from AGENTS.md", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "AGENTS.md":
        '---\nsources:\n  - "[[Missing]]"\norigin: raw/notes/V/gone.md\n---\n',
      "index.md": "# Index",
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
  });

  it("does not count AGENTS.md as a page", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "AGENTS.md":
        '---\nsources:\n  - "[[Missing]]"\norigin: raw/notes/V/gone.md\n---\n',
      "index.md": "# Index",
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.pages).toBe(1);
  });

  it("counts type: source pages that lack origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/has.md":
          "---\ntype: source\norigin: raw/notes/V/a.md\n---\nbody",
        "sources/lacks.md": "---\ntype: source\n---\nbody",
        "concepts/plain.md": "---\ntitle: Plain\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(`${report.missingOrigins}: ${report.problems.length}`).toBe("1: 0");
  });

  it("reports zero missing origins when every source page carries one", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/has.md":
          "---\ntype: source\norigin: raw/notes/V/a.md\n---\nbody",
        "concepts/plain.md": "---\ntitle: Plain\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    expect((await checkWikiProvenance(wikiDir, rawDir)).missingOrigins).toBe(0);
  });

  it("does not count a non-source page that lacks origin", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/plain.md": "---\ntitle: Plain\n---\nbody",
    });

    expect((await checkWikiProvenance(wikiDir, rawDir)).missingOrigins).toBe(0);
  });

  it("passes on an empty wiki", async () => {
    const { wikiDir, rawDir } = await makeFixture({ "index.md": "# Index" });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
  });

  it("counts no sources or origins on an empty wiki", async () => {
    const { wikiDir, rawDir } = await makeFixture({ "index.md": "# Index" });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(`${report.sources}/${report.origins}`).toBe("0/0");
  });

  it("rejects a wiki directory that does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

    tempDirs.push(root);

    await expect(
      checkWikiProvenance(join(root, "missing"), join(root, "raw")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });
});
