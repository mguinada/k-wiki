import { describe, expect, it } from "vitest";
import {
  renderWebAuditSection,
  renderWebEnrichmentSection,
  renderWebSourcesSection,
  sanitizeEnrichment,
  WEB_ENRICHMENT_HEADING,
  WEB_ENRICHMENT_LABEL,
  WEB_PARTITION_SEPARATOR,
  WEB_SOURCES_HEADING,
} from "../../src/query/web-artifact.ts";

describe("section renderers", () => {
  it("heads the enrichment section with the machine label", () => {
    const section = renderWebEnrichmentSection("- bullet one");

    expect(section).toBe(
      [
        WEB_ENRICHMENT_HEADING,
        "",
        WEB_ENRICHMENT_LABEL,
        "",
        "- bullet one",
      ].join("\n"),
    );
  });

  it("strips machine-owned headings and separators the model imitated", () => {
    const sanitized = sanitizeEnrichment(
      [
        "- real bullet",
        "",
        WEB_ENRICHMENT_HEADING,
        "",
        WEB_SOURCES_HEADING,
        "",
        "- https://example.com/model-written",
        "",
        WEB_PARTITION_SEPARATOR,
      ].join("\n"),
    );

    expect(sanitized).toBe("- real bullet");
  });

  it("lists each source with its retrieval date", () => {
    const section = renderWebSourcesSection([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);

    expect(section).toBe(
      [
        WEB_SOURCES_HEADING,
        "",
        "- https://example.com/a — retrieved 2026-10-03",
      ].join("\n"),
    );
  });

  it("renders the audit table with one row per recorded call", () => {
    const section = renderWebAuditSection([
      {
        tool: "web_search",
        target: "topic",
        results: 5,
        timestamp: Date.parse("2026-10-03T21:00:01.000Z"),
        urls: [],
        failed: false,
      },
    ]);

    expect(section).toContain("| # | tool | target | results | timestamp |");
    expect(section).toContain(
      "| 1 | web_search | topic | 5 | 2026-10-03T21:00:01.000Z |",
    );
  });
});
