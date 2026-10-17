import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const contract = readFileSync(`${repoRoot}wiki/AGENTS.md`, "utf8");
const metaContract = readFileSync(`${repoRoot}wiki/AGENTS.meta.md`, "utf8");
const lint = readFileSync(`${repoRoot}prompts/lint.md`, "utf8");
const lintWindow = readFileSync(`${repoRoot}prompts/lint-window.md`, "utf8");

// The page-shape conventions (issue #432) live on four surfaces that
// must move together: the canonical contract, the meta-instance
// mirror, and the two lint prompts whose audit lists carry them. A
// run that drops or rewords a convention on one surface silently
// changes what agents write or flag — this guard makes that drift a
// test failure. Phrases are pinned against whitespace-collapsed
// text: the contract's markdown wraps at ~72 columns.
const flat = (text: string) => text.replace(/\s+/g, " ");

/** The pinned phrases of one convention, whitespace-collapsed; the
 *  empty list means every phrase is present. */
function missingPhrases(text: string, phrases: string[]): string[] {
  const flatText = flat(text);

  return phrases.filter((phrase) => !flatText.includes(phrase));
}

describe("page shape section (issue #432)", () => {
  it("canonical contract carries the Page Shape section", () => {
    expect(contract).toContain("## Page Shape");
  });

  it("canonical contract pins the categorical confidence scale", () => {
    expect(
      missingPhrases(contract, [
        "`confidence` uses the categorical vocabulary `low`, `medium`, `high`",
        "Free-form and numeric values are violations",
      ]),
    ).toEqual([]);
  });

  it("contract enumerates the closed status allowlist", () => {
    const text = flat(contract);
    const missing = ["ingested", "stable", "needs-review", "filed"].filter(
      (value) => !text.includes(`\`${value}\``),
    );

    expect(missing).toEqual([]);
  });

  it("contract rejects invented status values", () => {
    expect(flat(contract)).toContain(
      "Values outside the allowlist are violations",
    );
  });

  it("contract lets inherited off-list status values persist until touched", () => {
    expect(flat(contract)).toContain(
      "keep an off-list legacy value until touched",
    );
  });

  it("contract carries the -source slug convention", () => {
    expect(
      missingPhrases(contract, [
        "carries the `-source` suffix",
        "the matching ` (source)` suffix",
        "file-kebabs to the name under the page-slug rule",
      ]),
    ).toEqual([]);
  });

  it("contract applies the slug convention on create and retitle, adopted on touch", () => {
    expect(flat(contract)).toContain(
      "applies the convention when creating or retitling a source page",
    );
  });

  it("contract never doubles the -source suffix", () => {
    expect(
      missingPhrases(contract, [
        "The name ends with exactly one `-source`",
        "the suffix is never doubled",
      ]),
    ).toEqual([]);
  });

  it("contract carries the optional-fields rule", () => {
    expect(
      missingPhrases(contract, [
        "recorded when the source states them and absent when it does not",
        "never invented, never dropped",
      ]),
    ).toEqual([]);
  });

  it("contract carries the incremental-edit boundary", () => {
    expect(
      missingPhrases(contract, [
        "additions are preferred: new prose beside the existing text",
        "Rephrasing or removing existing prose requires a recorded cause",
      ]),
    ).toEqual([]);
  });

  it("contract keeps lint repairs on their own path", () => {
    expect(flat(contract)).toContain("Lint repairs keep their own path");
  });

  it("contract carries the minimum-extraction rule with per-claim attribution", () => {
    expect(
      missingPhrases(contract, [
        "surface the concrete specifics their sources state",
        "each with per-claim attribution to the source page or anchored hub section",
        "A page that summarizes without extracting is incomplete",
      ]),
    ).toEqual([]);
  });

  it("contract keeps minimum extraction trial-first", () => {
    expect(
      missingPhrases(contract, [
        "The rule is trial-first",
        "hardens into the enforced contract — with its thin-page lint worklist item — only when the trial reports",
      ]),
    ).toEqual([]);
  });

  it("contract keeps style out of the shape rules", () => {
    expect(flat(contract)).toContain(
      "they do not contract style — linking density, list-vs-prose ratio, and emphasis stay out of scope",
    );
  });
});

describe("meta contract mirror (issue #432)", () => {
  it("meta contract carries the mirrored Page Shape section", () => {
    expect(metaContract).toContain("## Page Shape");
  });

  it("meta contract states that no meta-specific override exists", () => {
    expect(flat(metaContract)).toContain(
      "No meta-instance overrides: this wiki follows the conventions as written",
    );
  });

  it("meta contract mirrors the vocabulary rules", () => {
    expect(
      missingPhrases(metaContract, [
        "`confidence` uses the categorical vocabulary `low`, `medium`, `high`",
        "carries the `-source` suffix",
        "never invented, never dropped",
      ]),
    ).toEqual([]);
  });

  it("meta contract mirrors the edit boundary", () => {
    expect(flat(metaContract)).toContain(
      "Rephrasing or removing existing prose requires a recorded cause",
    );
  });

  it("meta contract mirrors the trial-first extraction posture", () => {
    expect(flat(metaContract)).toContain("The rule is trial-first");
  });
});

describe("lint worklist items (issue #432)", () => {
  it("full lint audits the frontmatter vocabularies", () => {
    expect(
      missingPhrases(lint, [
        "`confidence` values outside the categorical scale `low`/`medium`/`high`",
        "`status` values outside the Page Shape allowlist in wiki/AGENTS.md",
      ]),
    ).toEqual([]);
  });

  it("full lint reports slug-convention misses without auto-renaming", () => {
    expect(
      missingPhrases(lint, [
        "Source pages whose name lacks the `-source` suffix",
        "never auto-rename",
      ]),
    ).toEqual([]);
  });

  it("full lint audits the optional source fields", () => {
    expect(
      missingPhrases(lint, [
        "`author`/`published` present but not stated by the source (invented)",
        "or stated by the source but absent (dropped)",
      ]),
    ).toEqual([]);
  });

  it("full lint audits the incremental-edit boundary", () => {
    expect(flat(lint)).toContain(
      "Existing prose rephrased or removed on an inherited page without a recorded cause",
    );
  });

  it("full lint keeps minimum extraction out until the trial reports", () => {
    expect(lint.toLowerCase()).not.toContain("minimum extraction");
  });

  it("windowed lint audits the same shape items over its pages", () => {
    expect(
      missingPhrases(lintWindow, [
        "`confidence` values outside the categorical scale `low`/`medium`/`high`",
        "Source pages whose name lacks the `-source` suffix",
        "`author`/`published` present but not stated by the source (invented)",
        "Existing prose rephrased or removed on an inherited page without a recorded cause",
      ]),
    ).toEqual([]);
  });

  it("windowed lint keeps minimum extraction out until the trial reports", () => {
    expect(lintWindow.toLowerCase()).not.toContain("minimum extraction");
  });
});
