import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/ingest/wiki-ingest.ts";
import {
  canAnimate,
  classifyVerdict,
  composeQueryPrompt,
  main,
  parseAgentReply,
  QUERY_HEARTBEAT_PREFIX,
  renderVerdict,
  runWikiQuery,
  terminalColors,
} from "../src/query/wiki-query.ts";

const SETTINGS_YML = `command: pi
model: GLM-5.2
reasoning: high
`;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("composeQueryPrompt", () => {
  it("appends the question after the prompt text", () => {
    const composed = composeQueryPrompt("QUERY PROMPT", "What is X?", false);

    expect(composed).toContain("QUERY PROMPT");
    expect(composed).toContain("Question: What is X?");
  });

  it("states the file mode as filing allowed", () => {
    const composed = composeQueryPrompt("QUERY PROMPT", "q", false);

    expect(composed).toContain("Mode: file");
  });

  it("states the answer-only mode as write nothing", () => {
    const composed = composeQueryPrompt("QUERY PROMPT", "q", true);

    expect(composed).toContain("Mode: answer-only (--no-file)");
    expect(composed).toContain("write nothing");
  });

  it("instructs the agent to end with one QUERY status line", () => {
    const composed = composeQueryPrompt("QUERY PROMPT", "q", false);

    expect(composed).toContain("QUERY: filed —");
    expect(composed).toContain("QUERY: meets-bar —");
    expect(composed).toContain("QUERY: not-filed —");
    expect(composed).toContain("QUERY: not-answerable —");
  });

  it("renders the exact file-mode format", () => {
    expect(composeQueryPrompt("QUERY PROMPT", "What is X?", false)).toBe(
      [
        "QUERY PROMPT",
        "",
        "Question: What is X?",
        "",
        "Mode: file — filing is allowed: when the answer meets the bar, create the query page and update index.md and log.md per the rules above.",
        "",
        "End your reply with exactly one status line, nothing after it, the first that applies:",
        "QUERY: filed — <the wiki/queries/ pages you created or updated>",
        "QUERY: meets-bar — <why the answer deserves filing>",
        "QUERY: not-filed — <why the filing bar is not met>",
        "QUERY: not-answerable — <which sources to ingest next>",
      ].join("\n"),
    );
  });

  it("renders the exact answer-only format", () => {
    expect(composeQueryPrompt("QUERY PROMPT", "What is X?", true)).toBe(
      [
        "QUERY PROMPT",
        "",
        "Question: What is X?",
        "",
        "Mode: answer-only (--no-file) — write nothing: no query page, no index.md or log.md change; the reply is the only output.",
        "",
        "End your reply with exactly one status line, nothing after it, the first that applies:",
        "QUERY: filed — <the wiki/queries/ pages you created or updated>",
        "QUERY: meets-bar — <why the answer deserves filing>",
        "QUERY: not-filed — <why the filing bar is not met>",
        "QUERY: not-answerable — <which sources to ingest next>",
      ].join("\n"),
    );
  });
});

describe("parseAgentReply", () => {
  it("splits a trailing not-filed status line from the answer", () => {
    const reply = parseAgentReply(
      "Prefer RAG when…\n\nQUERY: not-filed — verbatim restatement of a single page",
    );

    expect(reply).toEqual({
      answer: "Prefer RAG when…",
      kind: "not-filed",
      detail: "verbatim restatement of a single page",
    });
  });

  it("parses a trailing filed status line", () => {
    const reply = parseAgentReply(
      "A.\n\nQUERY: filed — wiki/queries/rag-vs-finetuning.md",
    );

    expect(reply.kind).toBe("filed");
    expect(reply.detail).toBe("wiki/queries/rag-vs-finetuning.md");
  });

  it("parses a trailing meets-bar status line", () => {
    expect(
      parseAgentReply("A.\nQUERY: meets-bar — synthesizes 3 pages"),
    ).toMatchObject({
      kind: "meets-bar",
      detail: "synthesizes 3 pages",
    });
  });

  it("parses a trailing not-answerable status line", () => {
    expect(
      parseAgentReply("A.\nQUERY: not-answerable — ingest the RAG notes first"),
    ).toMatchObject({
      kind: "not-answerable",
      detail: "ingest the RAG notes first",
    });
  });

  it("reports unknown when no status line is present", () => {
    expect(parseAgentReply("Just an answer.")).toEqual({
      answer: "Just an answer.",
      kind: "unknown",
      detail: undefined,
    });
  });

  it("treats a status line that is not the last line as answer text", () => {
    const reply = parseAgentReply(
      "QUERY: not-filed — too early\nbut the answer goes on.",
    );

    expect(reply.kind).toBe("unknown");
    expect(reply.answer).toContain("too early");
  });

  it("reports unknown for a status line without detail", () => {
    expect(parseAgentReply("A.\nQUERY: not-filed").kind).toBe("unknown");
  });

  it("reports an empty answer when the output is only the status line", () => {
    expect(parseAgentReply("\nQUERY: not-filed — r\n\n").answer).toBe("");
  });

  it("trims whitespace around the answer", () => {
    expect(
      parseAgentReply("\n\n  Answer.  \n\nQUERY: not-filed — r\n"),
    ).toEqual({
      answer: "Answer.",
      kind: "not-filed",
      detail: "r",
    });
  });

  it("parses a reply that is only a single-line status", () => {
    expect(parseAgentReply("QUERY: not-filed — r")).toEqual({
      answer: "",
      kind: "not-filed",
      detail: "r",
    });
  });

  it("takes the status line after a one-character first line", () => {
    expect(parseAgentReply("x\nQUERY: not-filed — r")).toEqual({
      answer: "x",
      kind: "not-filed",
      detail: "r",
    });
  });

  it("trims the answer of an unrecognized reply", () => {
    expect(parseAgentReply("  Just an answer.  ").answer).toBe(
      "Just an answer.",
    );
  });
});

const NO_PAGES = { created: [], updated: [], unavailable: undefined };

describe("classifyVerdict", () => {
  it("reports the filed pages in file mode", () => {
    const verdict = classifyVerdict(
      {
        created: ["wiki/queries/rag.md"],
        updated: ["wiki/queries/other.md"],
        unavailable: undefined,
      },
      parseAgentReply("A.\nQUERY: filed — wiki/queries/rag.md"),
      false,
    );

    expect(verdict).toEqual({
      kind: "filed",
      pages: ["wiki/queries/rag.md", "wiki/queries/other.md"],
    });
  });

  it("reports the agent's reason when nothing was filed in file mode", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply(
        "A.\nQUERY: not-filed — verbatim restatement of a single page",
      ),
      false,
    );

    expect(verdict).toEqual({
      kind: "not-filed",
      reason: "verbatim restatement of a single page",
    });
  });

  it("reports the suggested sources when the wiki cannot answer", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply("A.\nQUERY: not-answerable — ingest the RAG notes first"),
      false,
    );

    expect(verdict).toEqual({
      kind: "not-answerable",
      suggestion: "ingest the RAG notes first",
    });
  });

  it("flags an agent that reported filing but changed no wiki/queries page", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply("A.\nQUERY: filed — wiki/queries/rag.md"),
      false,
    );

    expect(verdict.kind).toBe("not-filed");

    if (verdict.kind === "not-filed") {
      expect(verdict.reason).toContain("no wiki/queries change");
      expect(verdict.reason).toContain("wiki/queries/rag.md");
    }
  });

  it("keeps the no-detail marker for a detail-less filed claim", () => {
    expect(
      classifyVerdict(
        NO_PAGES,
        { answer: "A.", kind: "filed", detail: undefined },
        false,
      ),
    ).toEqual({
      kind: "not-filed",
      reason: expect.stringContaining("no detail"),
    });
  });

  it("keeps the no-detail marker for a detail-less meets-bar claim in file mode", () => {
    expect(
      classifyVerdict(
        NO_PAGES,
        { answer: "A.", kind: "meets-bar", detail: undefined },
        false,
      ),
    ).toEqual({
      kind: "not-filed",
      reason: expect.stringContaining("no detail"),
    });
  });

  it("falls back to an empty offer reason when detail is absent", () => {
    expect(
      classifyVerdict(
        NO_PAGES,
        { answer: "A", kind: "meets-bar", detail: undefined },
        true,
      ),
    ).toEqual({ kind: "offer", reason: "" });
  });

  it("falls back to an empty not-filed reason when detail is absent", () => {
    expect(
      classifyVerdict(
        NO_PAGES,
        { answer: "A", kind: "not-filed", detail: undefined },
        true,
      ),
    ).toEqual({ kind: "not-filed", reason: "" });
  });

  it("falls back to an empty suggestion when detail is absent", () => {
    expect(
      classifyVerdict(
        NO_PAGES,
        { answer: "A", kind: "not-answerable", detail: undefined },
        true,
      ),
    ).toEqual({ kind: "not-answerable", suggestion: "" });
  });

  it("does not flag a claimed filing when git status was unavailable", () => {
    const verdict = classifyVerdict(
      { created: [], updated: [], unavailable: "no git" },
      parseAgentReply("A.\nQUERY: filed — wiki/queries/rag.md"),
      false,
    );

    expect(verdict.kind).toBe("none");
  });

  it("flags an agent that met the bar in file mode but filed nothing", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply("A.\nQUERY: meets-bar — synthesizes 3 pages"),
      false,
    );

    expect(verdict.kind).toBe("not-filed");

    if (verdict.kind === "not-filed") {
      expect(verdict.reason).toContain("synthesizes 3 pages");
    }
  });

  it("offers the rerun hint for a meets-bar answer in answer-only mode", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply("A.\nQUERY: meets-bar — synthesizes 3 pages"),
      true,
    );

    expect(verdict).toEqual({
      kind: "offer",
      reason: "synthesizes 3 pages",
    });
  });

  it("reports the not-filed reason in answer-only mode too", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply(
        "A.\nQUERY: not-filed — verbatim restatement of a single page",
      ),
      true,
    );

    expect(verdict.kind).toBe("not-filed");
  });

  it("reports not-answerable in answer-only mode", () => {
    const verdict = classifyVerdict(
      NO_PAGES,
      parseAgentReply("A.\nQUERY: not-answerable — ingest X first"),
      true,
    );

    expect(verdict.kind).toBe("not-answerable");
  });

  it("stays silent when the agent gave no usable status", () => {
    expect(
      classifyVerdict(NO_PAGES, parseAgentReply("Just an answer."), false),
    ).toEqual({ kind: "none" });
  });

  it("stays silent when the agent claims filing in answer-only mode", () => {
    expect(
      classifyVerdict(
        NO_PAGES,
        parseAgentReply("A.\nQUERY: filed — wiki/queries/rag.md"),
        true,
      ).kind,
    ).toBe("none");
  });
});

describe("renderVerdict", () => {
  it("renders one bold line per filed page", () => {
    expect(
      renderVerdict({
        kind: "filed",
        pages: ["wiki/queries/a.md", "wiki/queries/b.md"],
      }),
    ).toEqual([
      { text: "Filed: wiki/queries/a.md", bold: true },
      { text: "Filed: wiki/queries/b.md", bold: true },
    ]);
  });

  it("renders the not-filed reason bold", () => {
    expect(renderVerdict({ kind: "not-filed", reason: "single page" })).toEqual(
      [{ text: "Not filed: single page", bold: true }],
    );
  });

  it("renders the rerun offer bold", () => {
    expect(
      renderVerdict({ kind: "offer", reason: "synthesizes 3 pages" }),
    ).toEqual([
      {
        text: "Meets the filing bar (synthesizes 3 pages); rerun without --no-file to file it.",
        bold: true,
      },
    ]);
  });

  it("renders the not-answerable line plain", () => {
    expect(
      renderVerdict({ kind: "not-answerable", suggestion: "ingest X first" }),
    ).toEqual([{ text: "Not answerable: ingest X first", bold: false }]);
  });

  it("renders nothing for the silent verdict", () => {
    expect(renderVerdict({ kind: "none" })).toEqual([]);
  });
});

describe("canAnimate", () => {
  it("animates only on a TTY with color enabled", () => {
    expect(canAnimate(true, {})).toBe(true);
    expect(canAnimate(true, { NO_COLOR: "1" })).toBe(false);
    expect(canAnimate(false, {})).toBe(false);
  });
});

describe("terminalColors", () => {
  it("disables bold under NO_COLOR", () => {
    expect(terminalColors({ NO_COLOR: "1" }).bold("x")).toBe("x");
  });

  it("emits bold codes when color is enabled", () => {
    expect(terminalColors({}).bold("x")).not.toBe("x");
  });
});

const run = promisify(execFile);

interface Harness {
  readonly dataRoot: string;
  readonly promptsDir: string;
  readonly settingsPath: string;
  readonly invocations: {
    command: string;
    args: readonly string[];
    cwd: string;
  }[];
  runAgent: AgentRunner;
}

/**
 * A data repo (git-tracked wiki/, empty raw/) with a query prompt and
 * a recording agent runner. The default runner files a query page and
 * reports it; tests override it per case.
 */
async function makeHarness(): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-query-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Log\n");
  await writeFile(join(dataRoot, "wiki", "concepts", "rag.md"), "RAG\n");

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ],
    { cwd: dataRoot },
  );

  const promptsDir = join(dataRoot, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "query.md"), "QUERY PROMPT");

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(settingsPath, SETTINGS_YML);

  const invocations: Harness["invocations"] = [];
  const runAgent: AgentRunner = async (command, args, options) => {
    invocations.push({ command, args, cwd: options.cwd });

    if (options.cwd === undefined) {
      throw new Error("unreachable");
    }

    await mkdir(join(options.cwd, "wiki", "queries"), { recursive: true });
    await writeFile(
      join(options.cwd, "wiki", "queries", "rag-vs-finetuning.md"),
      "---\ntype: query\n---\n",
    );
    await writeFile(join(options.cwd, "wiki", "index.md"), "# Index v2\n");

    return {
      stdout:
        "Prefer RAG when the knowledge base changes often.\n\nQUERY: filed — wiki/queries/rag-vs-finetuning.md",
      stderr: "",
    };
  };

  return { dataRoot, promptsDir, settingsPath, invocations, runAgent };
}

function optionsFor(h: Harness, overrides: Record<string, unknown> = {}) {
  return {
    settingsPath: h.settingsPath,
    rawDir: join(h.dataRoot, "raw"),
    promptsDir: h.promptsDir,
    question: "When should I prefer RAG over fine-tuning?",
    runAgent: h.runAgent,
    ...overrides,
  };
}

/** The recorded invocation at `index`; fails loudly when absent. */
function invocation(h: Harness, index: number) {
  const recorded = h.invocations[index];

  if (recorded === undefined) {
    throw new Error(`agent was not invoked (call ${index})`);
  }

  return recorded;
}

describe("runWikiQuery", () => {
  it("sends the prompt, the question, and the mode to the agent", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    const payload = invocation(h, 0).args.at(-1);

    expect(payload).toContain("QUERY PROMPT");
    expect(payload).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
    expect(payload).toContain("Mode: file");
  });

  it("states the answer-only mode in the payload", async () => {
    const h = await makeHarness();

    await runWikiQuery({ ...optionsFor(h), noFile: true });

    expect(invocation(h, 0).args.at(-1)).toContain("Mode: answer-only");
  });

  it("invokes the agent in the data repo root", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).cwd).toBe(h.dataRoot);
  });

  it("passes the model and reasoning level from settings as agent flags", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("GLM-5.2");
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
    expect(args).toContain("--print");
  });

  it("reports the answer parsed from the agent output", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery(optionsFor(h));

    expect(result.reply.answer).toBe(
      "Prefer RAG when the knowledge base changes often.",
    );
    expect(result.reply.kind).toBe("filed");
  });

  it("derives the filed pages from the wiki/queries git status", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery(optionsFor(h));

    expect(result.pages).toEqual({
      created: ["wiki/queries/rag-vs-finetuning.md"],
      updated: [],
      unavailable: undefined,
    });
  });

  it("lists only wiki/queries pages, not other wiki edits", async () => {
    const h = await makeHarness();
    const noisy: AgentRunner = async (command, args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "concepts", "rag.md"),
        "RAG v2\n",
      );

      return h.runAgent(command, args, options);
    };

    const result = await runWikiQuery({ ...optionsFor(h), runAgent: noisy });

    expect(result.pages.created).toEqual(["wiki/queries/rag-vs-finetuning.md"]);
    expect(result.pages.updated).toEqual([]);
  });

  it("does not run git for pages in answer-only mode", async () => {
    const h = await makeHarness();

    await run("git", ["-C", h.dataRoot, "checkout", "--quiet", "."]);

    const writing: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "queries"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "queries", "rogue.md"),
        "rogue\n",
      );

      return {
        stdout: "A.\n\nQUERY: meets-bar — synthesizes 3 pages",
        stderr: "",
      };
    };

    const result = await runWikiQuery({
      ...optionsFor(h),
      noFile: true,
      runAgent: writing,
    });

    expect(result.pages).toEqual(NO_PAGES);
  });

  it("keeps the unanswerable run successful with its suggestion", async () => {
    const h = await makeHarness();
    const plain: AgentRunner = async () => ({
      stdout: "No page covers this.\n\nQUERY: not-answerable — ingest X first",
      stderr: "",
    });

    const result = await runWikiQuery({
      ...optionsFor(h),
      runAgent: plain,
    });

    expect(result.reply.kind).toBe("not-answerable");
  });

  it("reports each pipeline step on the progress sink", async () => {
    const h = await makeHarness();
    const messages: string[] = [];

    await runWikiQuery({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      expect.stringContaining("wiki-query: data repo"),
      expect.stringContaining(
        "wiki-query: invoking agent: pi --model GLM-5.2 --thinking high",
      ),
      "wiki-query: agent finished",
    ]);
  });

  it("emits a heartbeat while a slow agent run is in flight", async () => {
    const h = await makeHarness();
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "A.\nQUERY: not-filed — r", stderr: "" };
    };

    await runWikiQuery({
      ...optionsFor(h),
      runAgent: slow,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual(
      expect.arrayContaining(["wiki-query: querying the wiki (0s)"]),
    );
  });

  it("stops the heartbeat when the agent run ends", async () => {
    const h = await makeHarness();
    const messages: string[] = [];
    const fast: AgentRunner = async () => ({
      stdout: "A.\nQUERY: not-filed — r",
      stderr: "",
    });

    await runWikiQuery({
      ...optionsFor(h),
      runAgent: fast,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      messages.filter((message) => message.includes(QUERY_HEARTBEAT_PREFIX)),
    ).toEqual([]);
  });

  it("enforces the timeout on the real agent runner", async () => {
    const h = await makeHarness();
    const sleeper = join(h.dataRoot, "sleep-agent.mjs");

    await writeFile(
      sleeper,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${sleeper}\nmodel: M\nreasoning: low\n`,
    );

    let message = "";

    try {
      await runWikiQuery({
        settingsPath: h.settingsPath,
        rawDir: join(h.dataRoot, "raw"),
        promptsDir: h.promptsDir,
        question: "q",
        timeoutMs: 200,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 1 second$/);
  });

  it("fails naming the prompt file when it is missing", async () => {
    const h = await makeHarness();

    await rm(join(h.promptsDir, "query.md"));

    await expect(runWikiQuery(optionsFor(h))).rejects.toThrow(
      "cannot read prompt",
    );
  });

  it("fails naming the settings file when it cannot be read", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), settingsPath: "/no/such/settings.yml" }),
    ).rejects.toThrow("cannot read agent settings");
  });

  it("propagates an agent failure", async () => {
    const h = await makeHarness();
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow("code 1");
  });

  it("reports unavailable pages when the data repo has no git", async () => {
    const h = await makeHarness();

    await rm(join(h.dataRoot, ".git"), { recursive: true });

    const result = await runWikiQuery(optionsFor(h));

    expect(result.pages).toEqual({
      created: [],
      updated: [],
      unavailable: expect.any(String),
    });
  });
});

describe("wiki-query CLI", () => {
  const STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);

if (prompt.includes("answer-only")) {
  console.log("Graph engineering is…\\n\\nQUERY: meets-bar — synthesizes 3 pages");
} else {
  await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
  await writeFile(join(process.cwd(), "wiki", "queries", "stub-q.md"), "stub");
  console.log("Prefer RAG when…\\n\\nQUERY: filed — wiki/queries/stub-q.md");
}
`;

  /** A harness whose settings point at an executable stub agent. */
  async function makeCliHarness(): Promise<Harness> {
    const h = await makeHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(stub, STUB, { mode: 0o755 });
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    return h;
  }

  async function runCli(args: string[]): Promise<{ out: string; err: string }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), ...args];
    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  function queryArgs(h: Harness, extra: string[] = []) {
    return [
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      ...extra,
      "When should I prefer RAG over fine-tuning?",
    ];
  }

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-query [-h | --help] [--no-file] [--settings <path>] [--raw-dir <dir>] [--timeout <secs>] <question>",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the switches and defaults in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--no-file");
    expect(out).toContain("--settings");
    expect(out).toContain("--raw-dir");
    expect(out).toContain("--timeout <secs>");
    expect(out).toContain("Default");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "leftover-arg"]);

    expect(out).toContain("Usage: wiki-query");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 with a stderr message when the question is missing", async () => {
    const { err } = await runCli(["--settings", "/no/such/settings.yml"]);

    expect(err).toContain("a question is required");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for more than one positional argument", async () => {
    const { err } = await runCli(["one", "two"]);

    expect(err).toContain("expected exactly one <question>");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for an unknown option", async () => {
    const { err } = await runCli(["--bogus", "q"]);

    expect(err).toContain("unknown option");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --settings has no value", async () => {
    const { err } = await runCli(["--settings"]);

    expect(err).toContain("--settings needs a path value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --raw-dir has no value", async () => {
    const { err } = await runCli(["--raw-dir"]);

    expect(err).toContain("--raw-dir needs a path value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout without a value", async () => {
    const { err } = await runCli(["--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout zero", async () => {
    const { err } = await runCli(["--timeout", "0", "q"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout negative", async () => {
    const { err } = await runCli(["--timeout", "-5", "q"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const { err } = await runCli(["--timeout", "abc", "q"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const { err } = await runCli(["--timeout", "5x", "q"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 with a stderr message when settings cannot be read", async () => {
    const { err } = await runCli(["--settings", "/no/such/settings.yml", "q"]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints the answer and the bold Filed verdict in default mode", async () => {
    const h = await makeCliHarness();
    const { out, err } = await runCli(queryArgs(h));

    expect(out).toContain("Prefer RAG when…");
    expect(out).toContain("Filed: wiki/queries/stub-q.md");
    expect(err).toContain("wiki-query: invoking agent");
    expect(process.exitCode).toBeUndefined();
  });

  it("passes the question through to the agent payload", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const prompt = await (await import("node:fs/promises")).readFile(
      join(h.dataRoot, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
  });

  it("prints the offer and writes nothing under wiki/ in --no-file mode", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h, ["--no-file"]));

    expect(out).toContain("Graph engineering is…");
    expect(out).toContain(
      "Meets the filing bar (synthesizes 3 pages); rerun without --no-file to file it.",
    );

    const { stat } = await import("node:fs/promises");

    await expect(
      stat(join(h.dataRoot, "wiki", "queries")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the not-answerable line plainly and exits 0", async () => {
    const h = await makeCliHarness();

    await (await import("node:fs/promises")).writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      `#!/usr/bin/env node
const index = process.argv.indexOf("--print");
if (index === -1) process.exit(3);
console.log("No page covers this.\\n\\nQUERY: not-answerable — ingest X first");
`,
      { mode: 0o755 },
    );

    const { out } = await runCli(queryArgs(h));

    expect(out).toContain("Not answerable: ingest X first");
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h, ["--timeout", "1800"]));

    expect(out).toContain("Filed: wiki/queries/stub-q.md");
    expect(process.exitCode).toBeUndefined();
  });

  it("bolds the Filed verdict but not the answer", async () => {
    const h = await makeCliHarness();
    const prior = process.env.NO_COLOR;

    delete process.env.NO_COLOR;

    try {
      const { out } = await runCli(queryArgs(h));
      const filed = out.split("\n").find((line) => line.includes("Filed:"));

      expect(filed).toContain("\u001b[1m");
      expect(out.split("\n")[0]).not.toContain("\u001b");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("prints the not-answerable line without bold codes", async () => {
    const h = await makeCliHarness();

    await (await import("node:fs/promises")).writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      `#!/usr/bin/env node
const index = process.argv.indexOf("--print");
if (index === -1) process.exit(3);
console.log("No page covers this.\\n\\nQUERY: not-answerable — ingest X first");
`,
      { mode: 0o755 },
    );

    const prior = process.env.NO_COLOR;

    delete process.env.NO_COLOR;

    try {
      const { out } = await runCli(queryArgs(h));
      const line = out.split("\n").find((l) => l.includes("Not answerable"));

      expect(line).not.toContain("\u001b");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("prints no empty answer line when the agent replies with only a status line", async () => {
    const h = await makeCliHarness();

    await (await import("node:fs/promises")).writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nconsole.log('\\nQUERY: not-filed — single page restatement\\n');\n",
      { mode: 0o755 },
    );

    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { out } = await runCli(queryArgs(h));

      expect(out).toBe("\nNot filed: single page restatement");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("prints only the answer when the agent sends no status line", async () => {
    const h = await makeCliHarness();

    await (await import("node:fs/promises")).writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nconsole.log('Just an answer.');\n",
      { mode: 0o755 },
    );

    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { out } = await runCli(queryArgs(h));

      expect(out).toBe("Just an answer.");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeCliHarness();

    await (await import("node:fs/promises")).writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    const { err } = await runCli(queryArgs(h, ["--timeout", "1"]));

    expect(err).toMatch(/timed out after 1 second/);
    expect(process.exitCode).toBe(1);
  });
});
