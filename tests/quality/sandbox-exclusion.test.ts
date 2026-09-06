import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectData } from "../../src/dashboard/collect.ts";
import { runPublishStage } from "../../src/sync/publish.ts";
import { listablePages } from "../../src/wiki/browse.ts";
import { listWikiPages } from "../../src/wiki/pages.ts";
import { loadSourceHubIndex } from "../../src/wiki/source-hubs.ts";

/**
 * The sandbox-exclusion quality guard (issue #338): sandbox notes
 * (`wiki/sandbox/**`) are disposable agent scratch — they must never
 * leak into the listing walkers, the coverage index, the dashboard,
 * or a published mirror. Each surface is exercised against a real
 * wiki tree carrying a sandbox page, so a walker that regresses to
 * counting it fails here, not in production (the quality-guard
 * pattern of the epic #289 design).
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A wiki tree with one concept page and one sandbox page. */
async function makeWikiTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-exclusion-"));

  tempDirs.push(root);

  const wikiDir = join(root, "wiki");

  await mkdir(join(wikiDir, "concepts"), { recursive: true });
  await mkdir(join(wikiDir, "sandbox"), { recursive: true });
  await writeFile(
    join(wikiDir, "concepts", "attention.md"),
    [
      "---",
      'title: "Attention"',
      "type: concept",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "sources:",
      '  - "[[attention-is-all-you-need]]"',
      "---",
      "",
      "Concept body.",
      "",
    ].join("\n"),
  );
  await mkdir(join(wikiDir, "sources"), { recursive: true });
  await writeFile(
    join(wikiDir, "sources", "attention-is-all-you-need.md"),
    [
      "---",
      'title: "Attention is all you need"',
      "type: source",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "origin: raw/notes/Engineering/AI/attention.md",
      "sources:",
      '  - "[[attention-is-all-you-need]]"',
      "---",
      "",
      "Hub body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(wikiDir, "sandbox", "proposal.md"),
    [
      "---",
      "via: agent",
      "expires: 2099-01-01",
      "---",
      "",
      "Sandbox proposal body.",
      "",
    ].join("\n"),
  );

  return root;
}

describe("sandbox exclusion guard (issue #338)", () => {
  it("listWikiPages never returns the sandbox root", async () => {
    const root = await makeWikiTree();

    expect(await listWikiPages(join(root, "wiki"))).toEqual([
      "concepts/attention.md",
      "sources/attention-is-all-you-need.md",
    ]);
  });

  it("listablePages never lists a sandbox page", async () => {
    const root = await makeWikiTree();
    const pages = await listablePages(join(root, "wiki"));

    expect(pages.map((page) => page.slug)).toEqual([
      "attention",
      "attention-is-all-you-need",
    ]);
  });

  it("the source-hub coverage index never counts a sandbox page", async () => {
    const root = await makeWikiTree();
    const index = await loadSourceHubIndex(join(root, "wiki"));

    expect([...index.fields.keys()]).toEqual([
      "attention",
      "attention-is-all-you-need",
    ]);
  });

  it("the dashboard page collection never counts a sandbox page", async () => {
    const root = await makeWikiTree();
    const data = await collectData(root);

    expect(data.pages.map((page) => page.path)).toEqual([
      "concepts/attention.md",
      "sources/attention-is-all-you-need.md",
    ]);
  });

  it("publish never ships a sandbox page to the mirror", async () => {
    const root = await makeWikiTree();
    const mirror = join(root, "mirror");

    await runPublishStage({
      dataRoot: root,
      mirror,
      include: ["wiki/**"],
    });

    await expect(
      readFile(join(mirror, "wiki", "sandbox", "proposal.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(mirror, "wiki", "concepts", "attention.md"), "utf8"),
    ).resolves.toContain("Concept body.");
  });
});
