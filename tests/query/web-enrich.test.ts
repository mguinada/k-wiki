import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import {
  type AgentSettings,
  ISOLATION_FLAGS,
} from "../../src/ingest/agent-settings.ts";
import { WEB_SOURCES_HEADING } from "../../src/query/web-artifact.ts";
import {
  composeEnrichmentPrompt,
  enrichmentArtifact,
  runWebEnrichment,
  WEB_ENRICH_HEARTBEAT_PREFIX,
  WEB_ENRICH_PROMPT_FILE,
  WEB_EXTENSION_SOURCE,
  WEB_FAILED_WARNING,
  WEB_TOOL_ALLOWLIST,
  webEnrichAgentArgs,
  withGapHint,
} from "../../src/query/web-enrich.ts";
import { assistantTextLine, toolCallLine, toolResultLine } from "./helpers.ts";

const SETTINGS: AgentSettings = {
  command: "pi",
  model: "GLM-5.2",
  reasoning: "high",
};

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("webEnrichAgentArgs", () => {
  it("keeps the ambient isolation flags ahead of the grant", () => {
    const args = webEnrichAgentArgs(SETTINGS, [...ISOLATION_FLAGS], "PROMPT");
    const grant = args.indexOf("-e");

    expect(args.slice(0, 3)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
    ]);
    expect(grant).toBeGreaterThan(2);
  });

  it("grants exactly the pi-web-access extension and the search+fetch allowlist", () => {
    const args = webEnrichAgentArgs(SETTINGS, [...ISOLATION_FLAGS], "PROMPT");

    expect(args[args.indexOf("-e") + 1]).toBe(WEB_EXTENSION_SOURCE);
    expect(args[args.indexOf("--tools") + 1]).toBe(WEB_TOOL_ALLOWLIST);
  });

  it("exposes no other extension tool than the allowlist names", () => {
    const args = webEnrichAgentArgs(
      SETTINGS,
      [...ISOLATION_FLAGS],
      "PROMPT",
    ).join(" ");

    expect(args).not.toContain("get_search_content");
  });

  it("runs the enrichment in the machine-readable json output mode", () => {
    const args = webEnrichAgentArgs(SETTINGS, [...ISOLATION_FLAGS], "PROMPT");

    expect(args[args.indexOf("--mode") + 1]).toBe("json");
    expect(args[args.indexOf("--print") + 1]).toBe("PROMPT");
  });

  it("honors the operator's isolate: false opt-out for the isolation flags", () => {
    const args = webEnrichAgentArgs(
      { ...SETTINGS, isolate: false },
      [...ISOLATION_FLAGS],
      "PROMPT",
    );

    expect(args).not.toContain("--no-extensions");
    expect(args).toContain("-e");
  });

  it("keeps the provider flag when the settings carry one", () => {
    const args = webEnrichAgentArgs(
      { ...SETTINGS, provider: "zai" },
      [...ISOLATION_FLAGS],
      "PROMPT",
    );

    expect(args[args.indexOf("--provider") + 1]).toBe("zai");
  });
});

describe("composeEnrichmentPrompt", () => {
  it("carries the policy text, question, and core answer verbatim", () => {
    const composed = composeEnrichmentPrompt(
      "POLICY",
      "What is X?",
      "CORE ANSWER",
      "2026-10-03",
    );

    expect(composed).toContain("POLICY");
    expect(composed).toContain("Question: What is X?");
    expect(composed).toContain("CORE ANSWER");
    expect(composed).toContain("Today's date is 2026-10-03");
  });

  it("tells the enrichment it may not rewrite the core document", () => {
    const composed = composeEnrichmentPrompt("POLICY", "Q", "CORE", "2026");

    expect(composed).toContain("read-only");
    expect(composed).toContain("never rewrite");
  });
});

describe("withGapHint", () => {
  it("appends the rerun hint to a gap answer", () => {
    const hinted = withGapHint("The wiki cannot answer this question.");

    expect(hinted).toContain("rerunning with `--web` may enrich the topic");
  });

  it("leaves an answerable question untouched", () => {
    const answer = "See [[retrieval-augmented-generation]].";

    expect(withGapHint(answer)).toBe(answer);
  });
});

describe("runWebEnrichment", () => {
  /** The read enrichment prompt text, as the caller passes it. */
  async function makePromptsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-web-prompts-"));

    tempDirs.push(dir);

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, WEB_ENRICH_PROMPT_FILE),
      "Enrich the topic from the web.",
    );

    return "Enrich the topic from the web.";
  }

  /** A runner returning one canned stdout payload. */
  const canned = (stdout: string) => async () => ({ stdout, stderr: "" });

  const okStream = [
    toolCallLine("c1", { query: "topic" }),
    toolResultLine("c1", "https://example.com/a", { totalResults: 3 }),
    toolCallLine("c2", { url: "https://example.com/a" }),
    toolResultLine("c2", "page text"),
    assistantTextLine(
      "- [a](https://example.com/a) confirms the topic (retrieved 2026-10-03).",
    ),
  ].join("\n");

  it("renders the three machine-owned sections from the recorded audit", async () => {
    const outcome = await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    expect(outcome.kind).toBe("ok");

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.enrichment).toContain(
      "- [a](https://example.com/a) confirms the topic",
    );
    expect(outcome.web.sources).toContain(
      "- https://example.com/a — retrieved",
    );
    expect(outcome.web.audit).toContain("| 1 | web_search | topic | 3 |");
    expect(outcome.web.audit).toContain(
      "| 2 | web_search | https://example.com/a |",
    );
    expect(outcome.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("degrades when the enrichment run fails to spawn", async () => {
    const outcome = await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: async () => {
        throw new Error("agent timed out after 1800 seconds");
      },
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "agent timed out after 1800 seconds",
    });
  });

  it("degrades when the enrichment run produces no output", async () => {
    const outcome = await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(assistantTextLine("").replace("- done", "")),
    });

    expect(outcome.kind).toBe("failed");
  });

  it("degrades when the audit does not reconcile", async () => {
    const hallucinated = [
      toolCallLine("c1", { query: "topic" }),
      toolResultLine("c1", "https://example.com/a", { totalResults: 1 }),
      assistantTextLine(
        "- [x](https://example.com/not-in-audit) (retrieved 2026-10-03).",
      ),
    ].join("\n");
    const outcome = await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(hallucinated),
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason:
        "cited URL absent from the audit table: https://example.com/not-in-audit",
    });
  });

  it("reconciles the rendered text only — imitation below the first owned line neither cites nor fails", async () => {
    const imitating = [
      toolCallLine("c1", { query: "topic" }),
      toolResultLine("c1", "https://example.com/a", { totalResults: 1 }),
      assistantTextLine(
        [
          "- [a](https://example.com/a) confirms the topic (retrieved 2026-10-03).",
          WEB_SOURCES_HEADING,
          "- [x](https://example.com/model-written) (retrieved 2026-10-03).",
        ].join("\n"),
      ),
    ].join("\n");
    const outcome = await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(imitating),
    });

    expect(outcome.kind).toBe("ok");

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.enrichment).not.toContain("model-written");
    expect(outcome.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("sends the composed prompt through the enrichment argv", async () => {
    const invocations: { command: string; args: readonly string[] }[] = [];

    await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: async (command, args) => {
        invocations.push({ command, args });

        return { stdout: okStream, stderr: "" };
      },
    });

    const invocation = invocations[0];

    expect(invocation?.command).toBe("pi");
    expect(invocation?.args.at(-1)).toContain("Enrich the topic from the web.");
    expect(invocation?.args.at(-1)).toContain("CORE");
  });

  it("emits the enrichment heartbeat while a slow run is in flight", async () => {
    const messages: string[] = [];

    await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({
        rawDir: join(tmpdir(), "k-wiki-web-run-raw"),
        onProgress: (message) => messages.push(message),
      }),
      runAgent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));

        return { stdout: okStream, stderr: "" };
      },
      heartbeatMs: 40,
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(WEB_ENRICH_HEARTBEAT_PREFIX),
      ]),
    );
  });

  it("stops the enrichment heartbeat when the run ends", async () => {
    const messages: string[] = [];

    await runWebEnrichment({
      identity: SETTINGS,
      isolationFlags: [...ISOLATION_FLAGS],
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({
        rawDir: join(tmpdir(), "k-wiki-web-run-raw"),
        onProgress: (message) => messages.push(message),
      }),
      runAgent: canned(okStream),
      heartbeatMs: 40,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      messages.filter((message) =>
        message.includes(WEB_ENRICH_HEARTBEAT_PREFIX),
      ),
    ).toEqual([]);
  });
});

describe("enrichmentArtifact", () => {
  it("degrades without spawning when the enrichment prompt is unavailable", async () => {
    let spawned = false;

    const result = await enrichmentArtifact(
      {
        question: "Q",
        timestamp: "2026-10-03T21:00:00.000Z",
        pages: [],
        answer: "CORE",
      },
      {
        identity: SETTINGS,
        isolationFlags: [...ISOLATION_FLAGS],
        question: "Q",
        promptText: undefined,
        run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
        runAgent: async () => {
          spawned = true;

          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(spawned).toBe(false);
    expect(result.warning).toBe(WEB_FAILED_WARNING);
    expect(result.answer).toBe("CORE");
    expect(result.artifact).toEqual({
      question: "Q",
      timestamp: "2026-10-03T21:00:00.000Z",
      pages: [],
      answer: "CORE",
      webWarning: WEB_FAILED_WARNING,
    });
  });
});
