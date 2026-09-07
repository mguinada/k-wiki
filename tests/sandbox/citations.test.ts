import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkCitationWall } from "../../src/sandbox/citations.ts";

/**
 * The one-way citation wall core (issue #339, decision 4 of #289):
 * sandbox notes may read the main wiki, the main wiki must never
 * depend on sandbox notes — the reaper would break the links, and
 * citation laundering would give unsourced agent notes provenance
 * they did not earn. Every violation class is first-class here:
 * main→sandbox body links and embeds, sandbox→sandbox body links,
 * `sources` edges touching the sandbox in either direction,
 * cross-wiki links from sandbox pages, and `via: agent` stamps
 * outside the namespace.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A main wiki page with §9-ish frontmatter and the given body. */
function mainPage(body: string, extra: readonly string[] = []): string {
  return [
    "---",
    'title: "P"',
    "type: concept",
    "created: 2026-09-06",
    "updated: 2026-09-06",
    "tags:",
    "  - t",
    ...extra,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** A sandbox page carrying the pipeline's stamps. */
function sandboxPage(body: string, extra: readonly string[] = []): string {
  return [
    "---",
    "via: agent",
    "expires: 2099-01-01",
    ...extra,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** A wiki tree at `<root>/wiki` holding the given files. */
async function makeWiki(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-wall-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, "wiki", ...file.split("/").slice(0, -1)), {
      recursive: true,
    });
    await writeFile(join(root, "wiki", file), content);
  }

  return join(root, "wiki");
}

describe("checkCitationWall", () => {
  it("passes a clean wiki without a sandbox namespace", async () => {
    const wikiDir = await makeWiki({
      "index.md": mainPage("[[note-a]]"),
      "note-a.md": mainPage("Body."),
    });

    await expect(checkCitationWall(wikiDir)).resolves.toEqual({
      problems: [],
      offendingPaths: [],
      pages: 2,
      sandboxPages: 0,
    });
  });

  it("allows sandbox pages to link main wiki pages (reading stays legal)", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body."),
      "sandbox/proposal.md": sandboxPage("Discusses [[note-a]]."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([]);
  });

  it("flags a main page body link into the sandbox", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("See [[proposal]]."),
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/note-a.md:10 -> [[proposal]] (main pages must not link or embed sandbox pages)",
    ]);
    expect(report.offendingPaths).toEqual(["note-a.md"]);
  });

  it("flags a main page embed of a sandbox page (embeds are links)", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Prefix ![[proposal]] suffix."),
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/note-a.md:10 -> [[proposal]] (main pages must not link or embed sandbox pages)",
    ]);
  });

  it("flags a slashed [[sandbox/<page>]] body link from a main page", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("See [[sandbox/proposal]]."),
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/note-a.md:10 -> [[sandbox/proposal]] (main pages must not link or embed sandbox pages)",
    ]);
  });

  it("flags a sandbox page linking a sandbox sibling", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body."),
      "sandbox/proposal.md": sandboxPage("Builds on [[draft-two]]."),
      "sandbox/draft-two.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/sandbox/proposal.md:6 -> [[draft-two]] (sandbox pages cite main wiki content only, never sandbox peers)",
    ]);
    expect(report.offendingPaths).toEqual(["sandbox/proposal.md"]);
  });

  it("flags a main page sources entry naming a sandbox page", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body.", ["sources:", '  - "[[proposal]]"']),
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      'wiki/note-a.md -> sources entry "[[proposal]]" (sources edges never touch the sandbox)',
    ]);
    expect(report.offendingPaths).toEqual(["note-a.md"]);
  });

  it("flags a sandbox page sources entry naming a main page (the other direction)", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body."),
      "sandbox/proposal.md": sandboxPage("Body.", [
        "sources:",
        '  - "[[note-a]]"',
      ]),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      'wiki/sandbox/proposal.md -> sources entry "[[note-a]]" (sources edges never touch the sandbox)',
    ]);
  });

  it("ignores raw-path sources entries (no wikilink edge to a wiki page)", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body.", ["sources:", "  - raw/notes/x.md"]),
      "sandbox/proposal.md": sandboxPage("Body.", [
        "sources:",
        "  - raw/notes/x.md",
      ]),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([]);
  });

  it("flags a via: agent stamp outside the sandbox", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": [
        "---",
        'title: "P"',
        "type: concept",
        "via: agent",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/note-a.md:4 -> via: agent (agent-stamped pages live only under wiki/sandbox/)",
    ]);
    expect(report.offendingPaths).toEqual(["note-a.md"]);
  });

  it("allows the via: agent stamp inside the sandbox", async () => {
    const wikiDir = await makeWiki({
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([]);
    expect(report.sandboxPages).toBe(1);
  });

  it("flags a cross-wiki slashed link from a sandbox page", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body."),
      "sandbox/proposal.md": sandboxPage("See [[engineering/note-a]]."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/sandbox/proposal.md:6 -> [[engineering/note-a]] (sandbox pages must not use cross-wiki links)",
    ]);
  });

  it("attributes a sandbox page's slashed same-namespace peer link to the sandbox-peers rule", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("Body."),
      "sandbox/proposal.md": sandboxPage("See [[sandbox/draft]]."),
      "sandbox/draft.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([
      "wiki/sandbox/proposal.md:6 -> [[sandbox/draft]] (sandbox pages cite main wiki content only, never sandbox peers)",
    ]);
  });

  it("skips wikilinks inside fenced code blocks", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("```\n[[proposal]]\n```"),
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([]);
  });

  it("does not judge link resolution (a sandbox link to a missing main page is check-links' business)", async () => {
    const wikiDir = await makeWiki({
      "sandbox/proposal.md": sandboxPage("Points at [[renamed-away]]."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.problems).toEqual([]);
  });

  it("reports every offending path once, sorted, when a page carries several violations", async () => {
    const wikiDir = await makeWiki({
      "note-a.md": mainPage("See [[proposal]] and [[sandbox/draft]].", [
        "sources:",
        '  - "[[draft]]"',
      ]),
      "sandbox/proposal.md": sandboxPage("Body."),
      "sandbox/draft.md": sandboxPage("Body."),
    });

    const report = await checkCitationWall(wikiDir);

    expect(report.offendingPaths).toEqual(["note-a.md"]);
    expect(report.problems).toHaveLength(3);
  });
});
