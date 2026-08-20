import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const guide = readFileSync(
  `${repoRoot}making-of/karpathy_obsidian_wiki_implementation_guide.md`,
  "utf8",
);

const contract = readFileSync(`${repoRoot}wiki/AGENTS.md`, "utf8");

/**
 * The guide's §10 embeds the wiki operating contract. The canonical copy is
 * wiki/AGENTS.md (code repo); the guide block and the data-repo copy are
 * derived from it. Extract the embedded block so the test can pin the
 * embed to the canonical text byte-for-byte.
 */
function extractEmbeddedContract(text: string): string {
  const sectionStart = text.indexOf("## 10. `wiki/AGENTS.md`");

  const fenceStart = text.indexOf("```markdown", sectionStart);

  const contentStart = fenceStart + "```markdown".length + 1;

  const fenceEnd = text.indexOf("\n```", contentStart);

  return text.slice(contentStart, fenceEnd);
}

const embedded = extractEmbeddedContract(guide);

describe("wiki contract ↔ guide §10 embed", () => {
  it("extracts the contract block from guide §10", () => {
    expect(embedded).toContain("# Karpathy Wiki Instructions");
  });

  it("canonical wiki/AGENTS.md starts with the guide's embedded contract byte-for-byte", () => {
    expect(contract.startsWith(embedded)).toBe(true);
  });

  it("canonical wiki/AGENTS.md does not reference the implementation guide", () => {
    expect(contract).not.toMatch(/guide §|implementation guide/);
  });
});
