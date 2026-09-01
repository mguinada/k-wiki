import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../src/data/git.ts";
import {
  type AgentRunner,
  createAgentProgressSink,
  readPrompt,
} from "../../src/ingest/agent-run.ts";
import {
  type AgentSettings,
  loadAgentSettings,
} from "../../src/ingest/agent-settings.ts";
import type { PreRunState } from "../../src/ingest/guardrails.ts";
import {
  composeExpungePrompt,
  composePrompt,
  diffManifests,
  directSetForRemovals,
  explicitSourceDiff,
  formatDigest,
  type IngestRun,
  main,
  pairBodyIdenticalRenames,
  removedNoteContent,
  runWikiIngest,
  warnTrackedIgnored,
  wikiPages,
} from "../../src/ingest/wiki-ingest.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  serializeManifest,
  type VaultNotes,
} from "../../src/sync/manifest.ts";

const SETTINGS_YML = `# Agent configuration (issue #11).
command: pi
model: GLM-5.2 # trailing comment
reasoning: "high"
`;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function manifestWith(vault: string, notes: VaultNotes): Manifest {
  return { vaults: { [vault]: notes } };
}

function entry(content: string) {
  return { hash: hashOf(content), last_synced: "2026-08-20T00:00:00.000Z" };
}

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

describe("composePrompt", () => {
  const diff = diffManifests(
    manifestWith("Engineering", {
      "old.md": entry("old"),
      "gone.md": entry("gone"),
    }),
    manifestWith("Engineering", {
      "new.md": entry("new"),
      "old.md": entry("old2"),
    }),
  );

  it("returns the prompt text unchanged for a full ingest", () => {
    expect(composePrompt("PROMPT", undefined)).toBe("PROMPT");
  });

  it("labels the changed-sources section of the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain(
      "Changed sources since the previous ingestion:",
    );
  });

  it("lists an added source with a plus in the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain("+ Engineering/new.md");
  });

  it("lists a changed source with a tilde in the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain("~ Engineering/old.md");
  });

  it("lists a removed source with a minus in the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain("- Engineering/gone.md");
  });

  it("renders the exact incremental prompt format", () => {
    expect(composePrompt("PROMPT", diff)).toBe(
      [
        "PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "+ Engineering/new.md",
        "~ Engineering/old.md",
        "- Engineering/gone.md",
      ].join("\n"),
    );
  });

  it("renders a rename pair as one arrow line", () => {
    const renamed = diffManifests(
      manifestWith("Engineering", { "old.md": entry("same") }),
      manifestWith("Engineering", { "new.md": entry("same") }),
    );

    expect(composePrompt("PROMPT", renamed)).toBe(
      [
        "PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "→ Engineering/old.md → Engineering/new.md",
      ].join("\n"),
    );
  });

  it("appends the operator note below the changed-source list under an Operator note heading", () => {
    expect(composePrompt("PROMPT", diff, "re-adjudicate: under-filed")).toBe(
      [
        "PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "+ Engineering/new.md",
        "~ Engineering/old.md",
        "- Engineering/gone.md",
        "",
        "Operator note:",
        "",
        "re-adjudicate: under-filed",
      ].join("\n"),
    );
  });

  it("leaves a full-ingest prompt unchanged when a note is given", () => {
    expect(composePrompt("PROMPT", undefined, "NOTE")).toBe("PROMPT");
  });
});

describe("composeExpungePrompt", () => {
  const diff = diffManifests(
    manifestWith("Engineering", {
      "gone.md": entry("gone"),
      "a.md": entry("a"),
    }),
    manifestWith("Engineering", { "a.md": entry("a") }),
  );

  it("appends the changed sources, note content, and direct set", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      diff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      ["index.md", "overview.md"],
    );

    expect(composed).toBe(
      [
        "EXPUNGE PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "- Engineering/gone.md",
        "",
        "Removed notes with their last synced content:",
        "",
        "### Engineering/gone.md (raw/notes/Engineering/gone.md)",
        "",
        "````markdown",
        "last body",
        "````",
        "",
        "Direct set (deterministic seed — a lower bound, not a boundary):",
        "",
        "- wiki/index.md",
        "- wiki/overview.md",
      ].join("\n"),
    );
  });

  it("states unavailable content instead of an empty fence", () => {
    const composed = composeExpungePrompt(
      "P",
      diff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: undefined,
        },
      ],
      [],
    );

    expect(composed).toContain(
      "(last synced content unavailable: no committed git history — purge by path, title, and full-text search)",
    );
  });

  const mixedDiff = diffManifests(
    manifestWith("Engineering", {
      "gone.md": entry("gone"),
      "keep.md": entry("keep"),
    }),
    manifestWith("Engineering", {
      "keep.md": entry("keep"),
      "fresh.md": entry("fresh"),
    }),
  );

  it("embeds the incremental instruction block under the expunge prompt", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      mixedDiff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      [],
      "INCREMENTAL PROMPT",
    );

    expect(composed).toContain(
      [
        "EXPUNGE PROMPT",
        "",
        "This run also carries added, edited, or renamed sources (`+`, `~`, `→` in the list below). In the same run, process them exactly as an incremental ingestion would:",
        "",
        "INCREMENTAL PROMPT",
      ].join("\n"),
    );
  });

  it("lists the addition a mixed expunge run also carries", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      mixedDiff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      [],
      "INCREMENTAL PROMPT",
    );

    expect(composed).toContain("+ Engineering/fresh.md");
  });

  it("lists the removal a mixed expunge run also carries", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      mixedDiff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      [],
      "INCREMENTAL PROMPT",
    );

    expect(composed).toContain("- Engineering/gone.md");
  });

  it("wraps a note body whose own fences are four backticks long", () => {
    const composed = composeExpungePrompt(
      "P",
      diff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "````\nnested fence\n````",
        },
      ],
      [],
    );

    expect(composed).toContain(
      "`````markdown\n````\nnested fence\n````\n`````",
    );
  });
});

function digestRun(overrides: Partial<IngestRun> = {}): IngestRun {
  const settings: AgentSettings = {
    command: "pi",
    model: "GLM-5.2",
    reasoning: "high",
  };

  return {
    startedAt: new Date("2026-08-20T17:30:00.000Z"),
    mode: "incremental",
    promptFile: "prompts/incremental.md",
    settings,
    diff: diffManifests(
      manifestWith("Engineering", {
        "a.md": entry("a"),
        "b.md": entry("b"),
        "c.md": entry("c"),
      }),
      manifestWith("Engineering", {
        "a.md": entry("a2"),
        "b.md": entry("b"),
        "d.md": entry("d"),
      }),
    ),
    directSet: undefined,
    pages: {
      created: ["wiki/concepts/new.md"],
      updated: ["wiki/index.md", "wiki/log.md"],
      deleted: ["wiki/gone.md"],
      unavailable: undefined,
    },
    agentOutput: "AGENT REPORT",
    unverifiedFrontier: [],
    ...overrides,
  };
}

describe("formatDigest", () => {
  it("states the agent command in the digest", () => {
    expect(formatDigest(digestRun())).toContain("`pi`");
  });

  it("states the agent model in the digest", () => {
    expect(formatDigest(digestRun())).toContain("`GLM-5.2`");
  });

  it("states the agent reasoning level in the digest", () => {
    expect(formatDigest(digestRun())).toContain("`high`");
  });

  it("omits the provider from the digest when it is unset", () => {
    expect(formatDigest(digestRun())).not.toContain("provider");
  });

  it("names the provider in the digest when it is set", () => {
    const digest = formatDigest(
      digestRun({
        settings: { ...digestRun().settings, provider: "zai" },
      }),
    );

    expect(digest).toContain("provider `zai`");
  });

  it("records the isolation state on the agent line", () => {
    expect(formatDigest(digestRun())).toContain("· isolated");
  });

  it("records an isolate: false opt-out on the agent line", () => {
    const digest = formatDigest(
      digestRun({
        settings: { ...digestRun().settings, isolate: false },
      }),
    );

    expect(digest).toContain("· not isolated");
  });

  it("opens with the digest heading and run timestamp", () => {
    expect(formatDigest(digestRun())).toContain(
      "# Wiki ingest digest — 2026-08-20T17:30:00.000Z",
    );
  });

  it("states the run mode on the Mode line", () => {
    const digest = formatDigest(
      digestRun({ mode: "full", promptFile: "prompts/ingest.md" }),
    );

    expect(digest).toContain("**Mode:** full");
  });

  it("states the prompt file the run used", () => {
    const digest = formatDigest(
      digestRun({ mode: "full", promptFile: "prompts/ingest.md" }),
    );

    expect(digest).toContain("`prompts/ingest.md`");
  });

  it("counts sources added, changed, removed, and renamed", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain(
      "**Sources:** 1 added, 1 changed, 1 removed, 0 renamed",
    );
  });

  it("groups the changed source paths under the vault name", () => {
    expect(formatDigest(digestRun())).toContain("**Engineering**");
  });

  it("lists an added source path in the digest", () => {
    expect(formatDigest(digestRun())).toContain("- + Engineering/d.md");
  });

  it("lists a changed source path in the digest", () => {
    expect(formatDigest(digestRun())).toContain("~ Engineering/a.md");
  });

  it("lists a removed source path in the digest", () => {
    expect(formatDigest(digestRun())).toContain("- − Engineering/c.md");
  });

  it("carries a Changed sources section heading", () => {
    expect(formatDigest(digestRun())).toContain("## Changed sources");
  });

  it("carries a Wiki pages section heading", () => {
    expect(formatDigest(digestRun())).toContain("## Wiki pages (git diff)");
  });

  it("labels the created page list", () => {
    expect(formatDigest(digestRun())).toContain("Created:");
  });

  it("labels the updated page list", () => {
    expect(formatDigest(digestRun())).toContain("Updated:");
  });

  it("carries the agent report under its own heading", () => {
    expect(formatDigest(digestRun())).toContain("## Agent report");
  });

  it("carries the agent report body in the digest", () => {
    expect(formatDigest(digestRun())).toContain("AGENT REPORT");
  });

  it("counts created, updated, and deleted wiki pages on the summary line", () => {
    expect(formatDigest(digestRun())).toContain(
      "**Wiki pages:** 1 created, 2 updated, 1 deleted",
    );
  });

  it("lists the created page under Created", () => {
    expect(formatDigest(digestRun())).toContain("- wiki/concepts/new.md");
  });

  it("lists an updated page under Updated", () => {
    expect(formatDigest(digestRun())).toContain("- wiki/index.md");
  });

  it("labels the deleted page list", () => {
    expect(formatDigest(digestRun())).toContain("Deleted:");
  });

  it("lists the deleted page under Deleted", () => {
    expect(formatDigest(digestRun())).toContain("- wiki/gone.md");
  });

  it("embeds the agent report verbatim", () => {
    expect(formatDigest(digestRun())).toContain("AGENT REPORT");
  });

  it("points the reviewer at contradictions and unresolved questions", () => {
    expect(formatDigest(digestRun())).toContain("unresolved questions");
  });

  it("opens a Guardrails failed section when a check tripped", () => {
    const digest = formatDigest(
      digestRun({
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: "run reverted — guardrail check 2 (frontmatter) tripped",
        },
        guardrailFailure: {
          check: 2,
          name: "frontmatter",
          problems: ["wiki/bad.md: no frontmatter block"],
        },
      }),
    );

    expect(digest).toContain("## Guardrails failed");
  });

  it("names the tripped check in the failure section", () => {
    const digest = formatDigest(
      digestRun({
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: "run reverted — guardrail check 2 (frontmatter) tripped",
        },
        guardrailFailure: {
          check: 2,
          name: "frontmatter",
          problems: ["wiki/bad.md: no frontmatter block"],
        },
      }),
    );

    expect(digest).toContain("Check 2 (frontmatter)");
  });

  it("lists the guardrail problem in the failure section", () => {
    const digest = formatDigest(
      digestRun({
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: "run reverted — guardrail check 2 (frontmatter) tripped",
        },
        guardrailFailure: {
          check: 2,
          name: "frontmatter",
          problems: ["wiki/bad.md: no frontmatter block"],
        },
      }),
    );

    expect(digest).toContain("- wiki/bad.md: no frontmatter block");
  });

  it("marks the wiki page counts unavailable on a reverted run", () => {
    const digest = formatDigest(
      digestRun({
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: "run reverted — guardrail check 2 (frontmatter) tripped",
        },
        guardrailFailure: {
          check: 2,
          name: "frontmatter",
          problems: ["wiki/bad.md: no frontmatter block"],
        },
      }),
    );

    expect(digest).toContain("**Wiki pages:** unavailable — run reverted");
  });

  it("marks the wiki page counts unavailable when git could not report", () => {
    const digest = formatDigest(
      digestRun({
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: "no git",
        },
      }),
    );

    expect(digest).toContain("**Wiki pages:** unavailable — no git");
  });

  it("states the unavailable reason under the pages heading", () => {
    const digest = formatDigest(
      digestRun({
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: "no git",
        },
      }),
    );

    expect(digest).toContain("unavailable: no git");
  });

  it("reports the changed model in the digest", () => {
    const other = formatDigest(
      digestRun({
        settings: { command: "pi", model: "OTHER-MODEL", reasoning: "high" },
      }),
    );

    expect(other).toContain("`OTHER-MODEL`");
  });

  it("drops the previous model from the digest when the config changes", () => {
    const other = formatDigest(
      digestRun({
        settings: { command: "pi", model: "OTHER-MODEL", reasoning: "high" },
      }),
    );

    expect(other).not.toContain("`GLM-5.2`");
  });

  it("counts all sources as added on a full ingest", () => {
    const digest = formatDigest(
      digestRun({
        mode: "full",
        promptFile: "prompts/ingest.md",
        diff: diffManifests(
          emptyManifest(),
          manifestWith("Engineering", {
            "a.md": entry("a"),
            "b.md": entry("b"),
          }),
        ),
      }),
    );

    expect(digest).toContain(
      "**Sources:** 2 added, 0 changed, 0 removed, 0 renamed",
    );
  });

  it("does not list each source on a full ingest", () => {
    const digest = formatDigest(
      digestRun({
        mode: "full",
        promptFile: "prompts/ingest.md",
        diff: diffManifests(
          emptyManifest(),
          manifestWith("Engineering", {
            "a.md": entry("a"),
            "b.md": entry("b"),
          }),
        ),
      }),
    );

    expect(digest).not.toContain("- + Engineering/");
  });

  it("counts a renamed source in the digest's summary line", () => {
    const digest = formatDigest(
      digestRun({
        diff: diffManifests(
          manifestWith("Engineering", { "old.md": entry("same") }),
          manifestWith("Engineering", { "new.md": entry("same") }),
        ),
      }),
    );

    expect(digest).toContain(
      "**Sources:** 0 added, 0 changed, 0 removed, 1 renamed",
    );
  });

  it("lists a renamed source with an arrow line", () => {
    const digest = formatDigest(
      digestRun({
        diff: diffManifests(
          manifestWith("Engineering", { "old.md": entry("same") }),
          manifestWith("Engineering", { "new.md": entry("same") }),
        ),
      }),
    );

    expect(digest).toContain("→ Engineering/old.md → Engineering/new.md");
  });

  it("labels the digest header with the expunge mode", () => {
    const digest = formatDigest(
      digestRun({
        mode: "expunge",
        promptFile: "prompts/expunge.md",
        directSet: ["wiki/index.md", "wiki/overview.md"],
      }),
    );

    expect(digest).toContain(
      "# Wiki ingest digest (expunge) — 2026-08-20T17:30:00.000Z",
    );
  });

  it("states the expunge mode on the Mode line", () => {
    const digest = formatDigest(
      digestRun({
        mode: "expunge",
        promptFile: "prompts/expunge.md",
        directSet: ["wiki/index.md", "wiki/overview.md"],
      }),
    );

    expect(digest).toContain("**Mode:** expunge");
  });

  it("carries the expunge direct set under its own heading", () => {
    const digest = formatDigest(
      digestRun({
        mode: "expunge",
        promptFile: "prompts/expunge.md",
        directSet: ["sources/gone.md", "index.md"],
      }),
    );

    expect(digest).toContain("## Expunge direct set");
  });

  it("prefixes the direct set's page paths with wiki/", () => {
    const digest = formatDigest(
      digestRun({
        mode: "expunge",
        promptFile: "prompts/expunge.md",
        directSet: ["sources/gone.md", "index.md"],
      }),
    );

    expect(digest).toContain("- wiki/sources/gone.md");
  });

  it("lists a root-level direct-set page under wiki/", () => {
    const digest = formatDigest(
      digestRun({
        mode: "expunge",
        promptFile: "prompts/expunge.md",
        directSet: ["sources/gone.md", "index.md"],
      }),
    );

    expect(digest).toContain("- wiki/index.md");
  });

  it("omits the expunge section for a non-expunge run carrying a direct set", () => {
    const digest = formatDigest(digestRun({ directSet: ["sources/gone.md"] }));

    expect(digest).not.toContain("## Expunge direct set");
  });

  it("omits the expunge section when an expunge run has no direct set", () => {
    const digest = formatDigest(
      digestRun({ mode: "expunge", promptFile: "prompts/expunge.md" }),
    );

    expect(digest).not.toContain("## Expunge direct set");
  });

  it("renders the exact expunge section between changed sources and pages", () => {
    const digest = formatDigest(
      digestRun({
        mode: "expunge",
        promptFile: "prompts/expunge.md",
        directSet: ["index.md", "overview.md"],
      }),
    );

    expect(digest).toContain(
      [
        "- − Engineering/c.md",
        "",
        "## Expunge direct set",
        "",
        "- wiki/index.md",
        "- wiki/overview.md",
        "",
        "## Wiki pages (git diff)",
      ].join("\n"),
    );
  });

  it("omits the Unverified frontier section when it is empty", () => {
    expect(formatDigest(digestRun())).not.toContain("## Unverified frontier");
  });

  it("renders the Unverified frontier section with single-source pages", () => {
    const digest = formatDigest(
      digestRun({
        unverifiedFrontier: [
          { path: "wiki/concepts/new.md", sources: ['"[[Source A]]"'] },
        ],
      }),
    );

    expect(digest).toContain("## Unverified frontier");
  });

  it("lists a frontier page with its single source", () => {
    const digest = formatDigest(
      digestRun({
        unverifiedFrontier: [
          { path: "wiki/concepts/new.md", sources: ['"[[Source A]]"'] },
        ],
      }),
    );

    expect(digest).toContain(
      '- wiki/concepts/new.md (1 source: "[[Source A]]")',
    );
  });

  it("places the frontier section before the agent report", () => {
    const digest = formatDigest(
      digestRun({
        unverifiedFrontier: [
          { path: "wiki/concepts/new.md", sources: ['"[[Source A]]"'] },
        ],
      }),
    );

    expect(digest.indexOf("## Unverified frontier")).toBeLessThan(
      digest.indexOf("## Agent report"),
    );
  });

  it("renders the exact unverified-frontier block before the wiki-pages section", () => {
    const digest = formatDigest(
      digestRun({
        unverifiedFrontier: [
          { path: "wiki/concepts/new.md", sources: ['"[[Source A]]"'] },
        ],
      }),
    );

    expect(digest).toContain(
      '\n\n## Unverified frontier\n\nPages with exactly one source (mechanical):\n- wiki/concepts/new.md (1 source: "[[Source A]]")\n\n## Wiki pages (git diff)',
    );
  });

  it("renders the exact digest document for a run", () => {
    expect(formatDigest(digestRun())).toBe(
      [
        "# Wiki ingest digest — 2026-08-20T17:30:00.000Z",
        "",
        "- **Agent:** `pi` · model `GLM-5.2` · reasoning `high` · isolated",
        "- **Mode:** incremental · prompt `prompts/incremental.md`",
        "- **Sources:** 1 added, 1 changed, 1 removed, 0 renamed",
        "- **Wiki pages:** 1 created, 2 updated, 1 deleted",
        "- **Contradictions and unresolved questions:** in the agent report below",
        "",
        "## Changed sources",
        "",
        "**Engineering**",
        "- + Engineering/d.md",
        "~ Engineering/a.md",
        "- − Engineering/c.md",
        "",
        "## Wiki pages (git diff)",
        "",
        "Created:",
        "- wiki/concepts/new.md",
        "",
        "Updated:",
        "- wiki/index.md",
        "- wiki/log.md",
        "",
        "Deleted:",
        "- wiki/gone.md",
        "",
        "## Agent report",
        "",
        "AGENT REPORT",
        "",
      ].join("\n"),
    );
  });
});

describe("removedNoteContent", () => {
  it("returns the HEAD content while the removal is uncommitted", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "last body" });

    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));

    await expect(
      removedNoteContent(dataRoot, "raw/notes/Engineering/a.md", process.env),
    ).resolves.toBe("last body");
  });

  it("returns the parent-tree content after the deletion is committed", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "final body" });

    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));
    await run("git", ["-C", dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "remove note",
    ]);

    await expect(
      removedNoteContent(dataRoot, "raw/notes/Engineering/a.md", process.env),
    ).resolves.toBe("final body");
  });

  it("returns undefined for a path git never knew", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/never.md",
        process.env,
      ),
    ).resolves.toBeUndefined();
  });

  it("returns undefined outside a git repository", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await rm(join(dataRoot, ".git"), { recursive: true });

    await expect(
      removedNoteContent(dataRoot, "raw/notes/Engineering/a.md", process.env),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for an expected hash outside a git repository", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await rm(join(dataRoot, ".git"), { recursive: true });

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("a"),
      ),
    ).resolves.toBeUndefined();
  });

  it("returns the blob matching the expected hash, skipping newer committed edits", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "first body" });

    await writeFile(
      join(dataRoot, "raw", "notes", "Engineering", "a.md"),
      "second body",
    );
    await commitAll(dataRoot, "edit body");
    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));
    await commitAll(dataRoot, "remove note");

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("first body"),
      ),
    ).resolves.toBe("first body");
  });

  it("returns the HEAD blob when it matches the expected hash", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "last body" });

    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("last body"),
      ),
    ).resolves.toBe("last body");
  });

  it("returns undefined when no committed blob matches the expected hash", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "first body" });

    await writeFile(
      join(dataRoot, "raw", "notes", "Engineering", "a.md"),
      "second body",
    );
    await commitAll(dataRoot, "edit body");
    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));
    await commitAll(dataRoot, "remove note");

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("never committed"),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("directSetForRemovals", () => {
  it("seeds the origin page, citing pages, index, and overview", async () => {
    const wikiRoot = await makeExpungeWiki();

    expect(
      await directSetForRemovals(wikiRoot, ["raw/notes/V/Scratch/temp.md"]),
    ).toEqual([
      "concepts/cites.md",
      "index.md",
      "overview.md",
      "queries/q.md",
      "sources/Temp research.md",
    ]);
  });

  it("matches an origin written without the raw/ prefix", async () => {
    const wikiRoot = await makeExpungeWiki();

    expect(
      await directSetForRemovals(wikiRoot, ["raw/notes/V/Other/note.md"]),
    ).toEqual(["index.md", "overview.md", "sources/prefixless.md"]);
  });

  it("does not seed a page whose wikilink target is not an origin page", async () => {
    const wikiRoot = await makeExpungeWiki();

    expect(
      await directSetForRemovals(wikiRoot, ["raw/notes/V/Scratch/temp.md"]),
    ).not.toContain("concepts/ignore-wikilink.md");
  });

  it("does not strip a raw/ segment from inside an origin path", async () => {
    const wikiRoot = await makeExpungeWiki();

    expect(await directSetForRemovals(wikiRoot, ["raw/notes/V/a.md"])).toEqual([
      "index.md",
      "overview.md",
    ]);
  });

  it("falls back to index and overview when the wiki dir is missing", async () => {
    await expect(
      directSetForRemovals("/no/such/wiki", ["raw/notes/V/a.md"]),
    ).resolves.toEqual(["index.md", "overview.md"]);
  });
});

/** A wiki tree with an origin page, citing pages, and noise. */
async function makeExpungeWiki(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-seed-"));

  tempDirs.push(root);

  const wikiRoot = join(root, "wiki");
  const files: Record<string, string> = {
    "sources/Temp research.md":
      "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
    "sources/prefixless.md":
      "---\ntitle: Prefixless\ntype: source\norigin: notes/V/Other/note.md\n---\nbody",
    "sources/tricky.md":
      "---\ntitle: Tricky\ntype: source\norigin: notes/V/raw/a.md\n---\nbody",
    "concepts/cites.md":
      '---\ntitle: Cites\nsources:\n  - "notes/V/Scratch/temp.md"\n---\nbody',
    "concepts/other.md":
      '---\ntitle: Other\nsources:\n  - "notes/V/AI/rag.md"\n---\nbody',
    "concepts/ignore-wikilink.md":
      '---\ntitle: Ignores\nsources:\n  - "[[Prefixless]]"\n---\nbody',
    "queries/q.md":
      '---\ntitle: Q\ntype: query\nsources:\n  - "[[Temp research]]"\n---\nbody',
    "index.md": "# Index",
    "overview.md": "# Overview",
  };

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(wikiRoot, dirname(file)), { recursive: true });
    await writeFile(join(wikiRoot, file), content);
  }

  return wikiRoot;
}

const run = promisify(execFile);

/** A data repo: raw/ with a manifest and note files, wiki/ with pages, committed to git. */
async function makeDataRepo(notes: Record<string, string>): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-ingest-"));

  tempDirs.push(dataRoot);

  const manifest = manifestWith(
    "Engineering",
    Object.fromEntries(
      Object.entries(notes).map(([path, content]) => [path, entry(content)]),
    ),
  );

  await mkdir(join(dataRoot, "raw", "notes", "Engineering"), {
    recursive: true,
  });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });

  for (const [path, content] of Object.entries(notes)) {
    await writeFile(
      join(dataRoot, "raw", "notes", "Engineering", path),
      content,
    );
  }

  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    serializeManifest(manifest),
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(
    join(dataRoot, "wiki", "sources", "src.md"),
    "---\ntitle: Src\ntype: source\ncreated: 2026-08-20\nupdated: 2026-08-20\ntags:\n  - source\norigin: raw/notes/Engineering/a.md\n---\nHub.\n",
  );
  await writeFile(join(dataRoot, "wiki", "A-page.md"), "# A page\n");
  await writeFile(join(dataRoot, "wiki", "gone.md"), "# Gone\n");
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ],
    { cwd: dataRoot },
  );

  return dataRoot;
}

/** Commit every change in a data repo, as a sync cycle would. */
async function commitAll(dataRoot: string, message: string): Promise<void> {
  await run("git", ["-C", dataRoot, "add", "-A"]);
  await run("git", [
    "-C",
    dataRoot,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

interface Harness {
  readonly dataRoot: string;
  readonly outputsDir: string;
  /** The snapshot's home since #112: the data repo's outputs/. */
  readonly snapshotPath: string;
  /** The pre-#112 snapshot location (the wrapper's outputs dir). */
  readonly legacySnapshotPath: string;
  readonly promptsDir: string;
  readonly settingsPath: string;
  readonly invocations: {
    command: string;
    args: readonly string[];
    cwd: string;
  }[];
  runAgent: AgentRunner;
}

/** A wiki page body with valid §9 frontmatter (guardrail 2 must pass). */
/** The guardrail-2 saboteur: writes frontmatter-free pages, reports success. */
function frontmatterSaboteur(...pages: string[]): AgentRunner {
  return async (_command, _args, options) => {
    for (const page of pages) {
      await writeFile(join(options.cwd, "wiki", page), "no frontmatter\n");
    }

    return { stdout: "rogue report", stderr: "" };
  };
}

function wikiPage(body: string): string {
  return [
    "---",
    'title: "Page"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[src]]"',
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** Fixture prompt files plus a recording, wiki-writing fake agent. */
async function makeHarness(notes: Record<string, string>): Promise<Harness> {
  const dataRoot = await makeDataRepo(notes);
  // The wrapper's outputs dir is NOT the data repo's (issue #112): a
  // separate temp dir proves the snapshot follows the data repo while
  // digests stay with the wrapper.
  const outputsDir = await mkdtemp(join(tmpdir(), "k-wiki-ingest-outputs-"));

  tempDirs.push(outputsDir);

  const promptsDir = join(dataRoot, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "ingest.md"), "FULL PROMPT");
  await writeFile(join(promptsDir, "incremental.md"), "INCREMENTAL PROMPT");
  await writeFile(join(promptsDir, "expunge.md"), "EXPUNGE PROMPT");

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(settingsPath, SETTINGS_YML);

  const invocations: Harness["invocations"] = [];
  const runAgent: AgentRunner = async (command, args, options) => {
    invocations.push({ command, args, cwd: options.cwd });
    await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
    await writeFile(
      join(options.cwd, "wiki", "concepts", "new.md"),
      wikiPage("New"),
      { flag: "wx" },
    ).catch(() => {});
    await writeFile(
      join(options.cwd, "wiki", "index.md"),
      wikiPage("# Index v2"),
    );
    await writeFile(
      join(options.cwd, "wiki", "A-page.md"),
      wikiPage("# A page v2"),
    );
    await rm(join(options.cwd, "wiki", "gone.md")).catch(() => {});

    return { stdout: "agent final report", stderr: "" };
  };

  return {
    dataRoot,
    outputsDir,
    snapshotPath: join(dataRoot, "outputs", "last-ingested-manifest.json"),
    legacySnapshotPath: join(outputsDir, "last-ingested-manifest.json"),
    promptsDir,
    settingsPath,
    invocations,
    runAgent,
  };
}

function optionsFor(h: Harness) {
  return {
    settingsPath: h.settingsPath,
    rawDir: join(h.dataRoot, "raw"),
    outputsDir: h.outputsDir,
    promptsDir: h.promptsDir,
    runAgent: h.runAgent,
    now: () => new Date("2026-08-20T18:00:00.000Z"),
  };
}

/** The file names currently under `dir`, or [] when it does not exist. */
async function runFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** Undo a test's forced `process.stderr.isTTY`. */
function restoreStderrTty(prior: PropertyDescriptor | undefined): void {
  if (prior === undefined) {
    delete (process.stderr as { isTTY?: boolean }).isTTY;

    return;
  }

  Object.defineProperty(process.stderr, "isTTY", prior);
}

/** Undo a test's NO_COLOR override. */
function restoreNoColor(prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env.NO_COLOR;

    return;
  }

  process.env.NO_COLOR = prior;
}

/** The recorded invocation at `index`; fails loudly when absent. */
function invocation(h: Harness, index: number) {
  const recorded = h.invocations[index];

  if (recorded === undefined) {
    throw new Error(`agent was not invoked (call ${index})`);
  }

  return recorded;
}

describe("runWikiIngest", () => {
  it("runs the agent when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("uses the full ingest prompt when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args.at(-1)).toBe("FULL PROMPT");
  });

  it("invokes the agent in the data repo root", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).cwd).toBe(h.dataRoot);
  });

  it("passes the --provider flag when the setting is present", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--provider");
  });

  it("passes the provider value after --provider", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--provider") + 1]).toBe("zai");
  });

  it("passes the --model flag from settings", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--model");
  });

  it("passes the model value after --model", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--model") + 1]).toBe("GLM-5.2");
  });

  it("passes the --thinking flag from settings", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--thinking");
  });

  it("passes the reasoning level after --thinking", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("passes the prompt via --print", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--print");
  });

  it("passes the pi isolation flags by default", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(
      ["--no-context-files", "--no-extensions", "--no-skills"].every((flag) =>
        args.includes(flag),
      ),
    ).toBe(true);
  });

  it("omits the isolation flags on an isolate: false opt-out", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nreasoning: high\nisolate: false\n",
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toEqual([
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "FULL PROMPT",
    ]);
  });

  it("passes one --skill/-e flag per whitelisted entry after the isolation flags (issue #144)", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const skillDir = join(h.dataRoot, ".agents", "skills", "obsidian-markdown");

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n");
    await mkdir(join(h.dataRoot, "exts"), { recursive: true });
    await writeFile(join(h.dataRoot, "exts", "web-access.ts"), "export {};\n");
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [.agents/skills/obsidian-markdown]\nisolate.extensions: [exts/web-access.ts]\n`,
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args.slice(0, 7)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--skill",
      skillDir,
      "-e",
      join(h.dataRoot, "exts", "web-access.ts"),
    ]);
  });

  it("warns and omits an absent whitelist entry (issue #144)", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const progress: string[] = [];

    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [.agents/skills/absent]\n`,
    );
    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContain(
      `WARNING — isolate.skills entry "${join(h.dataRoot, ".agents", "skills", "absent")}" not found; omitted`,
    );
    expect(invocation(h, 0).args).not.toContain("--skill");
  });

  it("records the whitelist state in the digest header (issue #144)", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const skillDir = join(h.dataRoot, ".agents", "skills", "obsidian-markdown");

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n");
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [.agents/skills/obsidian-markdown]\n`,
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran ingest");
    }

    expect(result.digest).toContain("· isolated +1 skill");
  });

  it("keeps the whitelist keys ignored on an isolate: false opt-out", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate: false\nisolate.skills: [.agents/skills/absent]\n`,
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toEqual([
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "FULL PROMPT",
    ]);
  });

  it("writes the manifest snapshot the next run diffs against", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const snapshot = parseManifest(
      await (await import("node:fs/promises")).readFile(h.snapshotPath, "utf8"),
      "snapshot",
    );

    expect(snapshot.vaults.Engineering?.["a.md"]?.hash).toBe(hashOf("a"));
  });

  it("stamps the written snapshot with the data repo root", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const snapshot = JSON.parse(await readFile(h.snapshotPath, "utf8"));

    expect(snapshot.snapshotFor).toBe(h.dataRoot);
  });

  it("writes no snapshot into the wrapper's outputs dir", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    await expect(readFile(h.legacySnapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the written snapshot out of the data repo's git status", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const { stdout } = await run("git", [
      "-C",
      h.dataRoot,
      "status",
      "--porcelain",
      "-uall",
      "--",
      "outputs",
    ]);

    expect(stdout).toBe("");
  });

  it("appends the snapshot ignore entry to an existing data-repo .gitignore", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(join(h.dataRoot, ".gitignore"), "scratch/");

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n",
    );
  });

  it("leaves a data-repo .gitignore that already ignores the snapshot untouched", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const before =
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n";

    await writeFile(join(h.dataRoot, ".gitignore"), before);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("appends the snapshot ignore entry without adding a blank line after a terminated .gitignore", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(join(h.dataRoot, ".gitignore"), "scratch/\n");

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n",
    );
  });

  it("creates the data-repo .gitignore with only the snapshot entry when none exists", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(
      "# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n",
    );
  });

  it("treats a whitespace-padded snapshot entry line as already present", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const before =
      "scratch/\n  outputs/last-ingested-manifest.json  \n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n";

    await writeFile(join(h.dataRoot, ".gitignore"), before);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("treats an anchored dashboard.html entry line as already present", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const before =
      "scratch/\noutputs/last-ingested-manifest.json\n/dashboard.html\n";

    await writeFile(join(h.dataRoot, ".gitignore"), before);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("adopts a legacy wrapper snapshot when the data repo has none", async () => {
    const h = await makeHarness({ "a.md": "a2" });

    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("adopts a legacy snapshot when the data repo outputs dir already holds files", async () => {
    const h = await makeHarness({ "a.md": "a2" });

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      join(h.dataRoot, "outputs", "lint-2026-08-24.md"),
      "lint report\n",
    );
    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("announces the legacy snapshot adoption on progress", async () => {
    const h = await makeHarness({ "a.md": "a2" });
    const messages: string[] = [];

    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some((message) =>
        message.startsWith("wiki-ingest: adopting legacy snapshot from"),
      ),
    ).toBe(true);
  });

  it("keeps guarding an adopted legacy snapshot stamped for a foreign root", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some((message) =>
        message.includes("is stamped for /foreign/data-root"),
      ),
    ).toBe(true);
  });

  it("prefers the data-repo snapshot when both locations hold one", async () => {
    const h = await makeHarness({ "a.md": "a2" });

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );
    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: h.dataRoot },
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("runs a full ingest instead of expunging on a foreign snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("warns loudly when the snapshot is stamped for another data root", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes("is stamped for /foreign/data-root"),
      ),
    ).toBe(true);
  });

  it("promises a self-healing full-run fallback in the foreign-snapshot warning of an unscoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("falling back to a full run") &&
          message.includes("this warning will not repeat"),
      ),
    ).toBe(true);
  });

  it("runs a full ingest on an unstamped legacy snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("warns that an unstamped legacy snapshot has no instance stamp", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes("has no instance stamp"),
      ),
    ).toBe(true);
  });

  it("the legacy-snapshot warning states the self-healing rewrite", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some((message) =>
        message.includes(
          "rewrites the snapshot, so this warning will not repeat",
        ),
      ),
    ).toBe(true);
  });

  it("rejects a snapshot that is not valid JSON", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(h.snapshotPath, "not json");

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("names the JSON parse failure as the cause of the rejection", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(h.snapshotPath, "not json");

    await expect(runWikiIngest(optionsFor(h))).rejects.toHaveProperty(
      "cause",
      expect.any(SyntaxError),
    );
  });

  it("runs the agent on the first ingest before skipping", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const first = await runWikiIngest(optionsFor(h));

    expect(first.status).toBe("ran");
  });

  it("skips the agent when nothing changed since the snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await runWikiIngest(optionsFor(h));
    const second = await runWikiIngest(optionsFor(h));

    expect(second).toMatchObject({
      status: "skipped",
      reason: "no changed sources since the last ingest; nothing to do",
    });
  });

  it("announces the skip on the progress line", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await runWikiIngest(optionsFor(h));
    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContain(
      "no changed sources since the last ingest; nothing to do",
    );
  });

  it("does not invoke the agent again when nothing changed", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));
    await runWikiIngest(optionsFor(h));

    expect(h.invocations).toHaveLength(1);
  });

  it("skips the agent when the manifest holds no notes at all", async () => {
    const h = await makeHarness({});
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("skipped");
  });

  it("invokes no agent when the manifest holds no notes at all", async () => {
    const h = await makeHarness({});

    await runWikiIngest(optionsFor(h));

    expect(h.invocations).toHaveLength(0);
  });

  it("runs the agent again when a source changed", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("selects the incremental prompt for a changed source", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("names the changed source in the incremental prompt", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("Engineering/a.md");
  });

  it("runs the agent on an expunge cycle", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("marks a removed-source run as expunge mode", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("expunge");
  });

  it("delivers the expunge prompt for a removed source", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("EXPUNGE PROMPT");
  });

  it("lists the removed source in the expunge prompt", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- Engineering/gone.md");
  });

  it("heads the removed note's content block with its raw path", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "### Engineering/gone.md (raw/notes/Engineering/gone.md)",
    );
  });

  it("embeds the removed note's last content in the expunge prompt", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("DISTINCTIVE GONE BODY");
  });

  it("names the wiki index page in the expunge prompt", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- wiki/index.md");
  });

  it("runs a mixed expunge cycle", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("marks a mixed run as expunge mode", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("expunge");
  });

  it("delivers the expunge prompt inside a mixed run", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("EXPUNGE PROMPT");
  });

  it("delivers the incremental prompt inside a mixed expunge run", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("lists the addition a mixed expunge run carries", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("+ Engineering/fresh.md");
  });

  it("lists the removal a mixed expunge run carries", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- Engineering/gone.md");
  });

  it("delivers no incremental prompt when the run removes sources only", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).not.toContain("INCREMENTAL PROMPT");
  });

  it("runs an expunge cycle that also edits a kept source", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "keep.md"),
      "KEEP v2",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "keep.md": entry("KEEP v2") }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("appends the incremental prompt to an expunge run carrying edited sources", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "keep.md": "KEEP" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "keep.md"),
      "KEEP v2",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "keep.md": entry("KEEP v2") }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("runs an expunge cycle that also renames a source", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "old.md": "SAME" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "old.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "new.md"),
      "SAME",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "new.md": entry("SAME") }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("appends the incremental prompt to an expunge run carrying renamed sources", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY", "old.md": "SAME" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "old.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "new.md"),
      "SAME",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "new.md": entry("SAME") }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("labels the expunge digest header with the run timestamp", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain(
      "# Wiki ingest digest (expunge) — 2026-08-20T18:00:00.000Z",
    );
  });

  it("states the expunge mode in the run digest", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain("**Mode:** expunge");
  });

  it("carries the expunge direct set heading in the run digest", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain("## Expunge direct set");
  });

  it("lists the affected wiki page in the run digest's direct set", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain("- wiki/index.md");
  });

  it("treats an equal-hash remove and add pair as a change, not expunge", async () => {
    const h = await makeHarness({ "a.md": "same" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "same",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "b.md": entry("same") })),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("incremental");
  });

  it("names the equal-hash pair as a rename in the incremental prompt", async () => {
    const h = await makeHarness({ "a.md": "same" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "same",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "b.md": entry("same") })),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("runs the cycle after a committed body edit and move", async () => {
    const h = await makeHarness({ "a.md": "old body" });

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("expunges a rename whose committed body edit the snapshot skipped", async () => {
    const h = await makeHarness({ "a.md": "old body" });

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("expunge");
  });

  it("lists the moved note as added when the pair is not renamed", async () => {
    const h = await makeHarness({ "a.md": "old body" });

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("+ Engineering/b.md");
  });

  it("does not render the arrow pair across a committed body edit", async () => {
    const h = await makeHarness({ "a.md": "old body" });

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).not.toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("still pairs a rename whose committed interim edit touched only frontmatter", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged });

    await runWikiIngest(optionsFor(h));

    const dir = join(h.dataRoot, "raw", "notes", "Engineering");

    await writeFile(join(dir, "a.md"), retagged);
    await commitAll(h.dataRoot, "retag note");
    await rm(join(dir, "a.md"));
    await writeFile(join(dir, "b.md"), retagged);
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("treats a frontmatter-only interim edit as an incremental run", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged });

    await runWikiIngest(optionsFor(h));

    const dir = join(h.dataRoot, "raw", "notes", "Engineering");

    await writeFile(join(dir, "a.md"), retagged);
    await commitAll(h.dataRoot, "retag note");
    await rm(join(dir, "a.md"));
    await writeFile(join(dir, "b.md"), retagged);
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("incremental");
  });

  it("pairs the frontmatter-retagged move as a rename", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged });

    await runWikiIngest(optionsFor(h));

    const dir = join(h.dataRoot, "raw", "notes", "Engineering");

    await writeFile(join(dir, "a.md"), retagged);
    await commitAll(h.dataRoot, "retag note");
    await rm(join(dir, "a.md"));
    await writeFile(join(dir, "b.md"), retagged);
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await commitAll(h.dataRoot, "move note");
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("runs the cycle after a frontmatter-only edit during a move", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      retagged,
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("treats a frontmatter-only edit during a move as an incremental run", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      retagged,
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("incremental");
  });

  it("pairs a frontmatter-only edit during a move as a rename", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      retagged,
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("announces the expunge trigger and direct set on the progress sink", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });
    const messages: string[] = [];

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContain(
      "wiki-ingest: expunge — 1 removed source; direct set: wiki/index.md, wiki/overview.md",
    );
  });

  it("pluralizes the preview line for several removed sources", async () => {
    const h = await makeHarness({ "a.md": "A", "b.md": "B" });
    const messages: string[] = [];

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContain(
      "wiki-ingest: expunge — 2 removed sources; direct set: wiki/A-page.md, wiki/concepts/new.md, wiki/index.md, wiki/overview.md, wiki/sources/src.md",
    );
  });

  it("seeds the source page whose origin names the removed note in the prompt", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await mkdir(join(h.dataRoot, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "sources", "gone note.md"),
      "---\ntitle: Gone note\ntype: source\norigin: raw/notes/Engineering/gone.md\n---\nbody",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "origin page",
    ]);
    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "- wiki/sources/gone note.md",
    );
  });

  it("names the origin-linked source page on the progress line", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });
    const messages: string[] = [];

    await mkdir(join(h.dataRoot, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "sources", "gone note.md"),
      "---\ntitle: Gone note\ntype: source\norigin: raw/notes/Engineering/gone.md\n---\nbody",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "origin page",
    ]);
    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages.some((m) => m.includes("wiki/sources/gone note.md"))).toBe(
      true,
    );
  });

  it("passes the injected environment through to the agent", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const env = { KWIKI_TEST: "yes" };
    let seen: NodeJS.ProcessEnv | undefined;
    const recording: AgentRunner = async (_command, _args, options) => {
      seen = options.env;

      return { stdout: "report", stderr: "" };
    };

    await runWikiIngest({ ...optionsFor(h), env, runAgent: recording });

    expect(seen).toBe(env);
  });

  it("does not count a staged wiki rename as a deleted page", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const quiet: AgentRunner = async () => ({
      stdout: "quiet report",
      stderr: "",
    });

    await run("git", [
      "-C",
      h.dataRoot,
      "mv",
      "wiki/A-page.md",
      "wiki/B-page.md",
    ]);

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual([]);
  });

  it("does not count a staged wiki rename as a created page", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const quiet: AgentRunner = async () => ({
      stdout: "quiet report",
      stderr: "",
    });

    await run("git", [
      "-C",
      h.dataRoot,
      "mv",
      "wiki/A-page.md",
      "wiki/B-page.md",
    ]);

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.created).toEqual([]);
  });

  it("does not count a staged wiki rename as an updated page", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const quiet: AgentRunner = async () => ({
      stdout: "quiet report",
      stderr: "",
    });

    await run("git", [
      "-C",
      h.dataRoot,
      "mv",
      "wiki/A-page.md",
      "wiki/B-page.md",
    ]);

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.updated).toEqual([]);
  });

  it("counts an untracked page the run deleted as deleted", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const deleting: AgentRunner = async (_command, _args, options) => {
      await rm(join(options.cwd, "wiki", "concepts", "new.md"));
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "page deleted", stderr: "" };
    };

    const result = await runWikiIngest({
      ...optionsFor(h),
      runAgent: deleting,
    });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual(["wiki/concepts/new.md"]);
  });

  it("does not count a wiki deletion that predates the run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const quiet: AgentRunner = async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "quiet report", stderr: "" };
    };

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "wiki", "A-page.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "a.md"),
      "a2",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual([]);
  });

  it("keeps the underlying read error as cause when the prompt is missing", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await rm(join(h.promptsDir, "ingest.md"));

    let cause: unknown;

    try {
      await runWikiIngest(optionsFor(h));
    } catch (error) {
      cause = (error as Error).cause;
    }

    expect(cause).toBeInstanceOf(Error);
  });

  it("labels the heartbeat line for an expunge run", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h),
      runAgent: slow,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContain("wiki-ingest: expunge agent still running (0s)");
  });

  it("states unavailable content when the removed note has no git history", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    // Rewrite the initial commit without the note: the repo keeps a
    // commit to revert to (guardrails), but no history knows the note.
    await run("git", [
      "-C",
      h.dataRoot,
      "rm",
      "--quiet",
      "--cached",
      "raw/notes/Engineering/gone.md",
    ]);
    await run("git", [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "--amend",
      "--no-edit",
    ]);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("no committed git history");
  });

  it("derives the run's created wiki pages from git status", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.created).toEqual(["wiki/concepts/new.md"]);
  });

  it("derives the run's updated wiki pages from git status", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.updated).toEqual(["wiki/A-page.md", "wiki/index.md"]);
  });

  it("does not report a deleted wiki page as created", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.created).not.toContain("wiki/gone.md");
  });

  it("does not report a deleted wiki page as updated", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.updated).not.toContain("wiki/gone.md");
  });

  it("reports wiki pages the run deleted under their own category", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual(["wiki/gone.md"]);
  });

  it("counts a page deleted by the run even when it was dirty before the run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const deleting: AgentRunner = async (_command, _args, options) => {
      await rm(join(options.cwd, "wiki", "A-page.md"));
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "page deleted", stderr: "" };
    };

    await writeFile(join(h.dataRoot, "wiki", "A-page.md"), "# A page dirty\n");

    const result = await runWikiIngest({
      ...optionsFor(h),
      runAgent: deleting,
    });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toContain("wiki/A-page.md");
  });

  it("lists the run's single-source changed pages in the digest's unverified frontier", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain(
      "- wiki/concepts/new.md (1 source: [[src]])",
    );
  });

  it("writes the digest under outputs/runs with a sortable timestamp", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digestPath).toBe(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
    );
  });

  it("records the mode and prompt in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("**Mode:** full · prompt `prompts/ingest.md`");
  });

  it("records the source counts in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("**Sources:** 1 added");
  });

  it("names the created wiki page in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("wiki/concepts/new.md");
  });

  it("embeds the agent report in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("agent final report");
  });

  it("fails with no commit to revert to when the data repo has no git", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await rm(join(h.dataRoot, ".git"), { recursive: true });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      "no commit to revert to",
    );
  });

  it("runs no agent when the data repo has no git to revert to", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await rm(join(h.dataRoot, ".git"), { recursive: true });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      "no commit to revert to",
    );

    expect(h.invocations).toHaveLength(0);
  });

  it("fails naming the prompt file when it is missing", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await rm(join(h.promptsDir, "ingest.md"));

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      /cannot read prompt at .*ingest\.md/,
    );
  });

  it("runs without an injected clock", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest({
      settingsPath: h.settingsPath,
      rawDir: join(h.dataRoot, "raw"),
      outputsDir: h.outputsDir,
      promptsDir: h.promptsDir,
      runAgent: h.runAgent,
    });

    expect(result.status).toBe("ran");
  });

  it("falls back to the wall clock for the digest timestamp", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest({
      settingsPath: h.settingsPath,
      rawDir: join(h.dataRoot, "raw"),
      outputsDir: h.outputsDir,
      promptsDir: h.promptsDir,
      runAgent: h.runAgent,
    });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digestPath).toMatch(
      /\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/,
    );
  });

  it("reports each pipeline step on the progress sink", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      expect.stringContaining("wiki-ingest: raw dir"),
      expect.stringContaining(
        "wiki-ingest: ignoring outputs/last-ingested-manifest.json",
      ),
      expect.stringContaining("wiki-ingest: ignoring dashboard.html"),
      expect.stringContaining(
        "invoking agent: pi --model GLM-5.2 --thinking high",
      ),
      "wiki-ingest: agent finished",
      "wiki-ingest: guardrails passed",
      expect.stringContaining("wiki-ingest: dashboard refreshed at"),
    ]);
  });

  it("states the isolation state on the invoking-agent progress line", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages.join("\n")).toContain(
      "invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
    );
  });

  it("emits a heartbeat while a slow agent run is in flight", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: slow,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual(
      expect.arrayContaining(["wiki-ingest: agent still running (0s)"]),
    );
  });

  it("formats the heartbeat clock as minutes and padded seconds", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];
    let clock = new Date("2026-08-20T17:58:00.000Z");
    const slow: AgentRunner = async () => {
      clock = new Date(clock.getTime() + 127_000);

      await new Promise((resolve) => setTimeout(resolve, 60));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: slow,
      heartbeatMs: 20,
      now: () => clock,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContain("wiki-ingest: agent still running (2m07s)");
  });

  it("stops the heartbeat when the agent run ends", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];
    const fast: AgentRunner = async () => ({
      stdout: "fast report",
      stderr: "",
    });

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: fast,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      messages.filter((message) => message.includes("still running")),
    ).toEqual([]);
  });

  it("enforces the timeout on the real agent runner", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const sleeper = join(h.dataRoot, "sleep-agent.mjs");

    await writeFile(
      sleeper,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${sleeper}\nmodel: M\nreasoning: low\n`,
    );

    let message = "";

    try {
      await runWikiIngest({
        settingsPath: h.settingsPath,
        rawDir: join(h.dataRoot, "raw"),
        outputsDir: h.outputsDir,
        promptsDir: h.promptsDir,
        timeoutMs: 200,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 1 second$/);
  });

  it("fails with a sync hint when the raw dir has no manifest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await rm(join(h.dataRoot, "raw", "manifest.json"));

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow("sync-vault");
  });

  it("reports an agent failure with its exit code", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1\nstderr tail");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow("code 1");
  });

  it("leaves no snapshot and no digest when the agent fails", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow();

    const { readFile } = await import("node:fs/promises");

    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(
        join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when the digest write fails", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await mkdir(join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"), {
      recursive: true,
    });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow();
  });

  it("leaves no snapshot when the digest write fails", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await mkdir(join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"), {
      recursive: true,
    });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow();

    const { readFile } = await import("node:fs/promises");

    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("runWikiIngest tracked-but-ignored pre-flight (issue #146)", () => {
  /** Track `.obsidian/workspace.json` in the data repo, then add the
   *  ignore rule afterwards — the hazard order from k-wiki-meta-data
   *  commit 72dce82: gitignore does not apply to tracked files. */
  async function trackIgnoredObsidianState(h: Harness): Promise<void> {
    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await commitAll(h.dataRoot, "track obsidian state");
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");
  }

  it("still runs a full ingest over a tracked-but-ignored file", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await trackIgnoredObsidianState(h);

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("warns pre-flight with the untrack fix for a tracked-but-ignored file", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await trackIgnoredObsidianState(h);

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes(".obsidian/workspace.json") &&
          message.includes("git rm --cached .obsidian/workspace.json"),
      ),
    ).toBe(true);
  });

  it("warns once per tracked-but-ignored file", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await writeFile(join(h.dataRoot, ".obsidian", "app.json"), "{}");
    await commitAll(h.dataRoot, "track obsidian state");
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    const warnings = messages.filter((message) => message.includes("WARNING"));

    expect(warnings).toHaveLength(2);
  });

  it("stays silent when no tracked file is ignored", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages.some((message) => message.includes("WARNING"))).toBe(false);
  });

  it("warns for a tracked snapshot after appending its ignore entry", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") })),
    );
    await commitAll(h.dataRoot, "track the snapshot");

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes(
            "git rm --cached outputs/last-ingested-manifest.json",
          ),
      ),
    ).toBe(true);
  });
});

describe("warnTrackedIgnored (issue #146)", () => {
  it("emits no warning and does not throw when git cannot report", async () => {
    const messages: string[] = [];
    const notARepo = await mkdtemp(join(tmpdir(), "k-wiki-not-a-repo-"));

    tempDirs.push(notARepo);

    await warnTrackedIgnored(notARepo, process.env, (message) =>
      messages.push(message),
    );

    expect(messages).toEqual([]);
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

describe("runWikiIngest --sources", () => {
  /** A stamped snapshot for the harness manifest: the corpus is fully
   *  ingested, so the manifest diff is empty and only --sources runs. */
  async function seedSnapshot(
    h: Harness,
    notes: Record<string, string>,
    stamp = h.dataRoot,
  ): Promise<void> {
    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith(
          "Engineering",
          Object.fromEntries(
            Object.entries(notes).map(([path, content]) => [
              path,
              entry(content),
            ]),
          ),
        ),
        { snapshotFor: stamp },
      ),
    );
  }

  it("bypasses the empty-diff skip and runs the agent", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result.status).toBe("ran");
  });

  it("runs a scoped selection in incremental mode", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a", "gone.md": "gone" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("forces the incremental prompt, never full or expunge", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a", "gone.md": "gone" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(invocation(h, 0).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("replaces a manifest diff whose removals would route to expunge", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a", "gone.md": "gone" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result).toMatchObject({
      status: "ran",
      diff: { vaults: [{ vault: "Engineering", changed: ["a.md"] }] },
    });
  });

  it("renders one ~ line per explicit source, deduped", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" });
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/b.md", "Engineering/a.md", "Engineering/b.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(
      ["a.md", "b.md"].map(
        (f) => prompt.split(`~ Engineering/${f}`).length - 1,
      ),
    ).toEqual([1, 1]);
  });

  it("sorts explicit-source ~ lines in manifest order", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" });
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/b.md", "Engineering/a.md", "Engineering/b.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt.indexOf("~ Engineering/a.md")).toBeLessThan(
      prompt.indexOf("~ Engineering/b.md"),
    );
  });

  it("announces changed sources since the previous ingestion", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" });
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/b.md", "Engineering/a.md", "Engineering/b.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("Changed sources since the previous ingestion:");
  });

  it("carries the --note text below the ~ lines under an Operator note heading", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      note: "recovery: file the four pre-adjudicated pages",
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("Operator note:");
    expect(prompt.indexOf("~ Engineering/a.md")).toBeLessThan(
      prompt.indexOf("Operator note:"),
    );
    expect(prompt).toContain("recovery: file the four pre-adjudicated pages");
  });

  it("applies the default operator note when --sources runs without one", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("Operator note:");
    expect(prompt).toContain(
      "Sources re-opened by the operator: unchanged content does not imply a no-op; re-adjudicate filing decisions; if declining, state per concept why its treatment fails the page bar.",
    );
  });

  it("omits the operator note on an ordinary incremental run", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("+ Engineering/b.md");
    expect(prompt).not.toContain("Operator note:");
  });

  it("marks the digest Mode line with sources selected explicitly", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });
    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("sources selected explicitly");
  });

  it("runs the run to a guardrail failure", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("omits the sources-selected marker from an ordinary failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).not.toContain("sources selected explicitly");
  });

  it("lists the explicitly named source in a scoped prompt", async () => {
    const h = await makeHarness({
      "a.md": "a",
      "new.md": "added since snapshot",
    });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("~ Engineering/a.md");
  });

  it("hides manifest changes the explicit list does not name", async () => {
    const h = await makeHarness({
      "a.md": "a",
      "new.md": "added since snapshot",
    });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).not.toContain("new.md");
  });

  it("holds a manifest-only added note out of the merged snapshot", async () => {
    const h = await makeHarness({
      "a.md": "a v2",
      "new.md": "added since snapshot",
    });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const snapshot = parseManifest(
      await readFile(h.snapshotPath, "utf8"),
      h.snapshotPath,
    );

    expect(snapshot.vaults.Engineering?.["new.md"]).toBeUndefined();
    expect(snapshot.vaults.Engineering?.["a.md"]).toEqual(entry("a v2"));
  });

  it("reports the full held-back counts on the progress line", async () => {
    const h = await makeHarness({
      "a.md": "a v2",
      "b.md": "b v2",
      "new.md": "added since snapshot",
    });
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 added, 1 changed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("stays silent when the scoped run covers every pending change", async () => {
    const h = await makeHarness({ "a.md": "a v2", "new.md": "added" });
    await seedSnapshot(h, { "a.md": "a" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md", "Engineering/new.md"],
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBeUndefined();
  });

  it("counts a pending rename outside the sources as held back", async () => {
    const h = await makeHarness({
      "a.md": "a v2",
      "b.md": "b v2",
      "moved.md": "moved",
    });
    await seedSnapshot(h, {
      "a.md": "a",
      "b.md": "b",
      "old.md": "moved",
    });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 changed, 1 renamed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("counts a covered rename's source path as a held-back removal", async () => {
    const h = await makeHarness({ "moved.md": "moved", "b.md": "b v2" });
    await seedSnapshot(h, { "old.md": "moved", "b.md": "b" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/moved.md"],
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 changed, 1 removed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("announces a held-back removal when a covered rename is the only pending change", async () => {
    const h = await makeHarness({ "moved.md": "moved" });
    await seedSnapshot(h, { "old.md": "moved" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/moved.md"],
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 removed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("expunges a covered rename's source path on the next ordinary run", async () => {
    const h = await makeHarness({ "moved.md": "moved" });
    await seedSnapshot(h, { "old.md": "moved" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/moved.md"],
    });

    const snapshot = parseManifest(
      await readFile(h.snapshotPath, "utf8"),
      h.snapshotPath,
    );

    expect(snapshot.vaults.Engineering?.["old.md"]).toBeDefined();
    expect(snapshot.vaults.Engineering?.["moved.md"]).toBeDefined();

    const pending = await runWikiIngest(optionsFor(h));

    expect(pending).toMatchObject({ status: "ran", mode: "expunge" });
  });

  it("counts a pending removal as held back", async () => {
    const h = await makeHarness({ "a.md": "a", "doomed.md": "doomed" });
    await seedSnapshot(h, { "a.md": "a", "doomed.md": "doomed" });
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "doomed.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") })),
    );
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      onProgress: (message) => messages.push(message),
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 removed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("keeps a pending removal in the merged snapshot for the next expunge run", async () => {
    const h = await makeHarness({ "a.md": "a", "doomed.md": "doomed" });
    await seedSnapshot(h, { "a.md": "a", "doomed.md": "doomed" });

    // A sync removed the note: raw file gone, manifest updated, the
    // snapshot (and the expunge it routes to) still ahead.
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "doomed.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") })),
    );

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const snapshot = parseManifest(
      await readFile(h.snapshotPath, "utf8"),
      h.snapshotPath,
    );

    expect(snapshot.vaults.Engineering?.["doomed.md"]).toBeDefined();

    const pending = await runWikiIngest(optionsFor(h));

    expect(pending).toMatchObject({ status: "ran", mode: "expunge" });
  });

  it("still ingests manifest changes pending behind a scoped run", async () => {
    const h = await makeHarness({
      "a.md": "a",
      "new.md": "added since snapshot",
    });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const pending = await runWikiIngest(optionsFor(h));

    expect(pending.status).toBe("ran");
  });

  it("pairs the pending manifest change into the follow-up prompt", async () => {
    const h = await makeHarness({
      "a.md": "a",
      "new.md": "added since snapshot",
    });
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("+ Engineering/new.md");
  });

  it("rejects unknown paths naming every path joined with a comma", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/nope.md", "Engineering/also-missing.md"],
      }),
    ).rejects.toThrow(
      "unknown --sources path(s): Engineering/nope.md, Engineering/also-missing.md",
    );
  });

  it("treats an empty --sources array as absent and runs the manifest diff", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const result = await runWikiIngest({ ...optionsFor(h), sources: [] });

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("records sources selected explicitly on the failure digest of a reverted scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("sources selected explicitly");
  });

  it("rejects --sources when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({ ...optionsFor(h), sources: ["Engineering/a.md"] }),
    ).rejects.toThrow(/run a full ingest first/);
  });

  it("rejects --sources on a foreign-stamped snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" }, "/foreign/data-root");

    await expect(
      runWikiIngest({ ...optionsFor(h), sources: ["Engineering/a.md"] }),
    ).rejects.toThrow(/run a full ingest first/);
  });

  it("promises no full-run fallback in the foreign-snapshot warning of a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" }, "/foreign/data-root");
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      onProgress: (message) => messages.push(message),
    }).catch(() => undefined);

    expect(
      messages.some((message) =>
        message.includes("falling back to a full run"),
      ),
    ).toBe(false);
  });

  it("ends the scoped foreign-snapshot warning at the ignore clause", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" }, "/foreign/data-root");
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      onProgress: (message) => messages.push(message),
    }).catch(() => undefined);

    const warning = messages.find((message) => message.includes("WARNING"));

    expect(warning?.endsWith("ignoring it")).toBe(true);
  });

  it("completes a successful scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result.status).toBe("ran");
  });

  it("rewrites the snapshot idempotently when it matches the manifest", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });
    const before = await readFile(h.snapshotPath, "utf8");

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(await readFile(h.snapshotPath, "utf8")).toBe(before);
  });

  it("propagates the failing scoped agent error", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 1");
  });

  it("leaves the snapshot untouched when the scoped agent run fails", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });
    const before = await readFile(h.snapshotPath, "utf8");
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 1");

    expect(await readFile(h.snapshotPath, "utf8")).toBe(before);
  });

  it("surfaces the guardrail failure on a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("auto-reverts the offending page when a guardrail trips on a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(h.dataRoot, "wiki", "bad.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the snapshot when a guardrail trips on a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    await seedSnapshot(h, { "a.md": "a" });
    const before = await readFile(h.snapshotPath, "utf8");

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    expect(await readFile(h.snapshotPath, "utf8")).toBe(before);
  });
});

describe("runWikiIngest guardrails", () => {
  const digestPath = (h: Harness) =>
    join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md");

  it("completes a clean run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("keeps the agent's changes on a clean run", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const page = await readFile(
      join(h.dataRoot, "wiki", "concepts", "new.md"),
      "utf8",
    );

    expect(page).toContain("New");
  });

  it("reverts and fails the run when a changed page has broken frontmatter", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("removes the offending page when the frontmatter guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(h.dataRoot, "wiki", "bad.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no snapshot when the frontmatter guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails the run when the frontmatter guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();
  });

  it("writes a failure digest naming the tripped check", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("Check 2 (frontmatter)");
  });

  it("names the offending page in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("wiki/bad.md");
  });

  it("embeds the agent report in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("rogue report");
  });

  it("reverts and fails the run when the agent writes outside the whitelist", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "raw", "notes"), { recursive: true });
      await writeFile(join(options.cwd, "raw", "notes", "rogue.md"), "x\n");

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 1 (immutability)");
    await expect(
      readFile(join(h.dataRoot, "raw", "notes", "rogue.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reverts raw tampering even when the agent fails", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "raw", "notes"), { recursive: true });
      await writeFile(join(options.cwd, "raw", "notes", "rogue.md"), "x\n");

      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 1 (immutability)");
    await expect(
      readFile(join(h.dataRoot, "raw", "notes", "rogue.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps valid changes when the agent fails and guardrails pass", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const failing: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "ok.md"), wikiPage("Kept"));

      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow("code 1");
    expect(await readFile(join(h.dataRoot, "wiki", "ok.md"), "utf8")).toContain(
      "Kept",
    );
  });

  it("reverts and fails the run when a changed page leaves a dangling wikilink", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "dangling.md"),
        wikiPage("See [[Nowhere]]."),
      );

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 3 (wikilinks)");
    await expect(
      readFile(join(h.dataRoot, "wiki", "dangling.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks a wiki page that was already dirty before the run", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(
      join(h.dataRoot, "wiki", "index.md"),
      wikiPage("# Index v2"),
    );

    const saboteur: AgentRunner = async () => {
      await writeFile(
        join(h.dataRoot, "wiki", "index.md"),
        "still dirty, now broken\n",
      );

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });
});

describe("runGit reuse sanity", () => {
  it("reports an untracked wiki file in git status", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");
    await mkdir(join(dataRoot, "wiki", "concepts"));
    await writeFile(join(dataRoot, "wiki", "concepts", "x.md"), "x");

    const { stdout } = await runGit(
      dataRoot,
      ["status", "--porcelain", "-uall", "--", "wiki"],
      process.env,
    );
    const lines = stdout.split("\n").filter(Boolean);

    expect(lines).toContain("?? wiki/concepts/x.md");
  });

  it("reports a modified wiki page in git status", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");

    const { stdout } = await runGit(
      dataRoot,
      ["status", "--porcelain", "-uall", "--", "wiki"],
      process.env,
    );
    const lines = stdout.split("\n").filter(Boolean);

    expect(lines).toContain(" M wiki/index.md");
  });
});

describe("wiki-ingest CLI", () => {
  const STUB = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Guard: a mutated wrapper may redirect this stub into the real data
// repo; refuse to write anywhere but this harness's data root.
if (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);
const index = process.argv.indexOf("--print");
await mkdir(join(process.cwd(), "outputs"), { recursive: true });
await writeFile(join(process.cwd(), "outputs", "stub-prompt.txt"), process.argv[index + 1] ?? "");
await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "concepts", "stub.md"), [
  "---",
  'title: "Stub"',
  "type: concept",
  "created: 2026-08-20",
  "updated: 2026-08-20",
  "tags:",
  "  - llm",
  "sources:",
  '  - "[[src]]"',
  "---",
  "",
  "stub body",
  "",
].join("\\n"));
console.log("stub report");
`;

  /** A harness whose settings point at an executable stub agent. */
  async function makeCliHarness(): Promise<Harness> {
    const h = await makeHarness({ "a.md": "a" });
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
    await writeFile(stub, STUB, { mode: 0o755 });
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    return h;
  }

  function cliArgs(h: Harness): string[] {
    return [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];
  }

  async function runCli(args: string[]): Promise<{ out: string; err: string }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), ...args];
    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [--note <text>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the --settings switch in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--settings");
  });

  it("documents the --outputs switch in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--outputs");
  });

  it("documents the <raw-dir> positional in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("<raw-dir>");
  });

  it("documents the switch defaults in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("Default");
  });

  it("documents --sources with the <vault/path> syntax", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--sources <vault/path>");
  });

  it("documents the exact-path rule for --sources", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("exact manifest paths");
  });

  it("documents the snapshot precondition of --sources", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("run a full ingest first");
  });

  it("documents --note with the <text> syntax", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--note <text>");
  });

  it("documents the --note default line and scoped-only rule", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("does not imply a no-op");
    expect(out).toContain("requires --sources");
  });

  it("parses a repeatable --sources flag and dedupes it", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/a.md",
      "--sources",
      "Engineering/a.md",
    ]);

    const prompt = await readFile(
      join(h.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt.split("~ Engineering/a.md").length - 1).toBe(1);
  });

  it("carries a --note into the scoped prompt", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/a.md",
      "--note",
      "recovery: re-adjudicate the four pages",
    ]);

    const prompt = await readFile(
      join(h.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Operator note:");
    expect(prompt).toContain("recovery: re-adjudicate the four pages");
  });

  it("applies the default operator note on a scoped CLI run without --note", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([...cliArgs(h), "--sources", "Engineering/a.md"]);

    const prompt = await readFile(
      join(h.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Operator note:");
    expect(prompt).toContain("Sources re-opened by the operator");
    expect(prompt).toContain("re-adjudicate filing decisions");
  });

  it("exits 1 when --note has no value", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--note"]);

    expect(err).toContain("--note needs a value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --note has a blank value", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--note", ""]);

    expect(err).toContain("--note needs a value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --note runs without --sources", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--note", "intent"]);

    expect(err).toContain("--note requires --sources");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 on an unknown --sources path naming the path", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    const { err } = await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/nope.md",
    ]);

    expect(err).toContain("unknown --sources path(s): Engineering/nope.md");
  });

  it("sets exit code 1 for an unknown --sources path", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([...cliArgs(h), "--sources", "Engineering/nope.md"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 on --sources with no snapshot and says to run a full ingest first", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/a.md",
    ]);

    expect(err).toContain("run a full ingest first");
  });

  it("sets exit code 1 when --sources has no snapshot", async () => {
    const h = await makeCliHarness();

    await runCli([...cliArgs(h), "--sources", "Engineering/a.md"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --sources has no value", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--sources"]);

    expect(err).toContain("--sources needs a path value");
  });

  it("sets exit code 1 when --sources has no value", async () => {
    const h = await makeCliHarness();

    await runCli([...cliArgs(h), "--sources"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "/no/such/raw-dir"]);

    expect(out).toContain("Usage: wiki-ingest");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 with a stderr message when settings cannot be read", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("sets exit code 1 when settings cannot be read", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("runs the stub agent end to end and prints the digest", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
  });

  it("prints the created and updated page counts in the digest", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("**Wiki pages:** 1 created, 0 updated, 0 deleted");
  });

  it("announces the full ingest mode on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toContain("wiki-ingest: mode full, invoking agent");
  });

  it("leaves the exit code unset after a successful end-to-end run", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the skip line for a second run with no changes", async () => {
    const h = await makeCliHarness();
    const args = [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];

    await runCli(args);

    const { out } = await runCli(args);

    expect(out).toBe(
      "wiki-ingest: no changed sources since the last ingest; nothing to do",
    );
  });

  it("leaves the exit code unset for a no-change second run", async () => {
    const h = await makeCliHarness();
    const args = [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];

    await runCli(args);
    await runCli(args);

    expect(process.exitCode).toBeUndefined();
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1800",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
  });

  it("leaves the exit code unset when --timeout is accepted", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1800",
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("converts --timeout seconds to the agent deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "slow-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('slow but fine');\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "5",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("slow but fine");
  });

  it("leaves the exit code unset when the agent finishes under the deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "slow-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('slow but fine');\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "5",
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stalled-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toMatch(/timed out after 1 second/);
  });

  it("sets exit code 1 when a stalled agent is killed at the deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stalled-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--bogus"]);

    expect(err).toContain("wiki-ingest: unknown option");
  });

  it("sets exit code 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--bogus"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints no color codes under NO_COLOR", async () => {
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { err } = await runCli(["--bogus"]);

      expect(err).not.toContain("\u001b[");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("exits 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(err).toContain("needs a path value");
  });

  it("sets exit code 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "one", "two"]);

    expect(err).toContain("expected at most one <raw-dir>");
  });

  it("sets exit code 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "one", "two"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --outputs without a value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      join(h.dataRoot, "raw"),
      "--outputs",
    ]);

    expect(err).toContain("--outputs needs a path value");
  });

  it("sets exit code 1 for --outputs without a value", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      join(h.dataRoot, "raw"),
      "--outputs",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("documents the --timeout switch and its default in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--timeout <secs>");
  });

  it("documents the --timeout default of 1800 seconds in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("1800");
  });

  it("exits 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "0"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "0"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "-5"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "-5"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "abc"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "abc"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "5x"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "5x"]);

    expect(process.exitCode).toBe(1);
  });

  it("writes the run digest into the --outputs directory it was given", async () => {
    const h = await makeCliHarness();
    const runsDir = join(h.outputsDir, "runs");
    const before = await runFiles(runsDir);

    await runCli(cliArgs(h));

    const after = await runFiles(runsDir);

    expect(after.length).toBe(before.length + 1);
  });

  it("defaults --outputs to the repo's outputs directory", async () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const runsDir = join(repoRoot, "outputs", "runs");
    const before = await runFiles(runsDir);
    const h = await makeCliHarness();

    await runCli(["--settings", h.settingsPath, join(h.dataRoot, "raw")]);

    const after = await runFiles(runsDir);

    expect(after.length).toBeGreaterThan(before.length);
  });

  it("defaults --settings to the repo settings.yml", async () => {
    const noManifest = await mkdtemp(join(tmpdir(), "k-wiki-nomanifest-"));

    tempDirs.push(noManifest);

    const { err } = await runCli([join(noManifest, "raw")]);

    expect(err).toContain("no manifest at");
  });

  it("renders progress straight to stderr when stderr is a TTY", async () => {
    const h = await makeCliHarness();
    const priorTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const priorNoColor = process.env.NO_COLOR;
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    delete process.env.NO_COLOR;

    let raw = "";

    try {
      await runCli(cliArgs(h));
      raw = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      writeSpy.mockRestore();
      restoreStderrTty(priorTty);
      restoreNoColor(priorNoColor);
    }

    expect(raw).toContain("wiki-ingest: raw dir");
  });

  it("keeps progress off the raw stderr writer under NO_COLOR on a TTY", async () => {
    const h = await makeCliHarness();
    const priorTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const priorNoColor = process.env.NO_COLOR;
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    process.env.NO_COLOR = "1";

    let captured: { out: string; err: string };
    let raw = "";

    try {
      captured = await runCli(cliArgs(h));
      raw = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      writeSpy.mockRestore();
      restoreStderrTty(priorTty);
      restoreNoColor(priorNoColor);
    }

    expect({
      errHasRender: captured.err.includes("wiki-ingest: raw dir"),
      rawHasRender: raw.includes("wiki-ingest: raw dir"),
    }).toEqual({ errHasRender: true, rawHasRender: false });
  });
});

describe("formatDigest structure", () => {
  it("separates the guardrails-failed heading with blank lines", () => {
    const digest = formatDigest(
      digestRun({
        guardrailFailure: {
          check: 1,
          name: "immutability",
          problems: ["raw/x changed by the run"],
        },
      }),
    );

    expect(digest).toContain("\n## Guardrails failed\n");
  });

  it("states that the run was auto-reverted in the guardrails failure", () => {
    const digest = formatDigest(
      digestRun({
        guardrailFailure: {
          check: 1,
          name: "immutability",
          problems: ["raw/x changed by the run"],
        },
      }),
    );

    expect(digest).toContain(
      "tripped; the run was auto-reverted to the pre-run commit.",
    );
  });

  it("renders the exact guardrails-failed block with its blank-line separators", () => {
    const digest = formatDigest(
      digestRun({
        guardrailFailure: {
          check: 2,
          name: "frontmatter",
          problems: ["wiki/bad.md: no frontmatter block"],
        },
      }),
    );

    expect(digest).toContain(
      "\n\n## Guardrails failed\n\nCheck 2 (frontmatter) tripped; the run was auto-reverted to the pre-run commit.\n\n- wiki/bad.md: no frontmatter block\n",
    );
  });

  it("separates the changed-sources heading with blank lines", () => {
    expect(formatDigest(digestRun())).toContain(
      "\n\n## Changed sources\n\n**Engineering**",
    );
  });

  it("ends with a newline", () => {
    expect(formatDigest(digestRun()).endsWith("\n")).toBe(true);
  });
});

describe("runWikiIngest failure reporting detail", () => {
  it("names the check, the revert target, and the problems in the error", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("formats the guardrail error message with the revert target", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toMatch(
      /^guardrail check 2 \(frontmatter\) failed; run reverted to [0-9a-f]{8} — wiki\/bad\.md: no frontmatter block$/,
    );
  });

  it("leaves the cause unset for a guardrail failure", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).cause).toBeUndefined();
  });

  it("reports the guardrail failure on progress", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const progress: string[] = [];

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
        onProgress: (message) => progress.push(message),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    expect(progress.join("\n")).toMatch(
      /^wiki-ingest: guardrail check 2 \(frontmatter\) failed — reverting to [0-9a-f]{8}$/m,
    );
  });

  it("joins multiple guardrail problems with a semicolon in the error", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad-1.md", "bad-2.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toContain(
      "wiki/bad-1.md: no frontmatter block; wiki/bad-2.md: no frontmatter block",
    );
  });

  it("keeps the agent error as the cause when the guardrails also fail", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "raw", "notes"), { recursive: true });
      await writeFile(join(options.cwd, "raw", "notes", "rogue.md"), "x\n");

      throw new Error("agent exited with code 1");
    };

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: saboteur,
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      cause: { message: "agent exited with code 1" },
    });
  });

  it("rejects the run when the agent sabotages the frontmatter", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();
  });

  it("states the mode in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("**Mode:** full");
  });

  it("names the prompt file in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("prompt `prompts/ingest.md`");
  });

  it("reports the wiki pages as unavailable in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain(
      "**Wiki pages:** unavailable — run reverted — guardrail check 2 (frontmatter) tripped",
    );
  });

  it("announces a kept-changes agent failure on progress", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const progress: string[] = [];
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 9");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: failing,
        onProgress: (message) => progress.push(message),
      }),
    ).rejects.toThrow("agent exited with code 9");

    expect(progress).toContain(
      "wiki-ingest: agent failed — guardrails passed, changes kept",
    );
  });

  it("rejects a kept-changes agent failure with the agent error", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 9");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 9");
  });
});

describe("error causes and sink prefixes", () => {
  it("rejects settings loading with an Error", async () => {
    const error = await loadAgentSettings("/no/such/settings.yml").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("attaches the read error as the cause of a settings failure", async () => {
    const error = await loadAgentSettings("/no/such/settings.yml").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("rejects prompt loading with an Error", async () => {
    const error = await readPrompt("/no/such/prompt.md").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("attaches the read error as the cause of a prompt failure", async () => {
    const error = await readPrompt("/no/such/prompt.md").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("animates any of several heartbeat prefixes", () => {
    const written: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      () => {},
      true,
      { dim: (text) => text, yellow: (text) => text },
      ["first-prefix:", "second-prefix:"],
    );

    sink.render("second-prefix: still running (1m)");

    expect(written).toEqual(["\r⠋ second-prefix: still running (1m)"]);
  });

  it("animates a single string heartbeat prefix", () => {
    const written: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      () => {},
      true,
      { dim: (text) => text, yellow: (text) => text },
      "pfx:",
    );

    sink.render("pfx: agent still running (0s)");

    expect(written).toEqual(["\r⠋ pfx: agent still running (0s)"]);
  });
});

describe("runWikiIngest dashboard hook (issue #73)", () => {
  it("regenerates the dashboard after a successful run", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("renders the dashboard as an HTML document after a successful run", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("marks the regenerated dashboard as generated", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html).toContain("generated");
  });

  it("rejects the run when a guardrail trips and a stale dashboard exists", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(join(h.dataRoot, "dashboard.html"), "STALE\n");

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("leaves a stale dashboard untouched when a guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(join(h.dataRoot, "dashboard.html"), "STALE\n");

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      () => undefined,
    );

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html).toBe("STALE\n");
  });

  it("adds dashboard.html to the data repo gitignore", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const gitignore = await readFile(join(h.dataRoot, ".gitignore"), "utf8");

    expect(gitignore.split("\n")).toContain("dashboard.html");
  });

  it("keeps the run successful when the dashboard refresh fails", async () => {
    const h = await makeHarness({ "a.md": "a" });

    // A directory at the output path makes the write fail; the run
    // itself must stay successful (the dashboard is derived).
    await mkdir(join(h.dataRoot, "dashboard.html"));

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("stamps the regenerated dashboard with the run's clock", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      now: () => new Date("2031-03-04T05:06:07.000Z"),
    });

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html).toContain("generated 2031-03-04 05:06 UTC");
  });

  it("warns on the progress sink when the dashboard refresh fails", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const progress: string[] = [];

    await mkdir(join(h.dataRoot, "dashboard.html"));
    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(progress.join("\n")).toContain("dashboard refresh failed");
  });
});

describe("wikiPages vanished untracked detection", () => {
  it("counts only vanished untracked markdown pages as deleted, in sorted order", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

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

    const pages = await wikiPages(dataRoot, process.env, "wiki", pre);

    expect(pages.deleted).toEqual(["wiki/a.md", "wiki/z.md"]);
  });

  it("lists created and updated pages in sorted order with no stray entries", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await writeFile(join(dataRoot, "wiki", "z.md"), "# Z\n");
    await writeFile(join(dataRoot, "wiki", "a.md"), "# A\n");
    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index changed\n");

    const pages = await wikiPages(dataRoot, process.env);

    expect(pages.created).toEqual(["wiki/a.md", "wiki/z.md"]);
    expect(pages.updated).toEqual(["wiki/index.md"]);
  });

  it("counts a staged rename's target as created and its origin as deleted", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await run("git", [
      "-C",
      dataRoot,
      "mv",
      "wiki/index.md",
      "wiki/renamed.md",
    ]);

    const pages = await wikiPages(dataRoot, process.env);

    expect(pages.created).toEqual(["wiki/renamed.md"]);
    expect(pages.updated).toEqual([]);
    expect(pages.deleted).toEqual(["wiki/index.md"]);
  });

  it("counts a rename staged before the run nowhere when a pre-run state is given", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

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

    const pages = await wikiPages(dataRoot, process.env, "wiki", pre);

    expect(pages.created).toEqual([]);
    expect(pages.updated).toEqual([]);
    expect(pages.deleted).toEqual([]);
  });

  it("reports git as unavailable outside a repository instead of throwing", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" });

    await rm(join(dataRoot, ".git"), { recursive: true });

    const pages = await wikiPages(dataRoot, process.env);

    expect(pages.unavailable).toMatch(/not a git repository/);
  });
});

describe("gitignore guard progress", () => {
  it("reports the manifest ignore entry the run appended", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];
    const options = {
      ...optionsFor(h),
      onProgress: (m: string) => messages.push(m),
    };

    await runWikiIngest(options);

    expect(
      messages.some((m) =>
        m.includes("ignoring outputs/last-ingested-manifest.json"),
      ),
    ).toBe(true);
  });

  it("reports the dashboard ignore entry the run appended", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];
    const options = {
      ...optionsFor(h),
      onProgress: (m: string) => messages.push(m),
    };

    await runWikiIngest(options);

    expect(messages.some((m) => m.includes("ignoring dashboard.html"))).toBe(
      true,
    );
  });

  it("stays silent about entries a previous run already appended", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const messages: string[] = [];
    const options = {
      ...optionsFor(h),
      onProgress: (m: string) => messages.push(m),
    };

    await runWikiIngest(options);

    expect(messages.some((m) => m.includes("ignoring dashboard.html"))).toBe(
      false,
    );
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
