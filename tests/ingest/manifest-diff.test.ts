import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { porcelainStatus, runGit } from "../../src/data/git.ts";
import type { PreRunState } from "../../src/ingest/guardrails.ts";
import {
  diffManifests,
  explicitSourceDiff,
  pairBodyIdenticalRenames,
  wikiPages,
} from "../../src/ingest/manifest-diff.ts";
import type { Manifest, VaultNotes } from "../../src/sync/manifest.ts";
import { emptyManifest } from "../../src/sync/manifest.ts";
import {
  commitAll,
  entry,
  makeDataRepo,
  manifestWith,
  run,
  type Track,
} from "./harness.ts";

/**
 * manifest-diff unit tests (issue #258, moved with the module from
 * wiki-ingest.test.ts): per-vault diffing, rename pairing, explicit
 * --sources decomposition, and the wikiPages status bucketing.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

const track: Track = (dir) => tempDirs.push(dir);

describe("diffManifests", () => {
  const previous = manifestWith("Engineering", {
    "a.md": entry("a"),
    "b.md": entry("b"),
    "c.md": entry("c"),
  });

  it("marks a path present only in current as added", () => {
    const current = manifestWith("Engineering", {
      "a.md": entry("a"),
      "b.md": entry("b"),
      "c.md": entry("c"),
      "d.md": entry("d"),
    });

    expect(diffManifests(previous, current).vaults[0]).toMatchObject({
      vault: "Engineering",
      added: ["d.md"],
    });
  });

  it("marks a changed hash as changed", () => {
    const current = manifestWith("Engineering", {
      "a.md": entry("a2"),
      "b.md": entry("b"),
      "c.md": entry("c"),
    });

    expect(diffManifests(previous, current).vaults[0]).toMatchObject({
      changed: ["a.md"],
    });
  });

  it("marks a path missing from current as removed", () => {
    const current = manifestWith("Engineering", {
      "a.md": entry("a"),
      "c.md": entry("c"),
    });

    expect(diffManifests(previous, current).vaults[0]).toMatchObject({
      removed: ["b.md"],
    });
  });

  it("reports an empty diff when nothing changed", () => {
    expect(diffManifests(previous, previous).empty).toBe(true);
  });

  it("yields one vault entry when a vault is fully added", () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "a.md": entry("a") }),
      {
        vaults: {
          Engineering: { "a.md": entry("a") },
          Notes: { "n.md": entry("n") },
        },
      },
    );

    expect(diff.vaults).toHaveLength(1);
  });

  it("marks a fully added vault's note as added with no changes or removals", () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "a.md": entry("a") }),
      {
        vaults: {
          Engineering: { "a.md": entry("a") },
          Notes: { "n.md": entry("n") },
        },
      },
    );

    expect(diff.vaults[0]).toMatchObject({
      vault: "Notes",
      added: ["n.md"],
      changed: [],
      removed: [],
    });
  });

  it("treats a vault present only in previous as fully removed", () => {
    const diff = diffManifests(
      { vaults: { Old: { "x.md": entry("x") } } },
      emptyManifest(),
    );

    expect(diff.vaults[0]).toMatchObject({
      vault: "Old",
      removed: ["x.md"],
    });
  });

  it("sorts the paths within each vault", () => {
    const current = manifestWith("Engineering", {
      "z.md": entry("z"),
      "a.md": entry("a"),
    });

    expect(diffManifests(emptyManifest(), current).vaults[0]?.added).toEqual([
      "a.md",
      "z.md",
    ]);
  });

  it("pairs a remove and add with equal hashes in one vault as renamed", () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "old.md": entry("same") }),
      manifestWith("Engineering", { "new.md": entry("same") }),
    );

    expect(diff.vaults[0]).toMatchObject({
      added: [],
      changed: [],
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });

  it("keeps a remove and add with different hashes as removed and added", () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "old.md": entry("v1") }),
      manifestWith("Engineering", { "old2.md": entry("v2") }),
    );

    expect(diff.vaults[0]).toMatchObject({
      added: ["old2.md"],
      removed: ["old.md"],
      renamed: [],
    });
  });

  it("reports two vault entries when the pair spans different vaults", () => {
    const diff = diffManifests(
      manifestWith("One", { "a.md": entry("same") }),
      manifestWith("Two", { "a.md": entry("same") }),
    );

    expect(diff.vaults).toHaveLength(2);
  });

  it("keeps the removed note of a cross-vault pair as removed", () => {
    const diff = diffManifests(
      manifestWith("One", { "a.md": entry("same") }),
      manifestWith("Two", { "a.md": entry("same") }),
    );

    expect(diff.vaults[0]).toMatchObject({ vault: "One", removed: ["a.md"] });
  });

  it("keeps the added note of a cross-vault pair as added", () => {
    const diff = diffManifests(
      manifestWith("One", { "a.md": entry("same") }),
      manifestWith("Two", { "a.md": entry("same") }),
    );

    expect(diff.vaults[1]).toMatchObject({ vault: "Two", added: ["a.md"] });
  });

  it("pairs two renames of equal-content notes deterministically", () => {
    const diff = diffManifests(
      manifestWith("Engineering", {
        "a.md": entry("same"),
        "b.md": entry("same"),
      }),
      manifestWith("Engineering", {
        "c.md": entry("same"),
        "d.md": entry("same"),
      }),
    );

    expect(diff.vaults[0]?.renamed).toEqual([
      { from: "a.md", to: "c.md" },
      { from: "b.md", to: "d.md" },
    ]);
  });

  it("leaves a renamed note's changed sibling in removed", () => {
    const diff = diffManifests(
      manifestWith("Engineering", {
        "moved.md": entry("same"),
        "edited.md": entry("v1"),
      }),
      manifestWith("Engineering", {
        "moved-2.md": entry("same"),
        "edited.md": entry("v2"),
      }),
    );

    expect(diff.vaults[0]).toMatchObject({
      changed: ["edited.md"],
      removed: [],
      renamed: [{ from: "moved.md", to: "moved-2.md" }],
    });
  });

  it("keeps an added path that pairs with no removal", () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "old.md": entry("same") }),
      manifestWith("Engineering", {
        "new.md": entry("same"),
        "extra.md": entry("extra"),
      }),
    );

    expect(diff.vaults[0]).toEqual({
      vault: "Engineering",
      added: ["extra.md"],
      changed: [],
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });
});

describe("pairBodyIdenticalRenames", () => {
  const OLD_TAGGED = "---\ntags:\n  - ai\n---\n\nBody text.\n";
  const NEW_TAGGED = "---\ntags:\n  - ai\n  - renamed\n---\n\nBody text.\n";
  const EDITED_BODY = "---\ntags:\n  - ai\n---\n\nDifferent body.\n";

  function bodyDiffOf(
    before: Record<string, string>,
    after: Record<string, string>,
  ) {
    return diffManifests(
      manifestWith("Engineering", notesWithContent(before)),
      manifestWith("Engineering", notesWithContent(after)),
    );
  }

  function notesWithContent(notes: Record<string, string>): VaultNotes {
    return Object.fromEntries(
      Object.entries(notes).map(([path, content]) => [path, entry(content)]),
    );
  }

  function readerOf(notes: Record<string, string>) {
    return (vault: string, path: string) => notes[`${vault}/${path}`];
  }

  it("pairs a moved note whose frontmatter changed but body did not as renamed", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf({ "old.md": OLD_TAGGED }, { "new.md": NEW_TAGGED }),
      readerOf({ "Engineering/old.md": OLD_TAGGED }),
      readerOf({ "Engineering/new.md": NEW_TAGGED }),
    );

    expect(diff.vaults[0]).toEqual({
      vault: "Engineering",
      added: [],
      changed: [],
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });

  it("keeps a moved note whose body also changed as removed and added", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf({ "old.md": OLD_TAGGED }, { "new.md": EDITED_BODY }),
      readerOf({ "Engineering/old.md": OLD_TAGGED }),
      readerOf({ "Engineering/new.md": EDITED_BODY }),
    );

    expect(diff.vaults[0]).toMatchObject({
      added: ["new.md"],
      removed: ["old.md"],
      renamed: [],
    });
  });

  it("pairs a note that gained frontmatter during the move", async () => {
    const gained = "---\nwiki: true\n---\nBody text.\n";
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf({ "old.md": "Body text.\n" }, { "new.md": gained }),
      readerOf({ "Engineering/old.md": "Body text.\n" }),
      readerOf({ "Engineering/new.md": gained }),
    );

    expect(diff.vaults[0]).toMatchObject({
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });

  it("keeps an unclosed opening fence as part of the body", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf(
        { "old.md": OLD_TAGGED },
        { "new.md": "---\ntags:\n  - ai\nBody text.\n" },
      ),
      readerOf({ "Engineering/old.md": OLD_TAGGED }),
      readerOf({ "Engineering/new.md": "---\ntags:\n  - ai\nBody text.\n" }),
    );

    expect(diff.vaults[0]).toMatchObject({
      added: ["new.md"],
      removed: ["old.md"],
      renamed: [],
    });
  });

  it("leaves equal-hash renames from the first pass unchanged", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf(
        { "same.md": "Identical.\n", "old.md": OLD_TAGGED },
        { "same-2.md": "Identical.\n", "new.md": NEW_TAGGED },
      ),
      readerOf({ "Engineering/old.md": OLD_TAGGED }),
      readerOf({ "Engineering/new.md": NEW_TAGGED }),
    );

    expect(diff.vaults[0]).toMatchObject({
      renamed: [
        { from: "same.md", to: "same-2.md" },
        { from: "old.md", to: "new.md" },
      ],
    });
  });

  it("does not pair notes across different vaults", async () => {
    const diff = diffManifests(
      {
        vaults: {
          One: notesWithContent({ "old.md": OLD_TAGGED }),
          Two: notesWithContent({ "keep.md": "Keep.\n" }),
        },
      },
      {
        vaults: {
          One: notesWithContent({ "keep.md": "Keep.\n" }),
          Two: notesWithContent({ "new.md": NEW_TAGGED }),
        },
      },
    );
    const paired = await pairBodyIdenticalRenames(
      diff,
      readerOf({ "One/old.md": OLD_TAGGED }),
      readerOf({ "Two/new.md": NEW_TAGGED }),
    );

    expect(paired.vaults.every((vault) => vault.renamed.length === 0)).toBe(
      true,
    );
  });

  it("pairs with the first unmatched removed note in sorted order", async () => {
    const otherTagged = "---\ntags: []\n---\n\nBody text.\n";
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf(
        { "a-old.md": OLD_TAGGED, "b-old.md": otherTagged },
        { "new.md": NEW_TAGGED },
      ),
      readerOf({
        "Engineering/a-old.md": OLD_TAGGED,
        "Engineering/b-old.md": otherTagged,
      }),
      readerOf({ "Engineering/new.md": NEW_TAGGED }),
    );

    expect(diff.vaults[0]).toMatchObject({
      removed: ["b-old.md"],
      renamed: [{ from: "a-old.md", to: "new.md" }],
    });
  });

  it("keeps a pair unpaired when the removed content is unavailable", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf({ "old.md": OLD_TAGGED }, { "new.md": NEW_TAGGED }),
      readerOf({}),
      readerOf({ "Engineering/new.md": NEW_TAGGED }),
    );

    expect(diff.vaults[0]).toMatchObject({
      added: ["new.md"],
      removed: ["old.md"],
      renamed: [],
    });
  });

  it("keeps a pair unpaired when neither side's content is available", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf({ "old.md": OLD_TAGGED }, { "new.md": NEW_TAGGED }),
      readerOf({}),
      readerOf({}),
    );

    expect(diff.vaults[0]).toMatchObject({
      added: ["new.md"],
      removed: ["old.md"],
      renamed: [],
    });
  });

  it("keeps a body horizontal rule outside frontmatter as body text", async () => {
    const bare = "Intro\n\n---\n\nSection.\n";
    const gained = `---\nwiki: true\n---\n${bare}`;
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf({ "old.md": bare }, { "new.md": gained }),
      readerOf({ "Engineering/old.md": bare }),
      readerOf({ "Engineering/new.md": gained }),
    );

    expect(diff.vaults[0]).toMatchObject({
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });

  it("matches a closing fence with surrounding whitespace", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf(
        { "old.md": "---\ntags: [a]\n--- \nBody.\n" },
        { "new.md": "---\ntags: [b]\n---\t\nBody.\n" },
      ),
      readerOf({ "Engineering/old.md": "---\ntags: [a]\n--- \nBody.\n" }),
      readerOf({ "Engineering/new.md": "---\ntags: [b]\n---\t\nBody.\n" }),
    );

    expect(diff.vaults[0]).toMatchObject({
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });

  it("pairs a note that lost empty frontmatter during the move", async () => {
    const diff = await pairBodyIdenticalRenames(
      bodyDiffOf(
        { "old.md": "---\n---\nBody text.\n" },
        { "new.md": "Body text.\n" },
      ),
      readerOf({ "Engineering/old.md": "---\n---\nBody text.\n" }),
      readerOf({ "Engineering/new.md": "Body text.\n" }),
    );

    expect(diff.vaults[0]).toMatchObject({
      removed: [],
      renamed: [{ from: "old.md", to: "new.md" }],
    });
  });

  it("reads no note contents when a vault has no removed sources", async () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "keep.md": entry("keep") }),
      manifestWith("Engineering", {
        "keep.md": entry("keep"),
        "new.md": entry("new"),
      }),
    );
    const paired = await pairBodyIdenticalRenames(
      diff,
      () => {
        throw new Error("readRemoved must not be called");
      },
      () => {
        throw new Error("readAdded must not be called");
      },
    );

    expect(paired.vaults[0]).toMatchObject({
      added: ["new.md"],
      removed: [],
      renamed: [],
    });
  });

  it("reads no note contents when a vault has no added sources", async () => {
    const diff = diffManifests(
      manifestWith("Engineering", {
        "gone.md": entry("gone"),
        "keep.md": entry("keep"),
      }),
      manifestWith("Engineering", { "keep.md": entry("keep") }),
    );
    const paired = await pairBodyIdenticalRenames(
      diff,
      () => {
        throw new Error("readRemoved must not be called");
      },
      () => {
        throw new Error("readAdded must not be called");
      },
    );

    expect(paired.vaults[0]).toMatchObject({
      added: [],
      removed: ["gone.md"],
      renamed: [],
    });
  });
});

describe("explicitSourceDiff", () => {
  const manifestOf = (vaults: Record<string, string[]>): Manifest => ({
    vaults: Object.fromEntries(
      Object.entries(vaults).map(([vault, paths]) => [
        vault,
        Object.fromEntries(paths.map((path) => [path, entry("x")])),
      ]),
    ),
  });

  it("resolves an ambiguous path to the longest vault name", () => {
    const manifest = manifestOf({ "A/B": ["c.md"], A: ["B/c.md"] });

    const diff = explicitSourceDiff(manifest, ["A/B/c.md"]);

    expect(diff).toMatchObject({
      vaults: [{ vault: "A/B", changed: ["c.md"] }],
    });
  });

  it("keeps the longest vault name however the vault keys are ordered", () => {
    const manifest = manifestOf({ A: ["B/c.md"], "A/B": ["c.md"] });

    const diff = explicitSourceDiff(manifest, ["A/B/c.md"]);

    expect(diff).toMatchObject({
      vaults: [{ vault: "A/B", changed: ["c.md"] }],
    });
  });

  it("rejects a path no vault prefix matches", () => {
    const manifest = manifestOf({ Eng: ["neering/a.md"] });

    expect(() => explicitSourceDiff(manifest, ["Engineering/a.md"])).toThrow(
      "unknown --sources path(s): Engineering/a.md",
    );
  });

  it("sorts paths within a vault", () => {
    const manifest = manifestOf({ Engineering: ["b.md", "a.md"] });

    const diff = explicitSourceDiff(manifest, [
      "Engineering/b.md",
      "Engineering/a.md",
    ]);

    expect(diff).toMatchObject({
      vaults: [{ vault: "Engineering", changed: ["a.md", "b.md"] }],
    });
  });

  it("sorts vaults by name regardless of source order", () => {
    const manifest = manifestOf({
      Zeta: ["x.md"],
      Alpha: ["y.md"],
      Mid: ["z.md"],
    });

    const diff = explicitSourceDiff(manifest, [
      "Zeta/x.md",
      "Alpha/y.md",
      "Mid/z.md",
    ]);

    expect(diff.vaults.map((vault) => vault.vault)).toEqual([
      "Alpha",
      "Mid",
      "Zeta",
    ]);
  });

  it("returns an empty diff for an empty source list", () => {
    const manifest = manifestOf({ Engineering: ["a.md"] });

    expect(explicitSourceDiff(manifest, [])).toMatchObject({
      vaults: [],
      empty: true,
    });
  });
});

describe("wikiPages vanished untracked detection", () => {
  it("counts only vanished untracked markdown pages as deleted, in sorted order", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await writeFile(join(dataRoot, "wiki", "z.md"), "# Z\n");
    await commitAll(dataRoot, "add z");
    await runGit(dataRoot, ["rm", "--quiet", "wiki/z.md"], process.env);

    const pre: PreRunState = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      status: [
        { code: " M", path: "wiki/m.md", origin: undefined },
        { code: "??", path: "wiki/b.txt", origin: undefined },
        { code: "??", path: "wiki/a.md", origin: undefined },
      ],
      hashes: new Map<string, string>(),
      contents: new Map<string, Buffer | null>(),
    };

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
      pre,
    );

    expect(pages.deleted).toEqual(["wiki/a.md", "wiki/z.md"]);
  });

  it("does not count as deleted a pre-run untracked page the run only got ignored", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await writeFile(join(dataRoot, "wiki", "a.md"), "# A\n");

    const pre: PreRunState = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      status: [{ code: "??", path: "wiki/a.md", origin: undefined }],
      hashes: new Map<string, string>(),
      contents: new Map<string, Buffer | null>(),
    };

    // Mid-run: an ignore rule now covers the page — git status stops
    // listing it, but the disk witness sees the file still exists, so
    // it is not deleted (issue #256, D-1).
    await writeFile(join(dataRoot, ".gitignore"), "wiki/a.md\n");

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
      pre,
    );

    expect(pages.deleted).toEqual([]);
  });

  it("lists created and updated pages in sorted order with no stray entries", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await writeFile(join(dataRoot, "wiki", "z.md"), "# Z\n");
    await writeFile(join(dataRoot, "wiki", "a.md"), "# A\n");
    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index changed\n");

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
    );

    expect(pages.created).toEqual(["wiki/a.md", "wiki/z.md"]);
    expect(pages.updated).toEqual(["wiki/index.md"]);
  });

  it("counts a staged rename's target as created and its origin as deleted", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await run("git", [
      "-C",
      dataRoot,
      "mv",
      "wiki/index.md",
      "wiki/renamed.md",
    ]);

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
    );

    expect(pages.created).toEqual(["wiki/renamed.md"]);
    expect(pages.updated).toEqual([]);
    expect(pages.deleted).toEqual(["wiki/index.md"]);
  });

  it("buckets a rename out of the wiki tree as its origin's deletion only", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await run("git", ["-C", dataRoot, "mv", "wiki/A-page.md", "moved-out.md"]);

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
    );

    expect(pages).toEqual({
      created: [],
      updated: [],
      deleted: ["wiki/A-page.md"],
      unavailable: undefined,
    });
  });

  it("buckets a rename into the wiki tree as its target's creation only", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await run("git", [
      "-C",
      dataRoot,
      "mv",
      "raw/notes/Engineering/a.md",
      "wiki/imported.md",
    ]);

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
    );

    expect(pages).toEqual({
      created: ["wiki/imported.md"],
      updated: [],
      deleted: [],
      unavailable: undefined,
    });
  });

  it("counts a rename staged before the run nowhere when a pre-run state is given", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await run("git", [
      "-C",
      dataRoot,
      "mv",
      "wiki/index.md",
      "wiki/renamed.md",
    ]);

    const pre: PreRunState = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      status: [
        { code: "R ", path: "wiki/renamed.md", origin: "wiki/index.md" },
      ],
      hashes: new Map<string, string>(),
      contents: new Map<string, Buffer | null>(),
    };

    const pages = await wikiPages(
      dataRoot,
      await porcelainStatus(dataRoot, process.env),
      pre,
    );

    expect(pages).toEqual({
      created: [],
      updated: [],
      deleted: [],
      unavailable: undefined,
    });
  });

  it("buckets caller-supplied entries without spawning git", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    // No repository and no pre-run state: the entries the guardrails
    // produced are the only input (R-2) — wikiPages never runs git.
    await rm(join(dataRoot, ".git"), { recursive: true });

    const pages = await wikiPages(dataRoot, [
      { code: "??", path: "wiki/new.md", origin: undefined },
      { code: " M", path: "wiki/index.md", origin: undefined },
      { code: " D", path: "wiki/gone.md", origin: undefined },
      { code: "??", path: "raw/manifest.json", origin: undefined },
    ]);

    expect(pages).toEqual({
      created: ["wiki/new.md"],
      updated: ["wiki/index.md"],
      deleted: ["wiki/gone.md"],
      unavailable: undefined,
    });
  });
});

describe("pairBodyIdenticalRenames multibyte bodies", () => {
  it("pairs a moved note whose multibyte body is byte-identical under utf8", async () => {
    const oldNote = "---\ntitle: A\n---\n\nCafé — 中身 body.\n";
    const newNote = "---\ntitle: B\n---\n\nCafé — 中身 body.\n";
    const diffOf = (
      before: Record<string, string>,
      after: Record<string, string>,
    ) =>
      diffManifests(
        {
          vaults: {
            Engineering: Object.fromEntries(
              Object.entries(before).map(([path, content]) => [
                path,
                entry(content),
              ]),
            ),
          },
        },
        {
          vaults: {
            Engineering: Object.fromEntries(
              Object.entries(after).map(([path, content]) => [
                path,
                entry(content),
              ]),
            ),
          },
        },
      );

    const diff = await pairBodyIdenticalRenames(
      diffOf({ "old.md": oldNote }, { "new.md": newNote }),
      (_vault: string, path: string) =>
        path === "old.md" ? oldNote : undefined,
      (_vault: string, path: string) =>
        path === "new.md" ? newNote : undefined,
    );

    expect(diff.vaults[0]?.renamed).toEqual([{ from: "old.md", to: "new.md" }]);
  });
});
