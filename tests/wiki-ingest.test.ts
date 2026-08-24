import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createColors } from "picocolors";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../src/data/init-data-repo.ts";
import {
  type AgentRunner,
  type AgentSettings,
  composeExpungePrompt,
  composePrompt,
  createAgentProgressSink,
  diffManifests,
  directSetForRemovals,
  formatDigest,
  type IngestRun,
  loadAgentSettings,
  main,
  parseSettings,
  readPrompt,
  removedNoteContent,
  runWikiIngest,
  spawnAgent,
} from "../src/ingest/wiki-ingest.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  serializeManifest,
  type VaultNotes,
} from "../src/sync/manifest.ts";

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
});

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

describe("parseSettings", () => {
  it("parses the command, model, and reasoning scalars", () => {
    expect(parseSettings(SETTINGS_YML, "settings.yml")).toEqual({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
      provider: undefined,
    });
  });

  it("parses an optional provider setting", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nprovider: zai\nreasoning: h\n",
      "s",
    );

    expect(settings.provider).toBe("zai");
  });

  it("unquotes single-quoted values", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: 'high'\n",
      "s",
    );

    expect(settings.reasoning).toBe("high");
  });

  it("accepts an indented comment line", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n  # indented note\n",
      "s",
    );

    expect(settings.model).toBe("m");
  });

  it("accepts a whitespace-only line", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n   \n",
      "s",
    );

    expect(settings.command).toBe("pi");
  });

  it("accepts a space between key and colon", () => {
    const settings = parseSettings(
      "command : pi\nmodel: m\nreasoning: h\n",
      "s",
    );

    expect(settings.command).toBe("pi");
  });

  it("parses a bracketed secondBrain.domains list", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: [~/Lab/k-wiki-data/wiki, ~/Lab/other/wiki]\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual([
      "~/Lab/k-wiki-data/wiki",
      "~/Lab/other/wiki",
    ]);
  });

  it("parses an unbracketed secondBrain.domains list of one dir", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: ~/Lab/k-wiki-data/wiki\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual(["~/Lab/k-wiki-data/wiki"]);
  });

  it("unquotes secondBrain.domains items", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: [\"/a/wiki\", '/b/wiki']\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual(["/a/wiki", "/b/wiki"]);
  });

  it("rejects an empty secondBrain.domains list", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: []\n",
        "s",
      ),
    ).toThrow(
      'invalid agent settings at s: setting "secondBrain.domains" needs at least one wiki dir',
    );
  });

  it("keeps brackets inside a domain path", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: /opt/[d]/wiki\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual(["/opt/[d]/wiki"]);
  });

  it("rejects a duplicate secondBrain.domains key", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: /a/wiki\nsecondBrain.domains: /b/wiki\n",
        "s",
      ),
    ).toThrow('duplicate setting "secondBrain.domains"');
  });

  it("rejects an unknown key", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: high\nextra: x\n", "s"),
    ).toThrow('invalid agent settings at s: unknown setting "extra"');
  });

  it("reports a one-character key as unknown, not malformed", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: h\nx: v\n", "s"),
    ).toThrow('invalid agent settings at s: unknown setting "x"');
  });

  it("rejects a missing required key", () => {
    expect(() => parseSettings("command: pi\nreasoning: high\n", "s")).toThrow(
      'invalid agent settings at s: missing setting "model"',
    );
  });

  it("rejects a missing command key", () => {
    expect(() => parseSettings("model: m\nreasoning: h\n", "s")).toThrow(
      'missing setting "command"',
    );
  });

  it("rejects a missing reasoning key", () => {
    expect(() => parseSettings("command: pi\nmodel: m\n", "s")).toThrow(
      'missing setting "reasoning"',
    );
  });

  it("rejects an empty value", () => {
    expect(() =>
      parseSettings("command:\nmodel: m\nreasoning: h\n", "s"),
    ).toThrow('setting "command" needs a value');
  });

  it("rejects nested (indented) lines", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\n  nested: true\n",
        "s",
      ),
    ).toThrow("nested values are not supported");
  });

  it("rejects duplicate keys", () => {
    expect(() =>
      parseSettings("command: pi\ncommand: pi\nmodel: m\nreasoning: h\n", "s"),
    ).toThrow('duplicate setting "command"');
  });

  it("rejects a line without a colon separator", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: high\nbroken\n", "s"),
    ).toThrow("expected `key: value`");
  });

  it("names the settings file in every error", () => {
    expect(() => parseSettings("command: pi\n", "my-settings.yml")).toThrow(
      "my-settings.yml",
    );
  });
});

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

  it("treats a vault present only in current as fully added", () => {
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

  it("does not pair a remove and add across different vaults", () => {
    const diff = diffManifests(
      manifestWith("One", { "a.md": entry("same") }),
      manifestWith("Two", { "a.md": entry("same") }),
    );

    expect(diff.vaults).toHaveLength(2);
    expect(diff.vaults[0]).toMatchObject({ vault: "One", removed: ["a.md"] });
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

describe("loadAgentSettings", () => {
  it("fails naming the file when it cannot be read", async () => {
    await expect(loadAgentSettings("/no/such/settings.yml")).rejects.toThrow(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("keeps the underlying read error as the cause", async () => {
    let cause: unknown;

    try {
      await loadAgentSettings("/no/such/settings.yml");
    } catch (error) {
      cause = (error as Error).cause;
    }

    expect(cause).toBeInstanceOf(Error);
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

  it("appends the changed sources to the incremental prompt", () => {
    const composed = composePrompt("PROMPT", diff);

    expect(composed).toContain("Changed sources since the previous ingestion:");
    expect(composed).toContain("+ Engineering/new.md");
    expect(composed).toContain("~ Engineering/old.md");
    expect(composed).toContain("- Engineering/gone.md");
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

  it("embeds the incremental prompt when the run also carries additions", () => {
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
    expect(composed).toContain("+ Engineering/fresh.md");
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
  it("states the agent command, model, and reasoning level", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("`pi`");
    expect(digest).toContain("`GLM-5.2`");
    expect(digest).toContain("`high`");
    expect(digest).not.toContain("provider");
  });

  it("names the provider in the digest when it is set", () => {
    const digest = formatDigest(
      digestRun({
        settings: { ...digestRun().settings, provider: "zai" },
      }),
    );

    expect(digest).toContain("provider `zai`");
  });

  it("opens with the digest heading and run timestamp", () => {
    expect(formatDigest(digestRun())).toContain(
      "# Wiki ingest digest — 2026-08-20T17:30:00.000Z",
    );
  });

  it("states the mode and the prompt file used", () => {
    const digest = formatDigest(
      digestRun({ mode: "full", promptFile: "prompts/ingest.md" }),
    );

    expect(digest).toContain("**Mode:** full");
    expect(digest).toContain("`prompts/ingest.md`");
  });

  it("counts sources added, changed, removed, and renamed", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain(
      "**Sources:** 1 added, 1 changed, 1 removed, 0 renamed",
    );
  });

  it("lists the changed source paths with vault names", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("**Engineering**");
    expect(digest).toContain("- + Engineering/d.md");
    expect(digest).toContain("~ Engineering/a.md");
    expect(digest).toContain("- − Engineering/c.md");
  });

  it("labels the created and updated page lists", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("## Changed sources");
    expect(digest).toContain("## Wiki pages (git diff)");
    expect(digest).toContain("Created:");
    expect(digest).toContain("Updated:");
  });

  it("carries the agent report under its own heading", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("## Agent report");
    expect(digest).toContain("AGENT REPORT");
  });

  it("counts and lists created, updated, and deleted wiki pages", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("**Wiki pages:** 1 created, 2 updated, 1 deleted");
    expect(digest).toContain("- wiki/concepts/new.md");
    expect(digest).toContain("- wiki/index.md");
    expect(digest).toContain("Deleted:");
    expect(digest).toContain("- wiki/gone.md");
  });

  it("embeds the agent report verbatim", () => {
    expect(formatDigest(digestRun())).toContain("AGENT REPORT");
  });

  it("points the reviewer at contradictions and unresolved questions", () => {
    expect(formatDigest(digestRun())).toContain("unresolved questions");
  });

  it("records the guardrail failure when a check tripped", () => {
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
    expect(digest).toContain("Check 2 (frontmatter)");
    expect(digest).toContain("- wiki/bad.md: no frontmatter block");
    expect(digest).toContain("**Wiki pages:** unavailable — run reverted");
  });

  it("notes when the wiki git diff was unavailable", () => {
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
    expect(digest).toContain("unavailable: no git");
  });

  it("changes the reported agent config when the model changes", () => {
    const other = formatDigest(
      digestRun({
        settings: { command: "pi", model: "OTHER-MODEL", reasoning: "high" },
      }),
    );

    expect(other).toContain("`OTHER-MODEL`");
    expect(other).not.toContain("`GLM-5.2`");
  });

  it("counts all sources as added on a full ingest without listing each", () => {
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
    expect(digest).not.toContain("- + Engineering/");
  });

  it("lists renamed sources with an arrow and counts them", () => {
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
    expect(digest).toContain("- wiki/sources/gone.md");
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
    expect(digest).toContain(
      '- wiki/concepts/new.md (1 source: "[[Source A]]")',
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
        "- **Agent:** `pi` · model `GLM-5.2` · reasoning `high`",
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
  await mkdir(join(dataRoot, "wiki"), { recursive: true });

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
    '  - "[[index]]"',
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

/** The recorded invocation at `index`; fails loudly when absent. */
function invocation(h: Harness, index: number) {
  const recorded = h.invocations[index];

  if (recorded === undefined) {
    throw new Error(`agent was not invoked (call ${index})`);
  }

  return recorded;
}

describe("runWikiIngest", () => {
  it("uses the full ingest prompt when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    expect(invocation(h, 0).args.at(-1)).toBe("FULL PROMPT");
  });

  it("invokes the agent in the data repo root", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).cwd).toBe(h.dataRoot);
  });

  it("passes --provider when the setting is present", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("zai");
  });

  it("passes the model and reasoning level from settings as agent flags", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("GLM-5.2");
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
    expect(args).toContain("--print");
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
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n",
    );
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

  it("ignores a foreign snapshot with a loud warning and a full run instead of expunging", async () => {
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

    const result = await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(result).toMatchObject({ status: "ran", mode: "full" });
    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes("is stamped for /foreign/data-root"),
      ),
    ).toBe(true);
  });

  it("treats an unstamped legacy snapshot as foreign: warning plus full run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    const result = await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(result).toMatchObject({ status: "ran", mode: "full" });
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

  it("skips the agent when nothing changed since the snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const messages: string[] = [];
    const first = await runWikiIngest(optionsFor(h));
    const second = await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(first.status).toBe("ran");
    expect(second).toMatchObject({
      status: "skipped",
      reason: "no changed sources since the last ingest; nothing to do",
    });
    expect(messages).toContain(
      "no changed sources since the last ingest; nothing to do",
    );
    expect(h.invocations).toHaveLength(1);
  });

  it("skips the agent when the manifest holds no notes at all", async () => {
    const h = await makeHarness({});
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("skipped");
    expect(h.invocations).toHaveLength(0);
  });

  it("selects the incremental prompt and names the changed source", async () => {
    const h = await makeHarness({ "a.md": "a" });

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
    expect(invocation(h, 1).args.at(-1)).toContain("Engineering/a.md");
  });

  it("routes a removed source to the expunge prompt with its content", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.mode).toBe("expunge");

    const prompt = invocation(h, 1).args.at(-1) ?? "";

    expect(prompt).toContain("EXPUNGE PROMPT");
    expect(prompt).toContain("- Engineering/gone.md");
    expect(prompt).toContain(
      "### Engineering/gone.md (raw/notes/Engineering/gone.md)",
    );
    expect(prompt).toContain("DISTINCTIVE GONE BODY");
    expect(prompt).toContain("- wiki/index.md");
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

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.mode).toBe("expunge");

    const prompt = invocation(h, 1).args.at(-1) ?? "";

    expect(prompt).toContain("EXPUNGE PROMPT");
    expect(prompt).toContain("INCREMENTAL PROMPT");
    expect(prompt).toContain("+ Engineering/fresh.md");
    expect(prompt).toContain("- Engineering/gone.md");
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

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
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

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("digests an expunge run with the mode label and direct set", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" });

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.digest).toContain(
      "# Wiki ingest digest (expunge) — 2026-08-20T18:00:00.000Z",
    );
    expect(result.digest).toContain("**Mode:** expunge");
    expect(result.digest).toContain("## Expunge direct set");
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

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.mode).toBe("incremental");
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
      "wiki-ingest: expunge — 2 removed sources; direct set: wiki/index.md, wiki/overview.md",
    );
  });

  it("seeds the source page whose origin names the removed note", async () => {
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

    const result = await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(result.status).toBe("ran");

    const prompt = invocation(h, 1).args.at(-1) ?? "";

    expect(prompt).toContain("- wiki/sources/gone note.md");
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

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages.deleted).toEqual([]);
    expect(result.pages.created).toEqual([]);
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

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
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

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
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

  it("derives created and updated wiki pages from git status", async () => {
    const h = await makeHarness({ "a.md": "a" });

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages.created).toEqual(["wiki/concepts/new.md"]);
    expect(result.pages.updated).toEqual(["wiki/A-page.md", "wiki/index.md"]);
  });

  it("reports wiki pages the run deleted under their own category", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages.created).not.toContain("wiki/gone.md");
    expect(result.pages.updated).not.toContain("wiki/gone.md");
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

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages.deleted).toContain("wiki/A-page.md");
  });

  it("lists the run's single-source changed pages in the digest's unverified frontier", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.digest).toContain(
      "- wiki/concepts/new.md (1 source: [[index]])",
    );
  });

  it("writes the digest under outputs/runs with a sortable timestamp", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.digestPath).toBe(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
    );

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("**Mode:** full · prompt `prompts/ingest.md`");
    expect(digest).toContain("**Sources:** 1 added");
    expect(digest).toContain("wiki/concepts/new.md");
    expect(digest).toContain("agent final report");
  });

  it("fails before the agent runs when the data repo has no git to revert to", async () => {
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
      "cannot read prompt",
    );
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

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
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
      expect.stringContaining("wiki-ingest: ignoring outputs/last-ingested-manifest.json"),
      expect.stringContaining(
        "invoking agent: pi --model GLM-5.2 --thinking high",
      ),
      "wiki-ingest: agent finished",
      "wiki-ingest: guardrails passed",
    ]);
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

  it("leaves the snapshot untouched when the digest write fails", async () => {
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

describe("runWikiIngest guardrails", () => {
  const digestPath = (h: Harness) =>
    join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md");

  it("keeps the agent's changes on a clean run", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");

    const page = await readFile(
      join(h.dataRoot, "wiki", "concepts", "new.md"),
      "utf8",
    );

    expect(page).toContain("New");
  });

  it("reverts and fails the run when a changed page has broken frontmatter", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "bad.md"), "no frontmatter\n");

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
    await expect(
      readFile(join(h.dataRoot, "wiki", "bad.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes a failure digest naming the tripped check", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "bad.md"), "no frontmatter\n");

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("Check 2 (frontmatter)");
    expect(digest).toContain("wiki/bad.md");
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

describe("spawnAgent", () => {
  const noOptions = { cwd: tmpdir(), env: process.env };

  it("resolves the captured stdout of a successful child", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "console.log('agent says hi')"],
      noOptions,
    );

    expect(result.stdout).toContain("agent says hi");
  });

  it("rejects naming the exit code of a failing child", async () => {
    await expect(
      spawnAgent(process.execPath, ["-e", "process.exit(7)"], noOptions),
    ).rejects.toThrow("exited with code 7");
  });

  it("rejects when the command cannot start", async () => {
    await expect(
      spawnAgent("no-such-agent-command", [], noOptions),
    ).rejects.toThrow("could not start");
  });

  it("captures stderr of a successful child", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "console.error('noise')"],
      noOptions,
    );

    expect(result.stderr).toContain("noise");
  });

  it("drops the head of a long agent stderr, keeping the end", async () => {
    const filler = "y".repeat(1200);
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        [
          "-e",
          `console.error("HEAD-MARK ${filler} END-MARK"); process.exit(5)`,
        ],
        noOptions,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      `agent exited with code 5: ${"y".repeat(490)} END-MARK`,
    );
  });

  it("kills and fails an agent that exceeds its timeout", async () => {
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          ...noOptions,
          timeoutMs: 150,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 1 second$/);
  });

  it("reports a multi-second timeout in plural", async () => {
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          ...noOptions,
          timeoutMs: 1500,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 2 seconds$/);
  });

  it("kills and fails an agent that floods past the output cap", async () => {
    await expect(
      spawnAgent(
        process.execPath,
        ["-e", "process.stdout.write('z'.repeat(17 * 1024 * 1024))"],
        noOptions,
      ),
    ).rejects.toThrow("killed with SIGKILL");
  });

  it("collects output exactly at the cap without killing", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "process.stdout.write('z'.repeat(16 * 1024 * 1024))"],
      noOptions,
    );

    expect(result.stdout).toHaveLength(16 * 1024 * 1024);
  });

  it("closes the agent stdin instead of leaving an open pipe", async () => {
    const result = await spawnAgent(
      process.execPath,
      [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => console.log('stdin-eof')); process.stdin.on('data', () => {});",
      ],
      noOptions,
    );

    expect(result.stdout).toContain("stdin-eof");
  });
});

describe("createAgentProgressSink", () => {
  const tones = {
    dim: (text: string) => `<${text}>`,
    yellow: (text: string) => `[${text}]`,
  };

  function makeSink(animated: boolean) {
    const written: string[] = [];
    const lines: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      (text) => lines.push(text),
      animated,
      tones,
    );

    return { sink, written, lines };
  }

  it("appends plain lines when not animated", () => {
    const { sink, written, lines } = makeSink(false);

    sink.render("wiki-ingest: agent finished");

    expect(written).toEqual([]);
    expect(lines).toEqual(["<wiki-ingest: agent finished>"]);
  });

  it("renders a WARNING-severity message yellow, not dim, when not animated", () => {
    const { sink, lines } = makeSink(false);

    sink.render("wiki-ingest: WARNING — snapshot is foreign");

    expect(lines).toEqual(["[wiki-ingest: WARNING — snapshot is foreign]"]);
  });

  it("renders a WARNING-severity message yellow on the animated sink", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: WARNING — snapshot is foreign");

    expect(written).toEqual(["[wiki-ingest: WARNING — snapshot is foreign]\n"]);
  });

  it("renders a WARNING-severity message plain under NO_COLOR", () => {
    const lines: string[] = [];
    const sink = createAgentProgressSink(
      () => {},
      (text) => lines.push(text),
      false,
      createColors(false),
    );

    sink.render("wiki-ingest: WARNING — snapshot is foreign");

    expect(lines).toEqual(["wiki-ingest: WARNING — snapshot is foreign"]);
  });

  it("keeps heartbeat messages on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent still running (2m07s)");

    expect(written).toEqual(["\r⠋ <wiki-ingest: agent still running (2m07s)>"]);
  });

  it("scrolls non-heartbeat messages as events on the animated sink", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent finished");

    expect(written).toEqual(["<wiki-ingest: agent finished>\n"]);
  });

  it("clears the animated line on end", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent still running (0s)");
    sink.end();

    expect(written[1]).toMatch(/^\r\s+\r$/);
  });

  it("does nothing on end when not animated", () => {
    const { sink, written, lines } = makeSink(false);

    sink.end();

    expect(written).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("runGit reuse sanity", () => {
  it("reports git status for a wiki change in the temp data repo", async () => {
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
  '  - "[[index]]"',
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
      "wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the switches and defaults in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--settings");
    expect(out).toContain("--outputs");
    expect(out).toContain("<raw-dir>");
    expect(out).toContain("Default");
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
    expect(process.exitCode).toBe(1);
  });

  it("runs the stub agent end to end and prints the digest", async () => {
    const h = await makeCliHarness();
    const { out, err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
    expect(out).toContain("**Wiki pages:** 1 created, 0 updated, 0 deleted");
    expect(err).toContain("wiki-ingest: mode full, invoking agent");
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
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("slow but fine");
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
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--bogus"]);

    expect(err).toContain("unknown option");
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
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "one", "two"]);

    expect(err).toContain("expected at most one <raw-dir>");
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
    expect(process.exitCode).toBe(1);
  });

  it("documents the --timeout switch and its default in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--timeout <secs>");
    expect(out).toContain("1800");
  });

  it("exits 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "0"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "-5"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "abc"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "5x"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
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
    const progress: string[] = [];
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "bad.md"), "no frontmatter\n");

      return { stdout: "rogue report", stderr: "" };
    };

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: saboteur,
      onProgress: (message) => progress.push(message),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^guardrail check 2 \(frontmatter\) failed; run reverted to [0-9a-f]{8} — wiki\/bad\.md: no frontmatter block$/,
    );
    expect((error as Error).cause).toBeUndefined();
    expect(progress.join("\n")).toMatch(
      /^wiki-ingest: guardrail check 2 \(frontmatter\) failed — reverting to [0-9a-f]{8}$/m,
    );
  });

  it("joins multiple guardrail problems with a semicolon in the error", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "bad-1.md"),
        "no frontmatter\n",
      );
      await writeFile(
        join(options.cwd, "wiki", "bad-2.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue report", stderr: "" };
    };

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: saboteur,
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

  it("states the mode and prompt file in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" });
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "bad.md"), "no frontmatter\n");

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("**Mode:** full");
    expect(digest).toContain("prompt `prompts/ingest.md`");
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
});

describe("error causes and sink prefixes", () => {
  it("attaches the read error as the cause of a settings failure", async () => {
    const error = await loadAgentSettings("/no/such/settings.yml").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("attaches the read error as the cause of a prompt failure", async () => {
    const error = await readPrompt("/no/such/prompt.md").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
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
