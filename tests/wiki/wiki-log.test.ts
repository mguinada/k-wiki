import { describe, expect, it } from "vitest";
import { prependWikiLog } from "../../src/wiki/wiki-log.ts";

describe("prependWikiLog", () => {
  it("creates the header and the entry in an empty log", () => {
    expect(prependWikiLog("", "## [2026-09-01] query | Q")).toBe(
      "# Wiki Log\n\n## [2026-09-01] query | Q\n",
    );
  });

  it("lands the new entry directly under the header of an existing log", () => {
    expect(
      prependWikiLog(
        "# Wiki Log\n\n## [2026-08-01] ingest | Old\n\nBody.\n",
        "## [2026-09-01] query | New",
      ),
    ).toBe(
      "# Wiki Log\n\n## [2026-09-01] query | New\n\n## [2026-08-01] ingest | Old\n\nBody.\n",
    );
  });

  it("normalizes a log without a trailing newline before inserting", () => {
    expect(prependWikiLog("# Wiki Log", "## [2026-09-01] query | Q")).toBe(
      "# Wiki Log\n\n## [2026-09-01] query | Q\n",
    );
  });

  it("inserts the entry above a headerless log's entries without inventing a header", () => {
    expect(
      prependWikiLog(
        "## [2026-08-01] sandbox | s\n\nPages.\n",
        "## [2026-09-01] sandbox | n",
      ),
    ).toBe(
      "## [2026-09-01] sandbox | n\n\n## [2026-08-01] sandbox | s\n\nPages.\n",
    );
  });

  it("never writes above frontmatter: the entry lands after it, before the first entry", () => {
    const log = [
      "---",
      'title: "Wiki Log"',
      "---",
      "",
      "<!-- standing comment -->",
      "",
      "## [2026-08-01] ingest | Old",
      "",
      "Body.",
      "",
    ].join("\n");

    expect(prependWikiLog(log, "## [2026-09-01] query | New")).toBe(
      [
        "---",
        'title: "Wiki Log"',
        "---",
        "",
        "<!-- standing comment -->",
        "",
        "## [2026-09-01] query | New",
        "",
        "## [2026-08-01] ingest | Old",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
  });

  it("keeps a standing comment below the header above the new entry", () => {
    expect(
      prependWikiLog(
        "# Wiki Log\n\n<!-- format note -->\n\n## [2026-08-01] ingest | Old\n\nBody.\n",
        "## [2026-09-01] query | New",
      ),
    ).toBe(
      "# Wiki Log\n\n<!-- format note -->\n\n## [2026-09-01] query | New\n\n## [2026-08-01] ingest | Old\n\nBody.\n",
    );
  });

  it("trims the entry's trailing newlines to keep the file ending uniform", () => {
    expect(prependWikiLog("", "## [2026-09-01] sandbox | s\n\nPages.\n")).toBe(
      "# Wiki Log\n\n## [2026-09-01] sandbox | s\n\nPages.\n",
    );
  });

  it("keeps bytes preceding the header untouched", () => {
    expect(prependWikiLog("\n# Wiki Log", "## [2026-09-01] query | Q")).toBe(
      "\n# Wiki Log\n\n## [2026-09-01] query | Q\n",
    );
  });
});
