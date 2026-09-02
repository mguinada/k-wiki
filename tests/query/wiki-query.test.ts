import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../../src/ingest/agent-run.ts";
import { readQueryArtifact } from "../../src/query/file-last.ts";
import {
  composeQueryPrompt,
  main,
  QUERY_HEARTBEAT_PREFIX,
  runWikiQuery,
} from "../../src/query/wiki-query.ts";

const SETTINGS_YML = `command: pi
model: GLM-5.2
reasoning: high
`;

const tempDirs: string[] = [];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI's default saved-answer path (outputs/ is per-machine). */
const defaultLastQuery = join(repoRoot, "outputs", "last-query.md");

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
  it("carries the prompt text into the composed prompt", () => {
    expect(composeQueryPrompt("QUERY PROMPT", "What is X?")).toContain(
      "QUERY PROMPT",
    );
  });

  it("appends the question after the prompt text", () => {
    expect(composeQueryPrompt("QUERY PROMPT", "What is X?")).toContain(
      "Question: What is X?",
    );
  });

  it("renders the exact answer-only format", () => {
    expect(composeQueryPrompt("QUERY PROMPT", "What is X?")).toBe(
      [
        "QUERY PROMPT",
        "",
        "Question: What is X?",
        "",
        "Mode: answer-only — write nothing: no query page, no index.md or log.md change, no edit anywhere under wiki/; the reply is the only output. The wrapper saves it; the human alone decides later whether to file it.",
      ].join("\n"),
    );
  });
});

const run = promisify(execFile);

interface Harness {
  readonly dataRoot: string;
  readonly promptsDir: string;
  readonly outputsDir: string;
  readonly settingsPath: string;
  readonly invocations: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }[];
  runAgent: AgentRunner;
}

/**
 * The committed wiki/ tree (git-tracked index, log, one concept page;
 * empty raw/), built once per test file and copied per harness: the
 * same tree and init commit every makeHarness used to build with three
 * git spawns of its own. Prompts and settings stay per-harness writes
 * (untracked, exactly as before — the template commits only the wiki).
 */
let dataRepoTemplate: Promise<string> | undefined;

function committedDataRepoTemplate(): Promise<string> {
  dataRepoTemplate ??= (async () => {
    const template = await mkdtemp(join(tmpdir(), "k-wiki-query-tpl-"));

    tempDirs.push(template);

    await mkdir(join(template, "raw"), { recursive: true });
    await mkdir(join(template, "wiki", "concepts"), { recursive: true });
    await writeFile(join(template, "wiki", "index.md"), "# Index\n");
    await writeFile(join(template, "wiki", "log.md"), "# Log\n");
    await writeFile(join(template, "wiki", "concepts", "rag.md"), "RAG\n");

    await run("git", ["init", "--quiet"], { cwd: template });
    await run("git", ["add", "-A"], { cwd: template });
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
      { cwd: template },
    );

    return template;
  })();

  return dataRepoTemplate;
}

/**
 * A data repo (git-tracked wiki/, empty raw/) with a query prompt, an
 * outputs dir, settings, and a recording agent runner. The default
 * runner is a clean answer-only agent: it writes nothing.
 */
async function makeHarness(): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-query-"));

  tempDirs.push(dataRoot);

  await cp(await committedDataRepoTemplate(), dataRoot, { recursive: true });

  const promptsDir = join(dataRoot, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "query.md"), "QUERY PROMPT");

  const outputsDir = join(dataRoot, "outputs");

  await mkdir(outputsDir, { recursive: true });

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(settingsPath, SETTINGS_YML);

  const invocations: Harness["invocations"] = [];
  const runAgent: AgentRunner = async (command, args, options) => {
    invocations.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });

    return {
      stdout:
        "Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].",
      stderr: "",
    };
  };

  return {
    dataRoot,
    promptsDir,
    outputsDir,
    settingsPath,
    invocations,
    runAgent,
  };
}

function optionsFor(h: Harness, overrides: Record<string, unknown> = {}) {
  return {
    settingsPath: h.settingsPath,
    rawDir: join(h.dataRoot, "raw"),
    promptsDir: h.promptsDir,
    outputsDir: h.outputsDir,
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
  it("sends the prompt text in the agent payload", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args.at(-1)).toContain("QUERY PROMPT");
  });

  it("sends the question line in the agent payload", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args.at(-1)).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
  });

  it("sends the answer-only mode in the agent payload", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args.at(-1)).toContain("Mode: answer-only");
  });

  it("tells the agent to write nothing in the payload", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args.at(-1)).toContain("write nothing");
  });

  it("invokes the agent in the data repo root", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).cwd).toBe(h.dataRoot);
  });

  it("announces the provider in the invocation progress line", async () => {
    const h = await makeHarness();

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    const messages: string[] = [];
    await runWikiQuery({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages.join("\n")).toContain(
      "pi --provider zai --model GLM-5.2 --thinking high",
    );
  });

  it("passes the --provider flag when the setting is present", async () => {
    const h = await makeHarness();

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--provider");
  });

  it("passes the provider value as the --provider argument", async () => {
    const h = await makeHarness();

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiQuery(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--provider") + 1]).toBe("zai");
  });

  it("passes the --model flag from settings", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--model");
  });

  it("passes the model value as the --model argument", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--model") + 1]).toBe("GLM-5.2");
  });

  it("passes the --thinking flag from settings", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--thinking");
  });

  it("passes the reasoning level as the --thinking value", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("passes --print for the one-shot payload", async () => {
    const h = await makeHarness();

    await runWikiQuery(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--print");
  });

  it("reports the trimmed agent stdout as the answer", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery(optionsFor(h));

    expect(result.answer).toBe(
      "Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].",
    );
  });

  it("saves the run to outputs/last-query.md", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery({
      ...optionsFor(h),
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(result.artifactPath).toBe(join(h.outputsDir, "last-query.md"));
  });

  it("records the question in the saved artifact", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery({
      ...optionsFor(h),
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    const artifact = await readQueryArtifact(result.artifactPath);

    expect(artifact.question).toBe(
      "When should I prefer RAG over fine-tuning?",
    );
  });

  it("records the answer in the saved artifact", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery({
      ...optionsFor(h),
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    const artifact = await readQueryArtifact(result.artifactPath);

    expect(artifact.answer).toBe(result.answer);
  });

  it("stamps the run time in the saved artifact", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery({
      ...optionsFor(h),
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    const artifact = await readQueryArtifact(result.artifactPath);

    expect(artifact.timestamp).toBe("2026-08-21T09:00:00.000Z");
  });

  it("derives the cited pages in the saved artifact", async () => {
    const h = await makeHarness();
    const result = await runWikiQuery({
      ...optionsFor(h),
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    const artifact = await readQueryArtifact(result.artifactPath);

    expect(artifact.pages).toEqual(["retrieval-augmented-generation"]);
  });

  const wikiWritingRogue: AgentRunner = async (_command, _args, options) => {
    await mkdir(join(options.cwd, "wiki", "queries"), { recursive: true });
    await writeFile(
      join(options.cwd, "wiki", "queries", "rogue.md"),
      "rogue\n",
    );
    await writeFile(join(options.cwd, "wiki", "index.md"), "# Index v2\n");

    return { stdout: "An answer.", stderr: "" };
  };

  it("fails naming wiki/ when the agent writes under wiki/", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: wikiWritingRogue }),
    ).rejects.toThrow("wiki/");
  });

  it("names the revert in the failure when the agent writes under wiki/", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: wikiWritingRogue }),
    ).rejects.toThrow("reverted");
  });

  it("reverts the agent's rogue page on failure", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: wikiWritingRogue }),
    ).rejects.toThrow();

    await expect(
      readFile(join(h.dataRoot, "wiki", "queries", "rogue.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the overwritten index on failure", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: wikiWritingRogue }),
    ).rejects.toThrow();

    expect(await readFile(join(h.dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );
  });

  it("saves no artifact when the agent writes under wiki/", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: wikiWritingRogue }),
    ).rejects.toThrow();

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  const pageDeletingRogue: AgentRunner = async (_command, _args, options) => {
    await rm(join(options.cwd, "wiki", "drafts", "note.md"));

    return { stdout: "An answer.", stderr: "" };
  };

  async function harnessWithDraftNote(): Promise<Harness> {
    const h = await makeHarness();

    await mkdir(join(h.dataRoot, "wiki", "drafts"), { recursive: true });
    await writeFile(join(h.dataRoot, "wiki", "drafts", "note.md"), "NOTE\n");

    return h;
  }

  it("fails naming the pre-run untracked page the agent deleted", async () => {
    const h = await harnessWithDraftNote();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: pageDeletingRogue }),
    ).rejects.toThrow("wiki/drafts/note.md");
  });

  it("restores the pre-run untracked page the agent deleted", async () => {
    const h = await harnessWithDraftNote();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: pageDeletingRogue }),
    ).rejects.toThrow();

    expect(
      await readFile(join(h.dataRoot, "wiki", "drafts", "note.md"), "utf8"),
    ).toBe("NOTE\n");
  });

  it("saves no artifact when the agent deletes a pre-run page", async () => {
    const h = await harnessWithDraftNote();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: pageDeletingRogue }),
    ).rejects.toThrow();

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  const renamingRogue: AgentRunner = async (_command, _args, options) => {
    await mkdir(join(options.cwd, "notes"), { recursive: true });
    await run("git", ["mv", "wiki/concepts/rag.md", "notes/rag.md"], {
      cwd: options.cwd,
    });

    return { stdout: "An answer.", stderr: "" };
  };

  it("fails naming the moved page when the agent renames out of wiki/", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: renamingRogue }),
    ).rejects.toThrow("wiki/concepts/rag.md");
  });

  it("restores the renamed page under wiki/", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: renamingRogue }),
    ).rejects.toThrow();

    expect(
      await readFile(join(h.dataRoot, "wiki", "concepts", "rag.md"), "utf8"),
    ).toBe("RAG\n");
  });

  it("removes the out-of-wiki rename target on revert", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: renamingRogue }),
    ).rejects.toThrow();

    await expect(
      readFile(join(h.dataRoot, "notes", "rag.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  const committingRogue: AgentRunner = async (_command, _args, options) => {
    await writeFile(join(options.cwd, "wiki", "index.md"), "# Rogue\n");
    await run("git", ["add", "-A"], { cwd: options.cwd });
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
        "rogue",
      ],
      { cwd: options.cwd },
    );

    return { stdout: "An answer.", stderr: "" };
  };

  it("fails naming the moved HEAD when the agent commits", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: committingRogue }),
    ).rejects.toThrow("moved the data repo's HEAD");
  });

  it("restores the data repo HEAD the agent moved", async () => {
    const h = await makeHarness();
    const { stdout: sha } = await run("git", [
      "-C",
      h.dataRoot,
      "rev-parse",
      "HEAD",
    ]);

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: committingRogue }),
    ).rejects.toThrow();

    const { stdout: after } = await run("git", [
      "-C",
      h.dataRoot,
      "rev-parse",
      "HEAD",
    ]);

    expect(after.trim()).toBe(sha.trim());
  });

  it("reverts the committed index edit", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: committingRogue }),
    ).rejects.toThrow();

    expect(await readFile(join(h.dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );
  });

  it("saves no artifact when the agent commits its writes", async () => {
    const h = await makeHarness();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: committingRogue }),
    ).rejects.toThrow();

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores wiki pages that were already dirty before the run", async () => {
    const h = await makeHarness();

    await writeFile(join(h.dataRoot, "wiki", "index.md"), "# Index dirty\n");

    const result = await runWikiQuery(optionsFor(h));

    expect(result.answer).toContain("Prefer RAG");
  });

  const dirtyReEditingRogue: AgentRunner = async (_command, _args, options) => {
    await writeFile(join(options.cwd, "wiki", "index.md"), "# Index v2\n");

    return { stdout: "An answer.", stderr: "" };
  };

  async function harnessWithDirtyIndex(): Promise<Harness> {
    const h = await makeHarness();

    await writeFile(join(h.dataRoot, "wiki", "index.md"), "# Index dirty\n");

    return h;
  }

  it("fails with a revert when the agent re-edits an already-dirty page", async () => {
    const h = await harnessWithDirtyIndex();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: dirtyReEditingRogue }),
    ).rejects.toThrow("reverted");
  });

  it("restores the pre-run dirty content after the revert", async () => {
    const h = await harnessWithDirtyIndex();

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: dirtyReEditingRogue }),
    ).rejects.toThrow();

    expect(await readFile(join(h.dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index dirty\n",
    );
  });

  it("fails cleanly when the data repo has no commit", async () => {
    const h = await makeHarness();

    await rm(join(h.dataRoot, ".git"), { recursive: true });
    await run("git", ["init", "--quiet"], { cwd: h.dataRoot });

    await expect(runWikiQuery(optionsFor(h))).rejects.toThrow(
      "no commit to revert to",
    );
  });

  it("runs no agent when the data repo has no commit", async () => {
    const h = await makeHarness();

    await rm(join(h.dataRoot, ".git"), { recursive: true });
    await run("git", ["init", "--quiet"], { cwd: h.dataRoot });

    await expect(runWikiQuery(optionsFor(h))).rejects.toThrow();

    expect(h.invocations).toEqual([]);
  });

  it("fails when the agent produces no answer", async () => {
    const h = await makeHarness();
    const silent: AgentRunner = async () => ({ stdout: "  \n", stderr: "" });

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: silent }),
    ).rejects.toThrow("no answer");
  });

  it("saves no artifact when the agent produces no answer", async () => {
    const h = await makeHarness();
    const silent: AgentRunner = async () => ({ stdout: "  \n", stderr: "" });

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: silent }),
    ).rejects.toThrow();

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
      expect.stringContaining("wiki-query: answer saved"),
    ]);
  });

  it("emits a heartbeat while a slow agent run is in flight", async () => {
    const h = await makeHarness();
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "A.", stderr: "" };
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
    const fast: AgentRunner = async () => ({ stdout: "A.", stderr: "" });

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
        outputsDir: h.outputsDir,
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
});

describe("wiki-query CLI", () => {
  const STUB = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// Guard: a mutated wrapper may redirect this stub into the real data
// repo; refuse to write anywhere but this harness's data root.
if (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);
console.log("Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].");
`;

  /** A harness whose settings point at an executable stub agent. */
  async function makeCliHarness(): Promise<Harness> {
    const h = await makeHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
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
      "--outputs",
      h.outputsDir,
      ...extra,
      "When should I prefer RAG over fine-tuning?",
    ];
  }

  function fileLastArgs(h: Harness, extra: string[] = []) {
    return [
      "--file-last",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      ...extra,
    ];
  }

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-query [-h | --help] [--file-last] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the --file-last switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--file-last");
  });

  it("documents the --settings switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--settings");
  });

  it("documents the --outputs switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--outputs");
  });

  it("documents the --raw-dir switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--raw-dir");
  });

  it("documents the --timeout switch and its value in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--timeout <secs>");
  });

  it("documents the defaults in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("Default");
  });

  it("documents stage 1 in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("Stage 1");
  });

  it("documents stage 2 in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("Stage 2");
  });

  it("no longer documents --no-filing", async () => {
    expect((await runCli(["--help"])).out).not.toContain("--no-filing");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "leftover-arg"]);

    expect(out).toContain("Usage: wiki-query");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the missing-question error on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
    ]);

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is missing", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the missing-question error for an empty question", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h).slice(0, -1).concat(""));

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is an empty string", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h).slice(0, -1).concat(""));

    expect(process.exitCode).toBe(1);
  });

  it("prints the missing-question error for a whitespace-only question", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h).slice(0, -1).concat("   "));

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is only whitespace", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h).slice(0, -1).concat("   "));

    expect(process.exitCode).toBe(1);
  });

  it("names the one-question rule on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "two"]);

    expect(err).toContain("expected exactly one <question>");
  });

  it("exits 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "two"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the unknown option on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "--bogus"]);

    expect(err).toContain("wiki-query: unknown option");
  });

  it("exits 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "--bogus"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the removed --no-filing switch on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "--no-filing"]);

    expect(err).toContain('unknown option "--no-filing"');
  });

  it("exits 1 for the removed --no-filing switch", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "--no-filing"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --settings value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(err).toContain("--settings needs a path value");
  });

  it("exits 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    await runCli(["--raw-dir", join(h.dataRoot, "raw"), "--settings"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --raw-dir value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(["--settings", h.settingsPath, "--raw-dir"]);

    expect(err).toContain("--raw-dir needs a path value");
  });

  it("exits 1 when --raw-dir has no value", async () => {
    const h = await makeCliHarness();
    await runCli(["--settings", h.settingsPath, "--raw-dir"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --outputs value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h).slice(0, -1), "--outputs"]);

    expect(err).toContain("--outputs needs a path value");
  });

  it("exits 1 when --outputs has no value", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h).slice(0, -1), "--outputs"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr when the value is missing", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "--timeout"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for zero", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "0"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "0"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for a negative value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "-5"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "-5"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for a non-numeric value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "abc"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "abc"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for trailing junk", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "5x"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "5x"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the unreadable settings file on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      "q",
    ]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("exits 1 when settings cannot be read", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      "q",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the agent's answer to stdout", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h));

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("prints no Filed line in stage 1", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h));

    expect(out).not.toContain("Filed:");
  });

  it("announces the agent invocation on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("wiki-query: invoking agent");
  });

  it("prints the --file-last hint on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("wiki-query --file-last");
  });

  it("saves the question in the stage-1 artifact", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h));

    const artifact = await readQueryArtifact(
      join(h.outputsDir, "last-query.md"),
    );

    expect(artifact.question).toBe(
      "When should I prefer RAG over fine-tuning?",
    );
  });

  it("writes nothing under wiki/ in stage 1", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h));

    const { stdout } = await run(
      "git",
      ["-C", h.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");
  });

  it("leaves the exit code unset after a successful query", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("passes the question through to the agent payload", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const prompt = await readFile(join(h.dataRoot, "stub-prompt.txt"), "utf8");

    expect(prompt).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h, ["--timeout", "1800"]));

    expect(out).toContain("Prefer RAG when");
  });

  it("leaves the exit code unset for a valid --timeout", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "1800"]));

    expect(process.exitCode).toBeUndefined();
  });

  /** A CLI harness whose stub agent writes a rogue page under wiki/. */
  async function makeRogueCliHarness(): Promise<Harness> {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "queries", "rogue.md"), "rogue");
console.log("An answer.");
`,
      { mode: 0o755 },
    );

    return h;
  }

  it("names the revert on stderr when the CLI agent writes under wiki/", async () => {
    const h = await makeRogueCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("reverted");
  });

  it("exits 1 when the CLI agent writes under wiki/", async () => {
    const h = await makeRogueCliHarness();
    await runCli(queryArgs(h));

    expect(process.exitCode).toBe(1);
  });

  it("writes nothing under wiki/ after the revert", async () => {
    const h = await makeRogueCliHarness();
    await runCli(queryArgs(h));

    const { stdout } = await run(
      "git",
      ["-C", h.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");
  });

  it("saves no artifact after a reverted CLI wiki write", async () => {
    const h = await makeRogueCliHarness();
    await runCli(queryArgs(h));

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the no-question rule for --file-last on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...fileLastArgs(h), "a question?"]);

    expect(err).toContain("--file-last takes no <question>");
  });

  it("exits 1 when --file-last is given a question", async () => {
    const h = await makeCliHarness();
    await runCli([...fileLastArgs(h), "a question?"]);

    expect(process.exitCode).toBe(1);
  });

  it("states that no saved answer exists on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toContain("no saved answer");
  });

  it("names the wiki-query remedy on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toContain("wiki-query");
  });

  it("exits 1 when --file-last finds no saved answer", async () => {
    const h = await makeCliHarness();
    await runCli(fileLastArgs(h));

    expect(process.exitCode).toBe(1);
  });

  /** A harness holding a saved stage-1 answer whose settings file is
   *  gone — exactly the state --file-last must work from. */
  async function harnessWithSavedAnswer(): Promise<Harness> {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));
    await rm(h.settingsPath);

    return h;
  }

  it("files the saved answer under wiki/queries/ with --file-last", async () => {
    const h = await harnessWithSavedAnswer();
    const { out } = await runCli(fileLastArgs(h));

    expect(out).toContain(
      "Filed: wiki/queries/when-should-i-prefer-rag-over-fine-tuning.md",
    );
  });

  it("prints nothing on stderr when filing succeeds", async () => {
    const h = await harnessWithSavedAnswer();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toBe("");
  });

  it("leaves the exit code unset when filing without a settings file", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("writes the answer into the filed query page", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    const page = await readFile(
      join(
        h.dataRoot,
        "wiki",
        "queries",
        "when-should-i-prefer-rag-over-fine-tuning.md",
      ),
      "utf8",
    );

    expect(page).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("links the filed query from the index", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    const index = await readFile(join(h.dataRoot, "wiki", "index.md"), "utf8");

    expect(index).toContain(
      "- [[when-should-i-prefer-rag-over-fine-tuning]] — When should I prefer RAG over fine-tuning?",
    );
  });

  it("appends the query to the log", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    const log = await readFile(join(h.dataRoot, "wiki", "log.md"), "utf8");

    expect(log).toMatch(
      /## \[\d{4}-\d{2}-\d{2}\] query \| When should I prefer RAG over fine-tuning\?/,
    );
  });

  it("files the saved answer from the checkout's default outputs directory when --outputs is omitted", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const cliOutputs = join(repoRoot, "outputs");
    const defaultArtifact = join(cliOutputs, "last-query.md");
    const previous = await readFile(defaultArtifact).catch(() => null);

    await mkdir(cliOutputs, { recursive: true });
    await writeFile(
      defaultArtifact,
      await readFile(join(h.outputsDir, "last-query.md")),
    );

    try {
      const { out } = await runCli([
        "--file-last",
        "--raw-dir",
        join(h.dataRoot, "raw"),
      ]);

      expect(out).toContain(
        "Filed: wiki/queries/when-should-i-prefer-rag-over-fine-tuning.md",
      );
    } finally {
      if (previous === null) {
        await rm(defaultArtifact, { force: true });
      } else {
        await writeFile(defaultArtifact, previous);
      }
    }
  });

  it("bolds the Filed line", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const prior = process.env.NO_COLOR;

    delete process.env.NO_COLOR;

    try {
      const { out } = await runCli(fileLastArgs(h));
      const filed = out.split("\n").find((line) => line.includes("Filed:"));

      expect(filed).toContain("\u001b[1m");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  /** A harness holding a saved answer whose data repo received a
   *  wiki commit dated after the saved answer — the drift state. */
  async function harnessWithDriftedWiki(): Promise<Harness> {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const artifactPath = join(h.outputsDir, "last-query.md");
    const artifact = await readQueryArtifact(artifactPath);

    await writeFile(
      join(h.dataRoot, "wiki", "index.md"),
      "# Index\n\n<!-- later -->\n",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    const driftDate = new Date(
      Date.parse(artifact.timestamp) + 60_000,
    ).toISOString();

    await run(
      "git",
      [
        "-C",
        h.dataRoot,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--quiet",
        "-m",
        "wiki moved",
      ],
      { env: { ...process.env, GIT_COMMITTER_DATE: driftDate } },
    );

    return h;
  }

  it("still files when the data repo drifted after the saved answer", async () => {
    const h = await harnessWithDriftedWiki();
    const { out } = await runCli(fileLastArgs(h));

    expect(out).toContain("Filed:");
  });

  it("prints the drift warning on stderr", async () => {
    const h = await harnessWithDriftedWiki();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toContain(
      "warning: the data repo changed after the saved answer",
    );
  });

  it("leaves the exit code unset when filing despite drift", async () => {
    const h = await harnessWithDriftedWiki();
    await runCli(fileLastArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    const { err } = await runCli(queryArgs(h, ["--timeout", "1"]));

    expect(err).toMatch(/timed out after 1 second/);
  });

  it("exits 1 after the --timeout kills the agent", async () => {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    await runCli(queryArgs(h, ["--timeout", "1"]));

    expect(process.exitCode).toBe(1);
  });

  it("makes no console.error call in stage 2 when nothing drifted", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const argv = process.argv;
    let calls = 0;

    process.argv = [...argv.slice(0, 2), ...fileLastArgs(h)];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      calls += 1;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main();
    } finally {
      process.argv = argv;
      spy.mockRestore();
      logSpy.mockRestore();
    }

    expect(calls).toBe(0);
  });

  it("fails at the data repo guardrail, not at settings, when --settings is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-query-nogit-"));

    tempDirs.push(dir);

    const { err } = await runCli([
      "--raw-dir",
      join(dir, "raw"),
      "a question?",
    ]);

    expect(err).toContain("the data repo has no commit to revert to");
  });

  it.skipIf(existsSync(defaultLastQuery))(
    "names the repo's outputs/last-query.md when --outputs is omitted",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "k-wiki-query-"));

      tempDirs.push(dir);

      const { err } = await runCli([
        "--file-last",
        "--raw-dir",
        join(dir, "raw"),
      ]);

      expect(err).toContain(`no saved answer at ${defaultLastQuery}`);
    },
  );

  /** Run a failing agent query on a fake TTY with color forced on;
   *  returns everything written to stderr. */
  async function runFailingQueryOnTty(h: Harness): Promise<string> {
    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => process.exit(3), 250);\n",
      { mode: 0o755 },
    );

    const argv = process.argv;
    const isTTY = process.stderr.isTTY;
    const noColor = process.env.NO_COLOR;
    const writes: string[] = [];

    process.argv = [...argv.slice(0, 2), ...queryArgs(h)];
    process.stderr.isTTY = true;
    delete process.env.NO_COLOR;

    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));

        return true;
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main();
    } finally {
      process.argv = argv;
      process.stderr.isTTY = isTTY;

      if (noColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = noColor;
      }

      writeSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return writes.join("");
  }

  it("erases the live heartbeat line before printing a failure", async () => {
    const h = await makeCliHarness();
    const written = await runFailingQueryOnTty(h);

    expect(written).toMatch(/\r +\r/);
  });

  it("exits 1 after the failing TTY query", async () => {
    const h = await makeCliHarness();
    await runFailingQueryOnTty(h);

    expect(process.exitCode).toBe(1);
  });
});

describe("runWikiQuery violation reporting", () => {
  it("names the violating paths and the revert target exactly", async () => {
    const h = await makeHarness();
    const { stdout: sha } = await run("git", [
      "-C",
      h.dataRoot,
      "rev-parse",
      "HEAD",
    ]);
    const rogue: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "queries"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "queries", "rogue.md"),
        "rogue\n",
      );
      await writeFile(join(options.cwd, "wiki", "index.md"), "# Index v2\n");

      return { stdout: "An answer.", stderr: "" };
    };

    await expect(
      runWikiQuery({ ...optionsFor(h), runAgent: rogue }),
    ).rejects.toThrow(
      `answer-only run wrote to wiki/ (wiki/index.md, wiki/queries/rogue.md); reverted to ${sha.trim().slice(0, 8)} — the answer was saved nowhere; rerun the question`,
    );
  });

  it("reports the revert on the progress sink with the short target", async () => {
    const h = await makeHarness();
    const { stdout: sha } = await run("git", [
      "-C",
      h.dataRoot,
      "rev-parse",
      "HEAD",
    ]);
    const messages: string[] = [];
    const rogue: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "index.md"), "# Index v2\n");

      return { stdout: "An answer.", stderr: "" };
    };

    try {
      await runWikiQuery({
        ...optionsFor(h),
        runAgent: rogue,
        onProgress: (message) => messages.push(message),
      });
    } catch {
      // expected: the violation throws after the progress line
    }

    expect(messages).toContain(
      `wiki-query: wiki changed during the answer-only run — reverting to ${sha.trim().slice(0, 8)}`,
    );
  });
});

describe("wiki-query CLI stderr surface", () => {
  it("prints the filing hint after a blank stderr line", async () => {
    const h = await makeHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
    await writeFile(stub, '#!/usr/bin/env node\nconsole.log("A.");\n', {
      mode: 0o755,
    });
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const argv = process.argv;
    const err: string[] = [];

    process.argv = [
      ...argv.slice(0, 2),
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      "q",
    ];

    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      await main();
    } finally {
      process.argv = argv;
      spy.mockRestore();
      logSpy.mockRestore();

      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }

    expect(
      err
        .join("\n")
        .endsWith("\n\nTo file this answer: wiki-query --file-last"),
    ).toBe(true);
  });
});

describe("runWikiQuery caller env", () => {
  it("hands the caller's env object to the agent runner", async () => {
    const h = await makeHarness();
    const env = { ...process.env, K_WIKI_QUERY_ENV_PROBE: "1" };

    await runWikiQuery({ ...optionsFor(h), env });

    expect(invocation(h, 0).env).toBe(env);
  });
});

describe("runWikiQuery HEAD-only move", () => {
  /** An agent that commits outside wiki/: wiki/ stays clean, HEAD moves. */
  function rogueHeadMover(): AgentRunner {
    return async (_command, _args, options) => {
      await writeFile(join(options.cwd, "NOTES.md"), "note\n");
      await run("git", ["add", "-A"], { cwd: options.cwd });
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
          "outside wiki",
        ],
        { cwd: options.cwd },
      );

      return { stdout: "An answer.", stderr: "" };
    };
  }

  it("reports the HEAD-move reason on the progress sink", async () => {
    const h = await makeHarness();
    const { stdout: sha } = await run("git", [
      "-C",
      h.dataRoot,
      "rev-parse",
      "HEAD",
    ]);
    const messages: string[] = [];

    try {
      await runWikiQuery({
        ...optionsFor(h),
        runAgent: rogueHeadMover(),
        onProgress: (message) => messages.push(message),
      });
    } catch {
      // expected: the violation throws after the progress line
    }

    expect(messages).toContain(
      `wiki-query: the data repo's HEAD moved during the answer-only run — reverting to ${sha.trim().slice(0, 8)}`,
    );
  });

  it("names only the HEAD move in the failure message", async () => {
    const h = await makeHarness();
    const { stdout: sha } = await run("git", [
      "-C",
      h.dataRoot,
      "rev-parse",
      "HEAD",
    ]);
    let message = "";

    try {
      await runWikiQuery({ ...optionsFor(h), runAgent: rogueHeadMover() });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      `answer-only run moved the data repo's HEAD; reverted to ${sha.trim().slice(0, 8)} — the answer was saved nowhere; rerun the question`,
    );
  });
});

describe("runWikiQuery combined violations", () => {
  /** An agent that writes wiki/ and moves the HEAD: two violations. */
  function rogueWriterAndHeadMover(): AgentRunner {
    return async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "rogue.md"), "# Rogue\n");
      await writeFile(join(options.cwd, "NOTES.md"), "note\n");
      await run("git", ["add", "NOTES.md"], { cwd: options.cwd });
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
          "rogue write and move",
        ],
        { cwd: options.cwd },
      );

      return { stdout: "An answer.", stderr: "" };
    };
  }

  it("joins both violations with and in the failure message", async () => {
    const h = await makeHarness();
    let message = "";

    try {
      await runWikiQuery({
        ...optionsFor(h),
        runAgent: rogueWriterAndHeadMover(),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "wrote to wiki/ (wiki/rogue.md) and moved the data repo's HEAD",
    );
  });
});
