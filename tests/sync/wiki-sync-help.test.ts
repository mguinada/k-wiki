import { describe, expect, it } from "vitest";
import { HELP } from "../../src/sync/wiki-sync-help.ts";

describe("wiki-sync help", () => {
  it("documents the removal-receipt switch", () => {
    expect(HELP).toContain("--removal-receipt <path>");
  });

  it("documents shared-writer mode's lease behavior", () => {
    expect(HELP).toContain("shared-writer");
    expect(HELP).toContain("remote lease");
    expect(HELP).toContain("enable-shared-writer");
  });

  it("stays self-sufficient: no document or section citations", () => {
    expect(HELP).not.toMatch(/§\d/);
    expect(HELP).not.toContain("docs/");
    expect(HELP).not.toContain("README");
  });
});
