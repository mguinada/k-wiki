import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const contract = readFileSync(`${repoRoot}wiki/AGENTS.md`, "utf8");
const metaContract = readFileSync(`${repoRoot}wiki/AGENTS.meta.md`, "utf8");

describe("wiki contract self-containment", () => {
  it("canonical wiki/AGENTS.md does not reference the implementation guide", () => {
    expect(contract).not.toMatch(/guide §|implementation guide/);
  });

  it("canonical wiki/AGENTS.meta.md does not reference the implementation guide", () => {
    expect(metaContract).not.toMatch(/guide §|implementation guide/);
  });
});

// The per-chapter section rule (issue #227) lives on three surfaces
// that must move together: the canonical contract every wiki
// operation follows, and the two prompts that teach the citation
// shape (the only prompts that do). A run that rewords or drops the
// rule on one surface silently changes what the wiki agent writes
// into multi-part hubs — this guard makes that drift a test failure.
describe("per-chapter section rule (issue #227)", () => {
  // The contract's markdown wraps at ~72 columns, so pinned phrases
  // must be matched against whitespace-collapsed text.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const ingest = flat(readFileSync(`${repoRoot}prompts/ingest.md`, "utf8"));
  const incremental = flat(
    readFileSync(`${repoRoot}prompts/incremental.md`, "utf8"),
  );

  it("canonical contract carries the multi-part source hubs rule", () => {
    expect(contract).toContain("### Multi-part source hubs");
  });

  it("contract gives every cited chapter one section", () => {
    expect(flat(contract)).toContain("one section per cited chapter");
  });

  it("contract keeps the page-level digest as the plain-hub landing zone", () => {
    expect(flat(contract)).toContain(
      "landing zone for plain `[[hub]]` citations",
    );
  });

  it("contract forbids chapter sections from restating paged detail", () => {
    expect(flat(contract)).toContain(
      "never restates detail that already has a page",
    );
  });

  it("ingest prompt teaches the per-chapter section shape", () => {
    expect(ingest).toContain("## <chapter>");
  });

  it("incremental prompt teaches the per-chapter section shape", () => {
    expect(incremental).toContain("## <chapter>");
  });
});
