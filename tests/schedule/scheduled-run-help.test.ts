import { describe, expect, it } from "vitest";
import { HELP } from "../../src/schedule/scheduled-run-help.ts";

describe("scheduled-run help", () => {
  it("documents the shared-writer delegation and its no-push rule", () => {
    expect(HELP).toContain("shared-writer");
    expect(HELP).toContain("no pull, no push");
  });

  it("documents that a scheduled run can never confirm removals", () => {
    expect(HELP).toContain("--removal-receipt");
    expect(HELP).toContain("never expunges");
  });

  it("keeps the local overlap and push-rejection documentation", () => {
    expect(HELP).toContain("gets one pull --rebase + retry");
    expect(HELP).toContain("KWIKI_SCHEDULED_LOG overrides");
  });

  it("stays self-sufficient: no document or section citations", () => {
    expect(HELP).not.toMatch(/§\d/);
    expect(HELP).not.toContain("docs/");
    expect(HELP).not.toContain("README");
  });
});
