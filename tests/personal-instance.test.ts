import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const read = (path: string) => readFileSync(`${repoRoot}${path}`, "utf8");

describe("personal instance wiring", () => {
  it("the wiki contract has a Personal Instances section", () => {
    expect(read("wiki/AGENTS.md")).toContain("## Personal Instances");
  });

  it("the contract names the profile layer path", () => {
    expect(read("wiki/AGENTS.md")).toContain("wiki/personal/profile.md");
  });

  it("the contract defines the project, decision, and attempt page types", () => {
    const contract = read("wiki/AGENTS.md");

    expect(contract).toContain("`project`");
    expect(contract).toContain("`decision`");
    expect(contract).toContain("`attempt`");
  });

  it("the contract routes personal instances through check-crosslinks", () => {
    expect(read("wiki/AGENTS.md")).toContain("check-crosslinks");
  });

  it("the contract keeps cross-wiki links one-way", () => {
    const contract = read("wiki/AGENTS.md");
    const section = contract.slice(
      contract.indexOf("### Cross-wiki links"),
      contract.indexOf("### Cross-wiki links") + 600,
    );

    expect(section).toContain("never the\nreverse");
    expect(section).toContain("[[engineering/<page>]]");
  });

  it("the ingest prompt loads the profile at start", () => {
    expect(read("prompts/ingest.md")).toContain(
      "read `wiki/personal/profile.md` before processing",
    );
  });

  it("the incremental prompt loads the profile at start", () => {
    expect(read("prompts/incremental.md")).toContain(
      "read `wiki/personal/profile.md` first",
    );
  });

  it("the query prompt answers trajectory questions from the profile layer", () => {
    const prompt = read("prompts/query.md");

    expect(prompt).toContain("wiki/personal/profile.md");
    expect(prompt).toContain("`attempt`");
  });

  it("the rebuild prompt restores the profile from git", () => {
    expect(read("prompts/rebuild.md")).toContain(
      "restore `wiki/personal/profile.md` from git",
    );
  });

  it("the repo skeleton carries the wiki/personal folder", () => {
    expect(readFileSync(`${repoRoot}wiki/personal/.gitkeep`, "utf8")).toBe("");
  });
});
