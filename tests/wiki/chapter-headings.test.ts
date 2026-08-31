import { describe, expect, it } from "vitest";
import {
  anchorResolves,
  extractHeadings,
  insertChapterHeadings,
} from "../../src/wiki/chapter-headings.ts";

describe("extractHeadings", () => {
  it("returns every ATX heading's text in document order", () => {
    expect(extractHeadings("# One\nbody\n## Two\n### Three\n")).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("skips headings inside fenced code blocks", () => {
    expect(extractHeadings("## Real\n```\n## Fenced\n```\n## After\n")).toEqual(
      ["Real", "After"],
    );
  });

  it("returns an empty list for a body without headings", () => {
    expect(extractHeadings("prose only\n")).toEqual([]);
  });

  it("keeps irregular whitespace inside the heading text", () => {
    expect(extractHeadings("## 27.  Digital Wallet\n")).toEqual([
      "27.  Digital Wallet",
    ]);
  });
});

describe("anchorResolves", () => {
  it("resolves a byte-identical heading with irregular whitespace", () => {
    expect(
      anchorResolves("## 27.  Digital Wallet\n", "27.  Digital Wallet"),
    ).toBe(true);
  });

  it("rejects an anchor that differs from the heading by whitespace", () => {
    expect(
      anchorResolves("## 27.  Digital Wallet\n", "27. Digital Wallet"),
    ).toBe(false);
  });

  it("rejects an anchor the page has no heading for", () => {
    expect(anchorResolves("## Chapter\n", "Typo")).toBe(false);
  });

  it("resolves the final heading segment of a multi-level anchor", () => {
    expect(
      anchorResolves("# Part One\n\n## Details\n", "Part One#Details"),
    ).toBe(true);
  });

  it("ignores headings written inside the page's frontmatter", () => {
    expect(anchorResolves("---\nnote: # Fake\n---\n## Real\n", "Fake")).toBe(
      false,
    );
  });

  it("ignores headings inside fenced code blocks", () => {
    expect(anchorResolves("```\n## Fenced\n```\n", "Fenced")).toBe(false);
  });
});

describe("insertChapterHeadings", () => {
  it("appends one heading per missing chapter in citation order", () => {
    const { text, added } = insertChapterHeadings(
      "---\ntitle: Hub\n---\nprose\n",
      ["04. Rate Limiter", "05. Consistent Hashing"],
    );

    expect(`${added}|${text}`).toBe(
      "04. Rate Limiter,05. Consistent Hashing|---\ntitle: Hub\n---\nprose\n\n## 04. Rate Limiter\n\n## 05. Consistent Hashing\n",
    );
  });

  it("changes nothing when every chapter heading already exists", () => {
    const text = "prose\n\n## 04. Rate Limiter\n";

    expect(insertChapterHeadings(text, ["04. Rate Limiter"])).toEqual({
      text,
      added: [],
      skipped: [],
    });
  });

  it("treats a chapter as present when its heading exists at any level", () => {
    const text = "prose\n\n#### 04. Rate Limiter\n";

    expect(insertChapterHeadings(text, ["04. Rate Limiter"]).added).toEqual([]);
  });

  it("only appends the chapters that are missing", () => {
    const { text, added } = insertChapterHeadings("prose\n\n## 01. Scaling\n", [
      "01. Scaling",
      "02. Estimation",
    ]);

    expect(`${added}|${text}`).toBe(
      "02. Estimation|prose\n\n## 01. Scaling\n\n## 02. Estimation\n",
    );
  });

  it("writes the heading text byte-identical to names with double spaces", () => {
    const { text } = insertChapterHeadings("prose\n", ["27.  Digital Wallet"]);

    expect(text).toContain("\n## 27.  Digital Wallet\n");
  });

  it("skips a chapter whose appended heading lands inside an unclosed code fence", () => {
    const text = "prose\n\n```\ncode\n";

    expect(insertChapterHeadings(text, ["04. Rate Limiter"])).toEqual({
      text,
      added: [],
      skipped: ["04. Rate Limiter"],
    });
  });

  it("skips a chapter name whose heading cannot be byte-identical", () => {
    const text = "prose\n";

    expect(insertChapterHeadings(text, ["04. Rate Limiter "])).toEqual({
      text,
      added: [],
      skipped: ["04. Rate Limiter "],
    });
  });

  it("appends only the chapters that round-trip and skips the rest", () => {
    const { text, added, skipped } = insertChapterHeadings("prose\n", [
      "01. Scaling",
      "02. Estimation ",
    ]);

    expect(`${added}|${skipped}|${text}`).toBe(
      "01. Scaling|02. Estimation |prose\n\n## 01. Scaling\n",
    );
  });

  it("is idempotent for a chapter it skipped: a re-run appends nothing", () => {
    const text = "prose\n\n```\ncode\n";
    const once = insertChapterHeadings(text, ["04. Rate Limiter"]);
    const twice = insertChapterHeadings(once.text, ["04. Rate Limiter"]);

    expect(`${twice.text === once.text}|${twice.skipped}`).toBe(
      "true|04. Rate Limiter",
    );
  });
});
