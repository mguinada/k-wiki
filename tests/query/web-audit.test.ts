import { describe, expect, it } from "vitest";
import {
  extractUrls,
  parseAgentJsonStream,
  reconcileWebSources,
  type WebCall,
} from "../../src/query/web-audit.ts";
import { assistantTextLine, toolCallLine, toolResultLine } from "./helpers.ts";

describe("parseAgentJsonStream", () => {
  it("records every web tool call in order with its target and count", () => {
    const stream = [
      toolCallLine("c1", { query: "first query" }),
      toolResultLine("c1", "results one", { totalResults: 5 }),
      toolCallLine("c2", { url: "https://example.com/b" }),
      toolResultLine("c2", "fetched b"),
      assistantTextLine("- done"),
    ].join("\n");
    const parsed = parseAgentJsonStream(stream);

    expect(parsed.calls.map((call) => call.tool)).toEqual([
      "web_search",
      "web_search",
    ]);
    expect(parsed.calls[0]?.target).toBe("first query");
    expect(parsed.calls[0]?.results).toBe(5);
    expect(parsed.calls[1]?.target).toBe("https://example.com/b");
  });

  it("collects fetch targets and result-text URLs into the call's URL set", () => {
    const stream = [
      toolCallLine("c1", { url: "https://example.com/a" }),
      toolResultLine(
        "c1",
        "see https://example.com/a and https://example.com/z",
      ),
      assistantTextLine("- done"),
    ].join("\n");
    const parsed = parseAgentJsonStream(stream);

    expect(parsed.calls[0]?.urls).toEqual([
      "https://example.com/a",
      "https://example.com/z",
    ]);
  });

  it("takes the enrichment text from the final assistant message", () => {
    const stream = [
      assistantTextLine("narration", 1791000000000),
      assistantTextLine("- the answer bullets"),
    ].join("\n");
    const parsed = parseAgentJsonStream(stream);

    expect(parsed.enrichment).toBe("- the answer bullets");
  });

  it("skips non-JSON lines instead of failing the parse", () => {
    const parsed = parseAgentJsonStream(
      ["not json", assistantTextLine("- ok")].join("\n"),
    );

    expect(parsed.enrichment).toBe("- ok");
    expect(parsed.calls).toEqual([]);
  });

  it("marks failed calls from the tool result's error flag", () => {
    const stream = [
      toolCallLine("c1", { query: "doomed" }),
      toolResultLine("c1", "boom", { isError: true }),
      assistantTextLine("- done"),
    ].join("\n");
    const parsed = parseAgentJsonStream(stream);

    expect(parsed.calls[0]?.failed).toBe(true);
  });
});

describe("reconcileWebSources", () => {
  const fetchCall: WebCall = {
    tool: "fetch_content",
    target: "https://example.com/a",
    results: 1,
    timestamp: 1791000001000,
    urls: ["https://example.com/a"],
    failed: false,
  };

  it("passes when every cited URL is accounted for and every fetch is cited", () => {
    const enrichment = "- [a](https://example.com/a) (retrieved 2026-10-03).";
    const reconciliation = reconcileWebSources(enrichment, [fetchCall]);

    expect(reconciliation.failure).toBeUndefined();
    expect(reconciliation.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("fails when a cited URL is absent from the audit table", () => {
    const reconciliation = reconcileWebSources(
      "- [x](https://example.com/hallucinated) (retrieved 2026-10-03).",
      [fetchCall],
    );

    expect(reconciliation.failure).toContain(
      "cited URL absent from the audit table: https://example.com/hallucinated",
    );
  });

  it("fails when a fetch call's target goes uncited", () => {
    const reconciliation = reconcileWebSources("- nothing cited.", [fetchCall]);

    expect(reconciliation.failure).toContain(
      "uncited web call: fetch_content https://example.com/a",
    );
  });

  it("exempts a failed fetch from the uncited-call rule", () => {
    const reconciliation = reconcileWebSources("- nothing cited.", [
      { ...fetchCall, failed: true },
    ]);

    expect(reconciliation.failure).toBeUndefined();
    expect(reconciliation.sources).toEqual([]);
  });

  it("credits a search entry whose returned URL the enrichment cites", () => {
    const search: WebCall = {
      tool: "web_search",
      target: "topic",
      results: 5,
      timestamp: 1791000000000,
      urls: ["https://example.com/a", "https://example.com/other"],
      failed: false,
    };
    const reconciliation = reconcileWebSources(
      "- [a](https://example.com/a).",
      [search],
    );

    expect(reconciliation.failure).toBeUndefined();
    expect(reconciliation.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });
});

describe("extractUrls", () => {
  it("extracts markdown link targets and bare URLs, deduplicated", () => {
    expect(
      extractUrls(
        "see [a](https://example.com/a) and https://example.com/b. Also https://example.com/a.",
      ),
    ).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});
