import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const contract = readFileSync(`${repoRoot}wiki/AGENTS.md`, "utf8");

describe("wiki contract self-containment", () => {
  it("canonical wiki/AGENTS.md does not reference the implementation guide", () => {
    expect(contract).not.toMatch(/guide §|implementation guide/);
  });
});
