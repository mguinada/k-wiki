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

  it("prunes the bullet whose citation is absent from the audit table", () => {
    const reconciliation = reconcileWebSources(
      [
        "- [a](https://example.com/a) (retrieved 2026-10-03).",
        "- [x](https://example.com/hallucinated) (retrieved 2026-10-03).",
      ].join("\n"),
      [fetchCall],
    );

    expect(reconciliation.enrichment).toBe(
      "- [a](https://example.com/a) (retrieved 2026-10-03).",
    );
  });

  it("consolidates the sources of the traceable remainder only", () => {
    const reconciliation = reconcileWebSources(
      [
        "- [a](https://example.com/a) (retrieved 2026-10-03).",
        "- [x](https://example.com/hallucinated) (retrieved 2026-10-03).",
      ].join("\n"),
      [fetchCall],
    );

    expect(reconciliation.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("records the pruned citations' count and the offending URLs", () => {
    const reconciliation = reconcileWebSources(
      "- [x](https://example.com/hallucinated) (retrieved 2026-10-03).",
      [fetchCall],
    );

    expect(reconciliation.pruned).toEqual({
      count: 1,
      urls: ["https://example.com/hallucinated"],
    });
  });

  it("reports no pruning when every citation traces", () => {
    const reconciliation = reconcileWebSources(
      "- [a](https://example.com/a) (retrieved 2026-10-03).",
      [fetchCall],
    );

    expect(reconciliation.pruned).toBeUndefined();
  });

  it("prunes a mis-transcribed URL the recorded call spells differently", () => {
    const recorded = "https://example.com/triage/2026/2026-07-27.md";
    const reconciliation = reconcileWebSources(
      "- [triage](https://example.com/triage/2026/07-27.md) (retrieved 2026-10-03).",
      [{ ...fetchCall, target: recorded, urls: [recorded] }],
    );

    expect(reconciliation.pruned?.urls).toEqual([
      "https://example.com/triage/2026/07-27.md",
    ]);
  });

  it("drops a whole bullet citing one traceable and one untraceable URL", () => {
    const reconciliation = reconcileWebSources(
      [
        "- both: [a](https://example.com/a) and [x](https://example.com/hallucinated) (retrieved 2026-10-03).",
      ].join("\n"),
      [fetchCall],
    );

    expect(reconciliation.sources).toEqual([]);
  });

  it("fails typed when pruning empties the enrichment", () => {
    const reconciliation = reconcileWebSources(
      "- [x](https://example.com/hallucinated) (retrieved 2026-10-03).",
      [fetchCall],
    );

    expect(reconciliation.failure).toBe(
      "enrichment empty after pruning 1 untraceable citation: https://example.com/hallucinated (cited URL absent from the audit table)",
    );
  });

  it("names the pruned count even when one URL accounts for every pruned bullet", () => {
    const reconciliation = reconcileWebSources(
      [
        "- [x](https://example.com/ghost) (retrieved 2026-10-03).",
        "- [y](https://example.com/ghost) (retrieved 2026-10-03).",
      ].join("\n"),
      [fetchCall],
    );

    expect(reconciliation.failure).toBe(
      "enrichment empty after pruning 2 untraceable citations: https://example.com/ghost (cited URL absent from the audit table)",
    );
  });

  it("prunes a wrapped bullet whole — its continuation line never survives alone", () => {
    const reconciliation = reconcileWebSources(
      [
        "- [a](https://example.com/a) confirms the topic,",
        " per https://example.com/ghost (retrieved 2026-10-03).",
        "- [b](https://example.com/b) (retrieved 2026-10-03).",
      ].join("\n"),
      [
        fetchCall,
        {
          ...fetchCall,
          target: "https://example.com/b",
          urls: ["https://example.com/b"],
        },
      ],
    );

    expect(reconciliation.enrichment).toBe(
      "- [b](https://example.com/b) (retrieved 2026-10-03).",
    );
  });

  it("keeps a wrapped bullet whole when every citation traces", () => {
    const wrapped =
      "- [a](https://example.com/a) confirms the topic,\n per https://example.com/a (retrieved 2026-10-03).";
    const reconciliation = reconcileWebSources(wrapped, [fetchCall]);

    expect(reconciliation.enrichment).toBe(wrapped);
  });

  it("keeps an uncited fetch call non-fatal — recorded, not failing", () => {
    const reconciliation = reconcileWebSources("- nothing cited.", [fetchCall]);

    expect(reconciliation.failure).toBeUndefined();
  });

  it("lists no sources when the enrichment cites nothing", () => {
    const reconciliation = reconcileWebSources("- nothing cited.", [fetchCall]);

    expect(reconciliation.sources).toEqual([]);
  });

  it("reconciles a cited URL containing balanced parentheses", () => {
    const url = "https://en.wikipedia.org/wiki/Mercury_(planet)";
    const fetch: WebCall = { ...fetchCall, target: url, urls: [url] };
    const reconciliation = reconcileWebSources(
      `- [Mercury](${url}) confirms the topic (retrieved 2026-10-03).`,
      [fetch],
    );

    expect(reconciliation.failure).toBeUndefined();
    expect(reconciliation.sources).toEqual([{ url, retrieved: "2026-10-03" }]);
  });

  it("reconciles a cited URL with nested balanced parentheses", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar_(baz))";
    const fetch: WebCall = { ...fetchCall, target: url, urls: [url] };
    const reconciliation = reconcileWebSources(
      `- [Foo](${url}) confirms the topic (retrieved 2026-10-03).`,
      [fetch],
    );

    expect(reconciliation.failure).toBeUndefined();
    expect(reconciliation.sources).toEqual([{ url, retrieved: "2026-10-03" }]);
  });

  it("keeps a failed fetch call non-fatal", () => {
    const reconciliation = reconcileWebSources("- nothing cited.", [
      { ...fetchCall, failed: true },
    ]);

    expect(reconciliation.failure).toBeUndefined();
    expect(reconciliation.sources).toEqual([]);
  });

  it("keeps an uncited source_check call non-fatal", () => {
    const check: WebCall = {
      tool: "source_check",
      target: "https://example.com/source",
      results: 2,
      timestamp: 1791000002000,
      urls: ["https://example.com/source"],
      failed: false,
    };
    const reconciliation = reconcileWebSources(
      "- [a](https://example.com/a) (retrieved 2026-10-03).",
      [fetchCall, check],
    );

    expect(reconciliation.failure).toBeUndefined();
  });

  it("keeps an uncited search non-fatal", () => {
    const search: WebCall = {
      tool: "web_search",
      target: "topic",
      results: 5,
      timestamp: 1791000000000,
      urls: ["https://example.com/unused"],
      failed: false,
    };
    const reconciliation = reconcileWebSources("- nothing cited.", [search]);

    expect(reconciliation.failure).toBeUndefined();
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

  it("keeps balanced parentheses inside a URL", () => {
    expect(
      extractUrls("see https://en.wikipedia.org/wiki/Mercury_(planet) today"),
    ).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  });

  it("keeps nested balanced parentheses inside a URL", () => {
    expect(
      extractUrls("see https://en.wikipedia.org/wiki/Foo_(bar_(baz)) today"),
    ).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar_(baz))"]);
  });

  it("leaves a sentence's wrapping closing parenthesis out of the URL", () => {
    expect(extractUrls("(see https://example.com/x_(y) for details)")).toEqual([
      "https://example.com/x_(y)",
    ]);
  });
});
