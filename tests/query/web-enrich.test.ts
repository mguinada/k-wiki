import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import { piRunner } from "../../src/ingest/agent-runner.ts";
import type { AgentSettings } from "../../src/ingest/agent-settings.ts";
import { WEB_SOURCES_HEADING } from "../../src/query/web-artifact.ts";
import {
  composeEnrichmentPrompt,
  enrichmentArtifact,
  runWebEnrichment,
  WEB_ENRICH_HEARTBEAT_PREFIX,
  WEB_ENRICH_PROMPT_FILE,
  WEB_FAILED_WARNING,
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

describe("composeEnrichmentPrompt", () => {
  it("carries the policy text verbatim", () => {
    const composed = composeEnrichmentPrompt(
      "POLICY",
      "What is X?",
      "CORE ANSWER",
      "2026-10-03",
    );

    expect(composed).toContain("POLICY");
  });

  it("carries the question verbatim", () => {
    const composed = composeEnrichmentPrompt(
      "POLICY",
      "What is X?",
      "CORE ANSWER",
      "2026-10-03",
    );

    expect(composed).toContain("Question: What is X?");
  });

  it("carries the core answer verbatim", () => {
    const composed = composeEnrichmentPrompt(
      "POLICY",
      "What is X?",
      "CORE ANSWER",
      "2026-10-03",
    );

    expect(composed).toContain("CORE ANSWER");
  });

  it("carries today's date into the prompt", () => {
    const composed = composeEnrichmentPrompt(
      "POLICY",
      "What is X?",
      "CORE ANSWER",
      "2026-10-03",
    );

    expect(composed).toContain("Today's date is 2026-10-03");
  });

  it("declares the enrichment read-only", () => {
    const composed = composeEnrichmentPrompt("POLICY", "Q", "CORE", "2026");

    expect(composed).toContain("read-only");
  });

  it("forbids rewriting the core document", () => {
    const composed = composeEnrichmentPrompt("POLICY", "Q", "CORE", "2026");

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

  /** The live 2026-10-04 drift shape: the model cites one URL while
   *  the audited tool result recorded a differently-spelled path. */
  const driftedStream = [
    toolCallLine("c1", { query: "topic" }),
    toolResultLine("c1", "https://example.com/a", { totalResults: 3 }),
    toolCallLine("c2", {
      url: "https://example.com/triage/2026/2026-07-27.md",
    }),
    toolResultLine("c2", "page text"),
    assistantTextLine(
      [
        "- [a](https://example.com/a) confirms the topic (retrieved 2026-10-03).",
        "- [triage](https://example.com/triage/2026/07-27.md) mis-transcribed (retrieved 2026-10-03).",
      ].join("\n"),
    ),
  ].join("\n");

  it("reports a reconciled outcome", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    expect(outcome.kind).toBe("ok");
  });

  it("renders the enrichment section from the audit", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.enrichment).toContain(
      "- [a](https://example.com/a) confirms the topic",
    );
  });

  it("renders the sources section from the audit", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.sources).toContain(
      "- https://example.com/a — retrieved",
    );
  });

  it("renders the audit table rows", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.audit).toContain("| 1 | web_search | topic | 3 |");
  });

  it("extracts the cited sources with retrieval stamps", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.audit).toContain(
      "| 2 | web_search | https://example.com/a |",
    );
  });

  it("renders the three machine-owned sections from the recorded audit", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(okStream),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("degrades when the enrichment run fails to spawn", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
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
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(assistantTextLine("").replace("- done", "")),
    });

    expect(outcome.kind).toBe("failed");
  });

  it("degrades with the persisted reason when pruning empties the enrichment", async () => {
    const hallucinated = [
      toolCallLine("c1", { query: "topic" }),
      toolResultLine("c1", "https://example.com/a", { totalResults: 1 }),
      assistantTextLine(
        "- [x](https://example.com/not-in-audit) (retrieved 2026-10-03).",
      ),
    ].join("\n");
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(hallucinated),
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason:
        "enrichment empty after pruning 1 untraceable citation: https://example.com/not-in-audit (cited URL absent from the audit table)",
    });
  });

  it("stays ok when a drifted citation is pruned to the traceable remainder", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(driftedStream),
    });

    expect(outcome.kind).toBe("ok");
  });

  it("keeps the enrichment section to the traceable remainder", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(driftedStream),
    });

    if (outcome.kind !== "ok") {
      throw new Error("expected an ok outcome");
    }

    expect(outcome.web.enrichment).not.toContain("triage/2026/07-27.md");
  });

  it("renders the pruning record with the drifted URL in the audit section", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(driftedStream),
    });

    if (outcome.kind !== "ok") {
      throw new Error("expected an ok outcome");
    }

    expect(outcome.web.audit).toContain(
      "Pruned citations: 1 — https://example.com/triage/2026/07-27.md (cited URL absent from the audit table)",
    );
  });

  it("counts only the traceable remainder's sources after pruning", async () => {
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(driftedStream),
    });

    if (outcome.kind !== "ok") {
      throw new Error("expected an ok outcome");
    }

    expect(outcome.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("keeps an uncited fetch call non-fatal", async () => {
    const uncitedFetch = [
      toolCallLine("c1", { query: "topic" }),
      toolResultLine("c1", "https://example.com/a", { totalResults: 1 }),
      toolCallLine("c2", { url: "https://example.com/unused" }),
      toolResultLine("c2", "page text"),
      assistantTextLine(
        "- [a](https://example.com/a) confirms the topic (retrieved 2026-10-03).",
      ),
    ].join("\n");
    const outcome = await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(uncitedFetch),
    });

    expect(outcome.kind).toBe("ok");
  });

  it("reconciles imitation below the owned lines", async () => {
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
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(imitating),
    });

    expect(outcome.kind).toBe("ok");
  });

  it("keeps imitation out of the enrichment section", async () => {
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
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(imitating),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.web.enrichment).not.toContain("model-written");
  });

  it("still cites the owned source", async () => {
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
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
      question: "Q",
      coreAnswer: "CORE",
      promptText: await makePromptsDir(),
      run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
      runAgent: canned(imitating),
    });

    if (outcome.kind !== "ok") {
      return;
    }

    expect(outcome.sources).toEqual([
      { url: "https://example.com/a", retrieved: "2026-10-03" },
    ]);
  });

  it("spawns pi for the enrichment", async () => {
    const invocations: { command: string; args: readonly string[] }[] = [];

    await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
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
  });

  it("sends the enrichment ask through the argv", async () => {
    const invocations: { command: string; args: readonly string[] }[] = [];

    await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
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

    expect(invocation?.args.at(-1)).toContain("Enrich the topic from the web.");
  });

  it("sends the core context through the argv", async () => {
    const invocations: { command: string; args: readonly string[] }[] = [];

    await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
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

    expect(invocation?.args.at(-1)).toContain("CORE");
  });

  it("emits the enrichment heartbeat while a slow run is in flight", async () => {
    const messages: string[] = [];

    await runWebEnrichment({
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
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
      spawn: {
        command: SETTINGS.command,
        grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
        args: (composed: string) => piRunner.webEnrichArgs(SETTINGS, composed),
      },
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
  it("spawns nothing when the prompt is unavailable", async () => {
    let spawned = false;

    await enrichmentArtifact(
      {
        question: "Q",
        timestamp: "2026-10-03T21:00:00.000Z",
        pages: [],
        answer: "CORE",
      },
      {
        spawn: {
          command: SETTINGS.command,
          grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
          args: (composed: string) =>
            piRunner.webEnrichArgs(SETTINGS, composed),
        },
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
  });

  it("warns with the web-failed wording", async () => {
    const result = await enrichmentArtifact(
      {
        question: "Q",
        timestamp: "2026-10-03T21:00:00.000Z",
        pages: [],
        answer: "CORE",
      },
      {
        spawn: {
          command: SETTINGS.command,
          grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
          args: (composed: string) =>
            piRunner.webEnrichArgs(SETTINGS, composed),
        },
        question: "Q",
        promptText: undefined,
        run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
        runAgent: async () => ({ stdout: "", stderr: "" }),
      },
    );

    expect(result.warning).toBe(WEB_FAILED_WARNING);
  });

  it("answers from the core run alone", async () => {
    const result = await enrichmentArtifact(
      {
        question: "Q",
        timestamp: "2026-10-03T21:00:00.000Z",
        pages: [],
        answer: "CORE",
      },
      {
        spawn: {
          command: SETTINGS.command,
          grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
          args: (composed: string) =>
            piRunner.webEnrichArgs(SETTINGS, composed),
        },
        question: "Q",
        promptText: undefined,
        run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
        runAgent: async () => ({ stdout: "", stderr: "" }),
      },
    );

    expect(result.answer).toBe("CORE");
  });

  it("saves the degraded artifact shape", async () => {
    const result = await enrichmentArtifact(
      {
        question: "Q",
        timestamp: "2026-10-03T21:00:00.000Z",
        pages: [],
        answer: "CORE",
      },
      {
        spawn: {
          command: SETTINGS.command,
          grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
          args: (composed: string) =>
            piRunner.webEnrichArgs(SETTINGS, composed),
        },
        question: "Q",
        promptText: undefined,
        run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
        runAgent: async () => ({ stdout: "", stderr: "" }),
      },
    );

    expect(result.artifact).toEqual({
      question: "Q",
      timestamp: "2026-10-03T21:00:00.000Z",
      pages: [],
      answer: "CORE",
      webWarning: WEB_FAILED_WARNING,
      webFailureReason: `${WEB_ENRICH_PROMPT_FILE} is unavailable`,
    });
  });

  it("persists the concrete failure reason beside the warning in the artifact", async () => {
    const result = await enrichmentArtifact(
      {
        question: "Q",
        timestamp: "2026-10-03T21:00:00.000Z",
        pages: [],
        answer: "CORE",
      },
      {
        spawn: {
          command: SETTINGS.command,
          grantDisplay: piRunner.capabilities.web.grantArgs.join(" "),
          args: (composed: string) =>
            piRunner.webEnrichArgs(SETTINGS, composed),
        },
        question: "Q",
        promptText: "PROMPT",
        run: runContext({ rawDir: join(tmpdir(), "k-wiki-web-run-raw") }),
        runAgent: async () => {
          throw new Error("agent timed out after 1800 seconds");
        },
      },
    );

    expect(result.artifact.webFailureReason).toBe(
      "agent timed out after 1800 seconds",
    );
  });
});
