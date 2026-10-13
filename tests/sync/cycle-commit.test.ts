import { describe, expect, it } from "vitest";
import { formatCommitMessage } from "../../src/sync/cycle-commit.ts";

describe("formatCommitMessage", () => {
  it("pluralizes sources and pages", () => {
    const message = formatCommitMessage({
      sourcesCount: 2,
      sourcesLine: "1 added, 1 changed, 0 removed",
      pagesCreated: 3,
      pagesUpdated: 0,
      lintReport: undefined,
    });

    expect(message.split("\n")[0]).toBe(
      "wiki-sync: 2 sources processed, 3 pages touched",
    );
  });

  it("omits the lint line when no report was written", () => {
    const message = formatCommitMessage({
      sourcesCount: 1,
      sourcesLine: "1 added, 0 changed, 0 removed",
      pagesCreated: 0,
      pagesUpdated: 1,
      lintReport: undefined,
    });

    expect(message).not.toContain("lint:");
  });

  it("names the lint report the cycle wrote", () => {
    const message = formatCommitMessage({
      sourcesCount: 1,
      sourcesLine: "1 added, 0 changed, 0 removed",
      pagesCreated: 1,
      pagesUpdated: 0,
      lintReport: "outputs/lint-2026-08-20.md",
    });

    expect(message).toContain("- lint: outputs/lint-2026-08-20.md");
  });
});
