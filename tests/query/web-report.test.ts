import { describe, expect, it } from "vitest";
import {
  CODEX_AUDIT_FENCE,
  parseAgentJsonStream,
  parseCodexReport,
} from "../../src/query/web-report.ts";
import { assistantTextLine, toolCallLine, toolResultLine } from "./helpers.ts";

/** A fixed parse clock: the wrapper-stamped timestamps stay assertable. */
const NOW = () => new Date(1791000000000);

/** A contract-shaped codex report: the enrichment bullets, then the
 *  fenced audit block. */
function codexReport(bullets: string, blockLines: readonly string[]): string {
  return [bullets, "", CODEX_AUDIT_FENCE, ...blockLines, "```"].join("\n");
}

describe("parseCodexReport", () => {
  it("records every web call the audit block lists, in order", () => {
    const report = codexReport("- [a](https://example.com/a) says so.", [
      "web_search | rag vs fine-tuning | https://example.com/a https://example.com/b",
      "web_search | https://example.com/a | https://example.com/a",
    ]);

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.calls.map((call) => call.tool)).toEqual([
      "web_search",
      "web_search",
    ]);
  });

  it("records the call's target", () => {
    const report = codexReport("- done.", [
      "web_search | rag vs fine-tuning | https://example.com/a",
    ]);

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.calls[0]?.target).toBe("rag vs fine-tuning");
  });

  it("collects the line's urls into the call's url set", () => {
    const report = codexReport("- done.", [
      "web_search | rag vs fine-tuning | https://example.com/a https://example.com/a https://example.com/b",
    ]);

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.calls[0]?.urls).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("stamps every call with the wrapper's clock, model-free", () => {
    const report = codexReport("- done.", [
      "web_search | q | https://example.com/a",
      "web_search | https://example.com/a | https://example.com/a",
    ]);

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.calls.map((call) => call.timestamp)).toEqual([
      1791000000000, 1791000000000,
    ]);
  });

  it("tolerates a call line with no urls", () => {
    const report = codexReport("- done.", ["web_search | empty query |"]);

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.calls[0]?.urls).toEqual([]);
  });

  it("skips blank lines inside the audit block", () => {
    const report = [
      "- done.",
      "",
      CODEX_AUDIT_FENCE,
      "",
      "web_search | q | https://example.com/a",
      "",
      "```",
    ].join("\n");

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.calls).toHaveLength(1);
  });

  it("takes the enrichment text from before the audit block", () => {
    const report = codexReport(
      "- [a](https://example.com/a) confirms the topic.",
      ["web_search | q | https://example.com/a"],
    );

    const parsed = parseCodexReport(report, NOW);

    expect(parsed.enrichment).toBe(
      "- [a](https://example.com/a) confirms the topic.",
    );
  });

  it("fails named when the report carries no audit block", () => {
    expect(() => parseCodexReport("- done, no block.", NOW)).toThrow(
      "the codex report carried no ```k-wiki-web-audit block",
    );
  });

  it("fails named when the audit block never closes", () => {
    const report = ["- done.", "", CODEX_AUDIT_FENCE, "web_search | q |"].join(
      "\n",
    );

    expect(() => parseCodexReport(report, NOW)).toThrow(
      "the codex ```k-wiki-web-audit block never closed",
    );
  });

  it("fails named when a call line does not split into three fields", () => {
    const report = codexReport("- done.", ["web_search missing pipes"]);

    expect(() => parseCodexReport(report, NOW)).toThrow(
      "the codex ```k-wiki-web-audit block carried a malformed call line: web_search missing pipes",
    );
  });

  it("fails named when content follows the audit block", () => {
    const report = [
      "- done.",
      "",
      CODEX_AUDIT_FENCE,
      "web_search | q | https://example.com/a",
      "```",
      "some closing remark",
    ].join("\n");

    expect(() => parseCodexReport(report, NOW)).toThrow(
      "the codex report carried content after the ```k-wiki-web-audit block",
    );
  });
});

describe("parseAgentJsonStream", () => {
  it("records every web tool call in order", () => {
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
  });

  it("records the first call's target", () => {
    const stream = [
      toolCallLine("c1", { query: "first query" }),
      toolResultLine("c1", "results one", { totalResults: 5 }),
      toolCallLine("c2", { url: "https://example.com/b" }),
      toolResultLine("c2", "fetched b"),
      assistantTextLine("- done"),
    ].join("\n");

    const parsed = parseAgentJsonStream(stream);

    expect(parsed.calls[0]?.target).toBe("first query");
  });

  it("records the first call's result count", () => {
    const stream = [
      toolCallLine("c1", { query: "first query" }),
      toolResultLine("c1", "results one", { totalResults: 5 }),
      toolCallLine("c2", { url: "https://example.com/b" }),
      toolResultLine("c2", "fetched b"),
      assistantTextLine("- done"),
    ].join("\n");

    const parsed = parseAgentJsonStream(stream);

    expect(parsed.calls[0]?.results).toBe(5);
  });

  it("records the second call's target", () => {
    const stream = [
      toolCallLine("c1", { query: "first query" }),
      toolResultLine("c1", "results one", { totalResults: 5 }),
      toolCallLine("c2", { url: "https://example.com/b" }),
      toolResultLine("c2", "fetched b"),
      assistantTextLine("- done"),
    ].join("\n");

    const parsed = parseAgentJsonStream(stream);

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

  it("keeps the enrichment from non-JSON lines", () => {
    const parsed = parseAgentJsonStream(
      ["not json", assistantTextLine("- ok")].join("\n"),
    );

    expect(parsed.enrichment).toBe("- ok");
  });

  it("records no calls from non-JSON lines", () => {
    const parsed = parseAgentJsonStream(
      ["not json", assistantTextLine("- ok")].join("\n"),
    );

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
