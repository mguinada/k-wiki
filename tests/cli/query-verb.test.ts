import { describe, expect, it } from "vitest";
import { queryUsageError, webVerbError } from "../../src/cli/query-verb.ts";

/**
 * The one-shot query verb module (issue #452's extraction from
 * agent-verbs.ts): the verb's usage errors. The runner itself is
 * covered end to end by the k-wiki e2e suite; the parse-level
 * `--web` acceptance lives in tests/cli/agent-verbs.test.ts.
 */

describe("queryUsageError", () => {
  it("requires a question", () => {
    expect(queryUsageError([])).toContain(
      'a question is required: k-wiki query "<question>"',
    );
  });

  it("rejects an empty question", () => {
    expect(queryUsageError(["  "])).toContain("a question is required");
  });

  it("rejects two positional arguments", () => {
    expect(queryUsageError(["a", "b"])).toContain(
      "expected exactly one <question> argument, got 2",
    );
  });

  it("accepts one question", () => {
    expect(queryUsageError(["rag?"])).toBeUndefined();
  });
});

describe("webVerbError", () => {
  it("rejects --web on a verb other than query", () => {
    expect(webVerbError("status", true)).toContain(
      "--web belongs to k-wiki query",
    );
  });

  it("accepts --web for query", () => {
    expect(webVerbError("query", true)).toBeUndefined();
  });

  it("accepts its absence on any verb", () => {
    expect(webVerbError("status", false)).toBeUndefined();
  });
});
