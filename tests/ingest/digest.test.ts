import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentSettings } from "../../src/ingest/agent-settings.ts";
import {
  directSetForRemovals,
  formatDigest,
  type IngestRun,
} from "../../src/ingest/digest.ts";
import { diffManifests } from "../../src/ingest/manifest-diff.ts";
import { emptyManifest } from "../../src/sync/manifest.ts";
import { entry, makeExpungeWiki, manifestWith, type Track } from "./harness.ts";

/**
 * digest unit tests (issue #258, moved with the module from
 * wiki-ingest.test.ts): the per-run digest rendering and the
 * deterministic expunge seed.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

const track: Track = (dir) => tempDirs.push(dir);

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
    expect(formatDigest(digestRun())).toContain("+ Engineering/d.md");
  });

  it("lists a changed source path in the digest", () => {
    expect(formatDigest(digestRun())).toContain("~ Engineering/a.md");
  });

  it("lists a removed source path in the digest with the prompt's minus sign", () => {
    expect(formatDigest(digestRun())).toContain("- Engineering/c.md");
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
        "- Engineering/c.md",
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
        "+ Engineering/d.md",
        "~ Engineering/a.md",
        "- Engineering/c.md",
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

describe("directSetForRemovals", () => {
  it("seeds the origin page, citing pages, index, and overview", async () => {
    const wikiRoot = await makeExpungeWiki(track);

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
    const wikiRoot = await makeExpungeWiki(track);

    expect(
      await directSetForRemovals(wikiRoot, ["raw/notes/V/Other/note.md"]),
    ).toEqual(["index.md", "overview.md", "sources/prefixless.md"]);
  });

  it("does not seed a page whose wikilink target is not an origin page", async () => {
    const wikiRoot = await makeExpungeWiki(track);

    expect(
      await directSetForRemovals(wikiRoot, ["raw/notes/V/Scratch/temp.md"]),
    ).not.toContain("concepts/ignore-wikilink.md");
  });

  it("does not strip a raw/ segment from inside an origin path", async () => {
    const wikiRoot = await makeExpungeWiki(track);

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
