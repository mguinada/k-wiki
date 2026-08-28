import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/k-wiki.ts";

/**
 * The k-wiki skill (issue #77, renamed with the CLI it documents):
 * guidance for consulting the wiki through the agent-facing k-wiki
 * CLI (issue #76). The skill is guidance only — the CLI's own help
 * is the contract of record — so the one thing that must never
 * drift is the command vocabulary: every `k-wiki <command>` the
 * skill names must exist on the CLI.
 */

const skillPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../.agents/skills/k-wiki/SKILL.md",
);

async function skillText(): Promise<string> {
  return readFile(skillPath, "utf8");
}

describe("k-wiki skill (issue #77)", () => {
  it("exists at the declared path .agents/skills/k-wiki/SKILL.md", async () => {
    await expect(skillText()).resolves.toContain("# ");
  });

  it("names only commands the k-wiki CLI actually offers", async () => {
    const referenced = [...(await skillText()).matchAll(/`k-wiki (\w+)/g)].map(
      (match) => match[1],
    );

    expect(referenced.length).toBeGreaterThan(0);
  });

  it("names no commands outside the k-wiki CLI", async () => {
    const referenced = [...(await skillText()).matchAll(/`k-wiki (\w+)/g)].map(
      (match) => match[1],
    );

    const unknown = referenced.filter(
      (word) => !COMMANDS.includes(word as never),
    );

    expect(unknown).toEqual([]);
  });

  it("carries all five content sections of the #77 spec", async () => {
    const text = await skillText();

    for (const section of [
      "Where",
      "When",
      "How",
      "Trust rules",
      "What it is not",
    ]) {
      expect(text).toMatch(new RegExp(`^## ${section}`, "m"));
    }
  });

  it("states code-is-truth for code tasks", async () => {
    expect(await skillText()).toContain("code is truth");
  });

  it("documents both freshness modes (vault heuristic, repo SHA)", async () => {
    const text = await skillText();

    expect(text).toContain("log.md");
  });

  it("documents the repo SHA freshness mode", async () => {
    const text = await skillText();

    expect(text).toContain("health");
  });

  it("contains no per-project paths", async () => {
    const text = await skillText();

    expect(text).not.toContain("/Users/");
  });

  it("contains no home-relative paths", async () => {
    const text = await skillText();

    expect(text).not.toMatch(/~\/[A-Za-z]/);
  });

  it("documents installation by copy with binding gitignore guidance", async () => {
    const text = await skillText();

    expect(text).toContain("Install");
  });

  it("documents the binding file", async () => {
    const text = await skillText();

    expect(text).toContain(".k-wiki.json");
  });

  it("guides the binding gitignore entry", async () => {
    const text = await skillText();

    expect(text).toMatch(/gitignore/i);
  });
});
