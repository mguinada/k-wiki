import { describe, expect, it } from "vitest";
import { parseExclude } from "../src/sync/config.ts";
import { isSelectedNote } from "../src/sync/frontmatter.ts";

const exclude = parseExclude("wiki:false");

describe("parseExclude", () => {
  it("parses the supported wiki:false expression", () => {
    expect(parseExclude("wiki:false")).toEqual({
      key: "wiki",
      value: "false",
    });
  });

  it("rejects an expression excluding a true value", () => {
    expect(() => parseExclude("wiki:true")).toThrow(
      /unsupported exclude expression/,
    );
  });

  it("rejects an expression that is not key:value", () => {
    expect(() => parseExclude("wiki")).toThrow(
      /unsupported exclude expression/,
    );
  });

  it("rejects an expression with anything before the key", () => {
    expect(() => parseExclude(" wiki:false")).toThrow(
      /unsupported exclude expression/,
    );
  });

  it("rejects an expression with anything after the value", () => {
    expect(() => parseExclude("wiki:false today")).toThrow(
      /unsupported exclude expression/,
    );
  });

  it("rejects a key containing a regex metacharacter", () => {
    expect(() => parseExclude("wi.ki:false")).toThrow(
      /unsupported exclude expression/,
    );
  });
});

describe("isSelectedNote", () => {
  it("blocks a note whose frontmatter contains wiki: false", () => {
    expect(isSelectedNote("---\nwiki: false\n---\n\n# Note\n", exclude)).toBe(
      false,
    );
  });

  it("ingests a note whose frontmatter contains wiki: true", () => {
    expect(isSelectedNote("---\nwiki: true\n---\n\n# Note\n", exclude)).toBe(
      true,
    );
  });

  it("ingests a note without any frontmatter", () => {
    expect(isSelectedNote("# Just a heading\n", exclude)).toBe(true);
  });

  it("ingests a note whose frontmatter omits the flag property", () => {
    expect(isSelectedNote("---\ntags:\n  - AI\n---\n", exclude)).toBe(true);
  });

  it("ingests a note with a blank flag value", () => {
    expect(isSelectedNote("---\nwiki:\n---\n", exclude)).toBe(true);
  });

  it('blocks a note with a quoted wiki: "false" value', () => {
    expect(isSelectedNote('---\nwiki: "false"\n---\n', exclude)).toBe(false);
  });

  it('ingests a note with a quoted wiki: "true" value', () => {
    expect(isSelectedNote('---\nwiki: "true"\n---\n', exclude)).toBe(true);
  });

  it("blocks a note with a single-quoted wiki: 'false' value", () => {
    expect(isSelectedNote("---\nwiki: 'false'\n---\n", exclude)).toBe(false);
  });

  it("blocks a note when other keys surround the flag", () => {
    const content = "---\ntags:\n  - personal\nwiki: false\naliases: []\n---\n";

    expect(isSelectedNote(content, exclude)).toBe(false);
  });

  it("blocks a note when the flag line carries trailing whitespace", () => {
    expect(isSelectedNote("---\nwiki: false \n---\n", exclude)).toBe(false);
  });

  it("blocks a note with CRLF line endings", () => {
    expect(isSelectedNote("---\r\nwiki: false\r\n---\r\n", exclude)).toBe(
      false,
    );
  });

  it("ingests a note whose wiki: false appears only in the body", () => {
    const content = "---\ntags:\n  - AI\n---\n\nwiki: false\n";

    expect(isSelectedNote(content, exclude)).toBe(true);
  });

  it("ingests a note whose wiki: false in the body is its only flag mention", () => {
    expect(isSelectedNote("# Title\n\nwiki: false\n", exclude)).toBe(true);
  });

  it("ingests a note whose first line is not --- even when wiki: false precedes a later ---", () => {
    const content = "# Title\nwiki: false\n---\n";

    expect(isSelectedNote(content, exclude)).toBe(true);
  });

  it("ingests a note whose frontmatter block never closes", () => {
    expect(isSelectedNote("---\nwiki: false\n", exclude)).toBe(true);
  });

  it("blocks a note whose block flag is written without a space after the colon", () => {
    expect(isSelectedNote("---\nwiki:false\n---\n", exclude)).toBe(false);
  });

  it("ingests a note with an empty frontmatter block", () => {
    expect(isSelectedNote("---\n---\n", exclude)).toBe(true);
  });

  it("ingests a note whose wiki: false is indented as a list item", () => {
    expect(isSelectedNote("---\ntags:\n  - wiki: false\n---\n", exclude)).toBe(
      true,
    );
  });

  it("ingests a note whose flag value carries extra text", () => {
    expect(isSelectedNote("---\nwiki: false note\n---\n", exclude)).toBe(true);
  });
});
