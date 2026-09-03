import { describe, expect, it } from "vitest";
import { diffManifests } from "../../src/ingest/manifest-diff.ts";
import {
  composeExpungePrompt,
  composePrompt,
} from "../../src/ingest/prompts.ts";
import { entry, manifestWith } from "./harness.ts";

/**
 * prompts unit tests (issue #258, moved with the module from
 * wiki-ingest.test.ts): the agent message composition per mode.
 */

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
