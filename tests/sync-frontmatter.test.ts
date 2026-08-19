import { describe, expect, it } from "vitest";
import { parseSelect } from "../src/sync/config.ts";
import { isSelectedNote } from "../src/sync/frontmatter.ts";

const select = parseSelect("wiki:true");

describe("parseSelect", () => {
  it("parses the supported wiki:true expression", () => {
    expect(parseSelect("wiki:true")).toEqual({ key: "wiki", value: "true" });
  });

  it("rejects an expression selecting a false value", () => {
    expect(() => parseSelect("wiki:false")).toThrow(
      /unsupported select expression/,
    );
  });

  it("rejects an expression that is not key:value", () => {
    expect(() => parseSelect("wiki")).toThrow(/unsupported select expression/);
  });
});

describe("isSelectedNote", () => {
  it("selects a note whose frontmatter contains wiki: true", () => {
    expect(isSelectedNote("---\nwiki: true\n---\n\n# Note\n", select)).toBe(
      true,
    );
  });

  it("selects a note when other keys surround the flag", () => {
    const content = "---\ntags:\n  - AI\nwiki: true\naliases: []\n---\n";

    expect(isSelectedNote(content, select)).toBe(true);
  });

  it("selects a note when the flag line carries trailing whitespace", () => {
    expect(isSelectedNote("---\nwiki: true \n---\n", select)).toBe(true);
  });

  it("selects a note with CRLF line endings", () => {
    expect(isSelectedNote("---\r\nwiki: true\r\n---\r\n", select)).toBe(true);
  });

  it("rejects a note flagged wiki: false", () => {
    expect(isSelectedNote("---\nwiki: false\n---\n", select)).toBe(false);
  });

  it("rejects a note without frontmatter", () => {
    expect(isSelectedNote("# Just a heading\n\nwiki: true\n", select)).toBe(
      false,
    );
  });

  it("rejects a note whose wiki: true appears only in the body", () => {
    const content = "---\ntags:\n  - AI\n---\n\nwiki: true\n";

    expect(isSelectedNote(content, select)).toBe(false);
  });

  it("rejects a note whose first line is not --- even when the flag precedes a later ---", () => {
    const content = "# Title\nwiki: true\n---\n";

    expect(isSelectedNote(content, select)).toBe(false);
  });

  it("rejects a note whose frontmatter block never closes", () => {
    expect(isSelectedNote("---\nwiki: true\n", select)).toBe(false);
  });

  it("rejects a flag written without a space after the colon", () => {
    expect(isSelectedNote("---\nwiki:true\n---\n", select)).toBe(false);
  });

  it("rejects an empty frontmatter block", () => {
    expect(isSelectedNote("---\n---\n", select)).toBe(false);
  });
});
