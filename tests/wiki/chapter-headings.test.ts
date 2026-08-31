import { describe, expect, it } from "vitest";
import {
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
});
