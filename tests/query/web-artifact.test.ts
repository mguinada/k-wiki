import { describe, expect, it } from "vitest";
import {
  looksPartitionedWeb,
  parseWebArtifactBody,
  renderWebArtifactBody,
  renderWebAuditSection,
  renderWebEnrichmentSection,
  renderWebSourcesSection,
  sanitizeEnrichment,
  WEB_ENRICHMENT_HEADING,
  WEB_ENRICHMENT_LABEL,
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

  it("cuts model output at machine-owned headings and the label", () => {
    const sanitized = sanitizeEnrichment(
      [
        "- real bullet",
        "",
        WEB_ENRICHMENT_HEADING,
        "",
        WEB_SOURCES_HEADING,
        "",
        "- https://example.com/model-written",
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

  it("renders the audit table header", () => {
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
  });

  it("renders one audit row per recorded call", () => {
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

    expect(section).toContain(
      "| 1 | web_search | topic | 5 | 2026-10-03T21:00:01.000Z |",
    );
  });

  it("appends the pruning record with gate, count, and URLs under the table", () => {
    const section = renderWebAuditSection([], {
      count: 2,
      urls: ["https://example.com/a", "https://example.com/b"],
    });

    expect(section).toContain(
      "Pruned citations: 2 — https://example.com/a, https://example.com/b (cited URLs absent from the audit table)",
    );
  });

  it("renders no prune line when nothing was pruned", () => {
    const section = renderWebAuditSection([]);

    expect(section).not.toContain("Pruned citations");
  });
});

describe("partitioned body codec", () => {
  const web = {
    enrichment: [
      WEB_ENRICHMENT_HEADING,
      "",
      WEB_ENRICHMENT_LABEL,
      "",
      "- [Example](https://example.com/a) reinforces the topic (retrieved 2026-10-03).",
    ].join("\n"),
    sources: [
      WEB_SOURCES_HEADING,
      "",
      "- https://example.com/a — retrieved 2026-10-03",
    ].join("\n"),
    audit: [
      "## Web calls audit",
      "",
      "| # | tool | target | results | timestamp |",
      "|---|------|--------|---------|-----------|",
      "| 1 | web_search | topic | 4 | 2026-10-03T21:00:01.000Z |",
    ].join("\n"),
  };

  it("leaves a blank line before the thematic break", () => {
    const body = renderWebArtifactBody("The core answer.", web);

    const lines = body.split("\n");

    expect(lines[lines.indexOf("---") - 1]).toBe("");
  });

  it("leaves a blank line after the thematic break", () => {
    const body = renderWebArtifactBody("The core answer.", web);

    const lines = body.split("\n");

    expect(lines[lines.indexOf("---") + 1]).toBe("");
  });

  it("opens the enrichment heading after the break", () => {
    const body = renderWebArtifactBody("The core answer.", web);

    const lines = body.split("\n");

    expect(lines[lines.indexOf("---") + 2]).toBe(WEB_ENRICHMENT_HEADING);
  });

  it("uses the markdown break, not the box character", () => {
    const body = renderWebArtifactBody("The core answer.", web);

    expect(body).not.toContain("─");
  });

  it("round-trips the partitioned body", () => {
    const lines = renderWebArtifactBody("The core answer.", web).split("\n");

    expect(parseWebArtifactBody(lines)).toEqual({
      answer: "The core answer.",
      web,
    });
  });

  it("round-trips a body whose audit section carries the pruning record", () => {
    const audit = [
      web.audit,
      "",
      "Pruned citations: 1 — https://example.com/drift (cited URL absent from the audit table)",
    ].join("\n");
    const parsed = parseWebArtifactBody(
      renderWebArtifactBody("The core answer.", { ...web, audit }).split("\n"),
    );

    expect(parsed?.web.audit).toBe(audit);
  });

  it("resolves the core answer past a stray break", () => {
    const answer = [
      "The core answer.",
      "",
      "---",
      "",
      "## Web sources",
      "",
      "A stray line the core happens to carry.",
    ].join("\n");

    const parsed = parseWebArtifactBody(
      renderWebArtifactBody(answer, web).split("\n"),
    );

    expect(parsed?.answer).toBe(answer);
  });

  it("keeps the web sources section", () => {
    const answer = [
      "The core answer.",
      "",
      "---",
      "",
      "## Web sources",
      "",
      "A stray line the core happens to carry.",
    ].join("\n");

    const parsed = parseWebArtifactBody(
      renderWebArtifactBody(answer, web).split("\n"),
    );

    expect(parsed?.web.sources).toBe(web.sources);
  });

  it("keeps the web audit section", () => {
    const answer = [
      "The core answer.",
      "",
      "---",
      "",
      "## Web sources",
      "",
      "A stray line the core happens to carry.",
    ].join("\n");

    const parsed = parseWebArtifactBody(
      renderWebArtifactBody(answer, web).split("\n"),
    );

    expect(parsed?.web.audit).toBe(web.audit);
  });

  it("detects the machine-owned partitioned shape", () => {
    const lines = renderWebArtifactBody("The core answer.", web).split("\n");

    expect(looksPartitionedWeb(lines)).toBe(true);

    looksPartitionedWeb(["Just an answer.", "", "---"]);

    looksPartitionedWeb(["## Answer", "", "no sections here"]);
  });

  it("rejects a plain answer with a stray break", () => {
    const lines = renderWebArtifactBody("The core answer.", web).split("\n");

    looksPartitionedWeb(lines);

    expect(looksPartitionedWeb(["Just an answer.", "", "---"])).toBe(false);

    looksPartitionedWeb(["## Answer", "", "no sections here"]);
  });

  it("rejects an Answer heading without sections", () => {
    const lines = renderWebArtifactBody("The core answer.", web).split("\n");

    looksPartitionedWeb(lines);

    looksPartitionedWeb(["Just an answer.", "", "---"]);

    expect(looksPartitionedWeb(["## Answer", "", "no sections here"])).toBe(
      false,
    );
  });

  it("detects the look-partitioned shape", () => {
    const lines = renderWebArtifactBody("The core answer.", web)
      .split("\n")
      .filter((line) => line !== WEB_SOURCES_HEADING);

    expect(looksPartitionedWeb(lines)).toBe(true);
  });

  it("rejects a tail that fails resolution", () => {
    const lines = renderWebArtifactBody("The core answer.", web)
      .split("\n")
      .filter((line) => line !== WEB_SOURCES_HEADING);

    looksPartitionedWeb(lines);

    expect(parseWebArtifactBody(lines)).toBeUndefined();
  });

  it("leaves a core ending in its own thematic break byte-exact", () => {
    const answer = "Point one.\n\n---\n\nPoint two.";
    const parsed = parseWebArtifactBody(
      renderWebArtifactBody(answer, web).split("\n"),
    );

    expect(parsed?.answer).toBe(answer);
  });
});
