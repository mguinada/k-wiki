import { describe, expect, it } from "vitest";
import {
  expiresOn,
  sandboxLogEntry,
  stampSandboxPage,
} from "../../src/sandbox/stamps.ts";

/** A fixed clock: 2026-08-20T12:00:00Z. */
const NOW = () => new Date("2026-08-20T12:00:00.000Z");

describe("expiresOn", () => {
  it("stamps the date 7 days out, date-level", () => {
    expect(expiresOn(NOW)).toBe("2026-08-27");
  });

  it("rolls over the month boundary", () => {
    expect(expiresOn(() => new Date("2026-08-28T23:30:00.000Z"))).toBe(
      "2026-09-04",
    );
  });

  it("rolls over the year boundary", () => {
    expect(expiresOn(() => new Date("2026-12-30T09:00:00.000Z"))).toBe(
      "2027-01-06",
    );
  });

  it("never lands inside the 7-day floor for any hour of the day", () => {
    // A run late in the day must still expire 7 calendar days out,
    // not 6 days and a few hours.
    expect(expiresOn(() => new Date("2026-08-20T23:59:59.999Z"))).toBe(
      "2026-08-27",
    );
  });
});

describe("stampSandboxPage", () => {
  it("adds via and expires to a page with frontmatter", () => {
    const text = [
      "---",
      'title: "Proposal"',
      "type: concept",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");

    expect(stampSandboxPage(text, "2026-08-27")).toBe(
      [
        "---",
        'title: "Proposal"',
        "type: concept",
        "via: agent",
        "expires: 2026-08-27",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
  });

  it("overwrites a caller-supplied via stamp (the epilogue owns it)", () => {
    const text = [
      "---",
      'title: "Proposal"',
      "via: human",
      "expires: 2026-08-21",
      "---",
      "Body.",
    ].join("\n");

    expect(stampSandboxPage(text, "2026-08-27")).toBe(
      [
        "---",
        'title: "Proposal"',
        "via: agent",
        "expires: 2026-08-27",
        "---",
        "Body.",
      ].join("\n"),
    );
  });

  it("drops a caller-supplied expires wherever it sits in the block", () => {
    const text = [
      "---",
      "expires: 1999-01-01",
      'title: "Proposal"',
      "via: agent",
      "---",
      "Body.",
    ].join("\n");

    expect(stampSandboxPage(text, "2026-08-27")).toBe(
      [
        "---",
        'title: "Proposal"',
        "via: agent",
        "expires: 2026-08-27",
        "---",
        "Body.",
      ].join("\n"),
    );
  });

  it("creates frontmatter for a page without one", () => {
    expect(stampSandboxPage("Body.\n", "2026-08-27")).toBe(
      ["---", "via: agent", "expires: 2026-08-27", "---", "", "Body.", ""].join(
        "\n",
      ),
    );
  });

  it("leaves a body-only --- line alone (no false frontmatter)", () => {
    const text = ["Body first.", "", "---", "", "Later divider.", ""].join(
      "\n",
    );

    expect(stampSandboxPage(text, "2026-08-27")).toBe(
      ["---", "via: agent", "expires: 2026-08-27", "---", "", text].join("\n"),
    );
  });

  it("is deterministic: stamping twice yields the same bytes", () => {
    const text = [
      "---",
      'title: "Proposal"',
      "via: human",
      "---",
      "Body.",
    ].join("\n");
    const once = stampSandboxPage(text, "2026-08-27");

    expect(stampSandboxPage(once, "2026-08-27")).toBe(once);
  });

  it("treats an unclosed frontmatter block as no frontmatter", () => {
    expect(stampSandboxPage("---\ntitle: x\n", "2026-08-27")).toBe(
      [
        "---",
        "via: agent",
        "expires: 2026-08-27",
        "---",
        "",
        "---",
        "title: x",
        "",
      ].join("\n"),
    );
  });
});

describe("sandboxLogEntry", () => {
  it("starts with the parseable log header naming the slug", () => {
    const entry = sandboxLogEntry({
      date: "2026-08-20",
      slug: "attention-notes",
      expires: "2026-08-27",
      pages: ["wiki/sandbox/attention-notes.md"],
    });

    expect(
      entry.startsWith("## [2026-08-20] sandbox | attention-notes\n"),
    ).toBe(true);
  });

  it("names every committed page and the expiry", () => {
    const entry = sandboxLogEntry({
      date: "2026-08-20",
      slug: "attention-notes",
      expires: "2026-08-27",
      pages: ["wiki/sandbox/attention-notes.md"],
    });

    expect(entry).toContain("wiki/sandbox/attention-notes.md");
    expect(entry).toContain("2026-08-27");
  });
});
