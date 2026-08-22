import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../src/data/init-data-repo.ts";
import {
  type AgentRunner,
  createAgentProgressSink,
} from "../src/ingest/wiki-ingest.ts";
import { serializeManifest } from "../src/sync/manifest.ts";
import {
  type CommitResult,
  formatCommitMessage,
  formatFinalDigest,
  LINT_HEARTBEAT_PREFIX,
  main,
  runWikiSync,
} from "../src/sync/wiki-sync.ts";

const run = promisify(execFile);

const NOW = () => new Date("2026-08-20T18:00:00.000Z");

const SETTINGS_YML = "command: pi\nmodel: GLM-5.2\nreasoning: high\n";

/** A wiki page body with valid §9 frontmatter (guardrail 2 must pass). */
function wikiPage(body: string): string {
  return [
    "---",
    'title: "Page"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[index]]"',
    "---",
    "",
    body,
    "",
  ].join("\n");
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
});

interface Harness {
  readonly dataRoot: string;
  readonly vaultRoot: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
  readonly promptsDir: string;
  readonly invocations: string[];
  readonly argRecords: string[][];
  ingestAgent: AgentRunner;
  lintAgent: AgentRunner;
}

/** The default ingest stub: write one new page, update the index. */
const ingestStub: AgentRunner = async (_command, _args, options) => {
  await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
  await writeFile(
    join(options.cwd, "wiki", "concepts", "new.md"),
    wikiPage("New page"),
    { flag: "wx" },
  ).catch(() => {});
  await writeFile(
    join(options.cwd, "wiki", "index.md"),
    wikiPage("# Index v2"),
  );

  return { stdout: "agent final report", stderr: "" };
};

/** The default lint stub: write the lint report into data-repo outputs/. */
const lintStub: AgentRunner = async (_command, _args, options) => {
  await mkdir(join(options.cwd, "outputs"), { recursive: true });
  await writeFile(
    join(options.cwd, "outputs", "lint-2026-08-20.md"),
    "# Lint report\n\nAll checks passed.\n",
  );

  return { stdout: "lint: 149 pages audited, 0 problems", stderr: "" };
};

async function makeHarness(
  vaultNotes: Record<string, string>,
): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-sync-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const vaultRoot = join(tmp, "vault");
  const configPath = join(tmp, "sync.json");
  const settingsPath = join(tmp, "settings.yml");
  const outputsDir = join(tmp, "outputs");
  const promptsDir = join(tmp, "prompts");

  for (const [relPath, content] of Object.entries(vaultNotes)) {
    const target = join(vaultRoot, relPath);

    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }

  await writeFile(
    configPath,
    JSON.stringify({
      dataRoot,
      vaults: [{ name: "Engineering", root: vaultRoot, exclude: "wiki:false" }],
    }),
  );
  await writeFile(settingsPath, SETTINGS_YML);
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "ingest.md"), "FULL PROMPT");
  await writeFile(join(promptsDir, "incremental.md"), "INCREMENTAL PROMPT");
  await writeFile(join(promptsDir, "lint.md"), "AUDIT THE WIKI PROMPT");

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    serializeManifest({ vaults: {} }),
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });

  const invocations: string[] = [];
  const argRecords: string[][] = [];
  let ingestAgent: AgentRunner = ingestStub;
  let lintAgent: AgentRunner = lintStub;
  const harness: Harness = {
    dataRoot,
    vaultRoot,
    configPath,
    settingsPath,
    outputsDir,
    promptsDir,
    invocations,
    argRecords,
    get ingestAgent() {
      return ingestAgent;
    },
    set ingestAgent(next: AgentRunner) {
      ingestAgent = next;
    },
    get lintAgent() {
      return lintAgent;
    },
    set lintAgent(next: AgentRunner) {
      lintAgent = next;
    },
  };

  return harness;
}

function optionsFor(h: Harness) {
  const runAgent: AgentRunner = async (command, args, options) => {
    const prompt = args[args.indexOf("--print") + 1] ?? "";

    h.invocations.push(prompt);
    h.argRecords.push([...args]);

    const runner = prompt.includes("AUDIT THE WIKI")
      ? h.lintAgent
      : h.ingestAgent;

    return runner(command, args, options);
  };

  return {
    configPath: h.configPath,
    rawDir: join(h.dataRoot, "raw"),
    settingsPath: h.settingsPath,
    outputsDir: h.outputsDir,
    promptsDir: h.promptsDir,
    runAgent,
    now: NOW,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t" },
  };
}

async function headOf(dataRoot: string): Promise<string> {
  const { stdout } = await runGit(dataRoot, ["rev-parse", "HEAD"], process.env);

  return stdout.trim();
}

describe("runWikiSync", () => {
  it("commits the whole cycle in the data repo", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
  });

  it("summarizes sources and pages in the commit message", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    await runWikiSync(optionsFor(h));
    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain("wiki-sync: 1 source processed, 2 pages touched");
    expect(stdout).toContain("- sources: 1 added, 0 changed, 0 removed");
    expect(stdout).toContain("- pages: 1 created, 1 updated");
    expect(stdout).toContain("- lint: outputs/lint-2026-08-20.md");
  });

  it("writes the lint report into the data repo outputs", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.lint?.reportWritten).toBe(true);

    await expect(
      readFile(join(h.dataRoot, "outputs", "lint-2026-08-20.md"), "utf8"),
    ).resolves.toContain("Lint report");
  });

  it("runs no agent and commits nothing when nothing changed", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const headBefore = await headOf(h.dataRoot);
    const result = await runWikiSync(optionsFor(h));

    expect(result.ingest.status).toBe("skipped");
    expect(result.lint).toBeUndefined();
    expect(result.commit.status).toBe("nothing-to-commit");
    expect(await headOf(h.dataRoot)).toBe(headBefore);
    expect(h.invocations).toEqual(["FULL PROMPT", "AUDIT THE WIKI PROMPT"]);
  });

  it("stops the chain and commits nothing when the ingest agent fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    const headBefore = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");
    expect(await headOf(h.dataRoot)).toBe(headBefore);
  });

  it("reverts a tripped lint guardrail and keeps the ingest changes", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue lint", stderr: "" };
    };

    const headBefore = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "guardrail check 2 (frontmatter)",
    );
    expect(await headOf(h.dataRoot)).toBe(headBefore);

    await expect(
      readFile(join(h.dataRoot, "wiki", "concepts", "broken.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      readFile(join(h.dataRoot, "wiki", "concepts", "new.md"), "utf8"),
    ).resolves.toContain("New page");
  });

  it("retries the ingest after a failed run even when sync reports no changes", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");

    h.ingestAgent = ingestStub;

    const result = await runWikiSync(optionsFor(h));
    const digest = formatFinalDigest(result);

    expect(result.ingest.status).toBe("ran");
    expect(h.invocations.filter((p) => p === "FULL PROMPT")).toHaveLength(2);
    expect(result.commit.status).toBe("committed");
    expect(digest).toContain("no source changes");
  });
});

describe("formatFinalDigest", () => {
  it("states nothing to do when the cycle was a no-op", () => {
    const digest = formatFinalDigest({
      sync: { vaults: [], prunedNamespaces: [] },
      ingest: { status: "skipped", reason: "no changed sources" },
      lint: undefined,
      commit: { status: "nothing-to-commit" },
    });

    expect(digest).toContain("nothing to do");
  });

  it("leads with the counts of a committed cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    const digest = formatFinalDigest(result);

    expect(digest).toContain("1 source copied, 0 sources removed");
    expect(digest).toContain("- **Ingest:** full — digest below");
    expect(digest).toContain("- **Lint:** report `outputs/lint-2026-08-20.md`");
    expect(digest).toContain(
      `- **Commit:** \`${result.commit.hash.slice(0, 8)}\``,
    );
    expect(digest).toContain("## Lint summary");
    expect(digest).toContain("## Ingest digest");
  });

  it("names pruned namespaces in the sync summary", () => {
    const digest = formatFinalDigest({
      sync: { vaults: [], prunedNamespaces: ["Old"] },
      ingest: { status: "skipped", reason: "no changed sources" },
      lint: undefined,
      commit: { status: "committed", hash: "a1b2c3d4", message: "m" },
    });

    expect(digest).toContain("1 namespace pruned");
  });
});

describe("formatCommitMessage", () => {
  it("pluralizes sources and pages", () => {
    const message = formatCommitMessage({
      sourcesCount: 2,
      sourcesLine: "1 added, 1 changed, 0 removed",
      pagesCreated: 3,
      pagesUpdated: 0,
      lintReport: undefined,
    });

    expect(message.split("\n")[0]).toBe(
      "wiki-sync: 2 sources processed, 3 pages touched",
    );
  });

  it("omits the lint line when no report was written", () => {
    const message = formatCommitMessage({
      sourcesCount: 1,
      sourcesLine: "1 added, 0 changed, 0 removed",
      pagesCreated: 0,
      pagesUpdated: 1,
      lintReport: undefined,
    });

    expect(message).not.toContain("lint:");
  });
});

describe("createAgentProgressSink with lint heartbeats", () => {
  it("keeps the lint heartbeat on the animated line", () => {
    const written: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      () => {},
      true,
      (text) => text,
      [LINT_HEARTBEAT_PREFIX],
    );

    sink.render(`${LINT_HEARTBEAT_PREFIX} (2m07s)`);

    expect(written[0]).toContain("\r");
  });
});

describe("runWikiSync lint stage", () => {
  it("reports an unwritten lint report", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async () => ({ stdout: "lint done", stderr: "" });

    const result = await runWikiSync(optionsFor(h));

    expect(result.lint?.reportWritten).toBe(false);
  });

  it("rejects with the agent error when the lint agent fails but guardrails pass", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async () => {
      throw new Error("lint agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "lint agent exploded",
    );
  });

  it("emits a heartbeat while the lint agent runs", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    h.lintAgent = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));

      return { stdout: "lint done", stderr: "" };
    };

    await runWikiSync({
      ...optionsFor(h),
      heartbeatMs: 5,
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContainEqual(
      expect.stringMatching(/lint agent still running/),
    );
  });
});

const CLI_STUB =
  '#!/usr/bin/env node\nimport { existsSync } from "node:fs";\nimport { mkdir, writeFile } from "node:fs/promises";\nimport { join } from "node:path";\n// Guard: a mutated wrapper may redirect this stub into the real data\n// repo; refuse to write anywhere but this harness\'s data root.\nif (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);\nconst index = process.argv.indexOf("--print");\nconst prompt = index === -1 ? "" : process.argv[index + 1] ?? "";\nawait mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });\nawait writeFile(join(process.cwd(), "wiki", "concepts", "stub.md"), [\n  "---",\n  \'title: "Stub"\',\n  "type: concept",\n  "created: 2026-08-20",\n  "updated: 2026-08-20",\n  "tags:",\n  "  - llm",\n  "sources:",\n  \'  - "[[index]]"\',\n  "---",\n  "",\n  "stub body",\n  "",\n].join("\\n"));\nif (prompt.startsWith("Audit the wiki")) {\n  await mkdir(join(process.cwd(), "outputs"), { recursive: true });\n  const today = new Date().toISOString().slice(0, 10);\n  await writeFile(join(process.cwd(), "outputs", "lint-" + today + ".md"), "# Lint\\n");\n  console.log("lint: clean");\n} else {\n  console.log("ingest report");\n}\n';

describe("wiki-sync CLI", () => {
  async function makeCliHarness() {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
    await writeFile(stub, CLI_STUB, { mode: 0o755 });
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

  function cycleArgs(h: Harness): string[] {
    return [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      h.configPath,
      join(h.dataRoot, "raw"),
    ];
  }

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-sync [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents every switch and default in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--settings");
    expect(out).toContain("--outputs");
    expect(out).toContain("--timeout");
    expect(out).toContain("<config>");
    expect(out).toContain("<raw-dir>");
    expect(out).toContain("Default");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "/no/such/config"]);

    expect(out).toContain("Usage: wiki-sync");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 on an unknown option", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--nope"]);

    expect(err).toContain('unknown option "--nope"');
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --timeout is not a positive integer", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout", "zero"]);

    expect(err).toContain("--timeout needs a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--outputs",
      h.outputsDir,
      h.configPath,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(err).toContain("--settings needs a path value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 on more than two positional arguments", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "a.json", "raw", "extra"]);

    expect(err).toContain("expected at most two arguments");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 with a stderr message when settings cannot be read", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
      h.configPath,
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
    expect(process.exitCode).toBe(1);
  });

  it("runs the full cycle through main and prints the digest", async () => {
    const h = await makeCliHarness();
    const { out, err } = await runCli(cycleArgs(h));

    expect(out).toContain("# wiki-sync cycle digest");
    expect(out).toContain("## Lint summary");
    expect(err).toContain("wiki-sync: stage 4/4 — commit");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints nothing to do for a second run with no changes", async () => {
    const h = await makeCliHarness();

    await runCli(cycleArgs(h));

    const { out } = await runCli(cycleArgs(h));

    expect(out).toContain("nothing to do");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a zero timeout", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout", "0"]);

    expect(err).toContain("--timeout needs a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout", "5x"]);

    expect(err).toContain("--timeout needs a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("rejects --timeout without a value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout"]);

    expect(err).toContain("--timeout needs a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("accepts a one-second timeout budget and completes the cycle", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([...cycleArgs(h), "--timeout", "1"]);

    expect(out).toContain("# wiki-sync cycle digest");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints no ANSI escapes under NO_COLOR", async () => {
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { err } = await runCli(["--nope"]);

      expect(err).not.toContain("\u001b[");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("exits 1 when a stage fails through main", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(stub, "#!/usr/bin/env node\nprocess.exit(4);\n", {
      mode: 0o755,
    });

    const { err } = await runCli(cycleArgs(h));

    expect(err).toContain("code 4");
    expect(process.exitCode).toBe(1);
  });
});

describe("runWikiSync progress and invocation contract", () => {
  it("announces every stage and the lint agent invocation on progress", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    for (const expected of [
      "wiki-sync: stage 1/4 — sync-vault",
      "wiki-sync: stage 2/4 — wiki-ingest",
      "wiki-sync: stage 3/4 — lint",
      "wiki-sync: lint — invoking agent:",
      "wiki-sync: lint — agent finished",
      "wiki-sync: lint — guardrails passed",
      "wiki-sync: stage 4/4 — commit",
    ]) {
      expect(progress.join("\n")).toContain(expected);
    }
  });

  it("passes the model and reasoning flags to the lint agent", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs).toContain("--model");
    expect(lintArgs).toContain("GLM-5.2");
    expect(lintArgs).toContain("--thinking");
    expect(lintArgs).toContain("high");
  });

  it("stops the heartbeat when the lint agent completes", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];
    const collect = (message: string) => progress.push(message);

    h.lintAgent = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return { stdout: "lint done", stderr: "" };
    };

    await runWikiSync({
      ...optionsFor(h),
      heartbeatMs: 5,
      onProgress: collect,
    });

    const lengthAtEnd = progress.length;

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(progress.length).toBe(lengthAtEnd);
  });

  it("formats the heartbeat elapsed time from the run start", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    h.lintAgent = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));

      return { stdout: "lint done", stderr: "" };
    };

    await runWikiSync({
      ...optionsFor(h),
      heartbeatMs: 5,
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContainEqual(
      expect.stringMatching(
        /^wiki-sync: lint agent still running \(\d+[smh0-9]*\)$/,
      ),
    );
  });
});

describe("runWikiSync failure reporting", () => {
  it("names the tripped lint guardrail, the revert target, and the problems", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    h.lintAgent = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue lint", stderr: "" };
    };

    const error = await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^lint guardrail check 2 \(frontmatter\) failed; reverted to [0-9a-f]{8} — wiki\/concepts\/broken\.md: no frontmatter block$/,
    );
    expect((error as Error).cause).toBeUndefined();
    expect(progress).toContainEqual(
      expect.stringMatching(
        /^wiki-sync: lint guardrail check 2 \(frontmatter\) failed — reverting to [0-9a-f]{8}$/,
      ),
    );
  });

  it("stays silent about a finished agent when the lint agent fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    h.lintAgent = async () => {
      throw new Error("lint agent exploded");
    };

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    }).catch(() => {});

    expect(progress).not.toContain("wiki-sync: lint — agent finished");
  });
});

describe("runWikiSync commit contents", () => {
  it("commits exactly wiki, raw, and outputs — never stray files", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stray = join(h.dataRoot, "stray.txt");

    await writeFile(stray, "stray\n");

    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(result.commit.hash).toMatch(/^[0-9a-f]{40}$/);

    const { stdout } = await runGit(
      h.dataRoot,
      ["show", "--name-only", "--pretty=format:", "HEAD"],
      process.env,
    );
    const names = stdout.split("\n").filter(Boolean);

    expect(names).toContain("outputs/lint-2026-08-20.md");
    expect(names).toContain("wiki/concepts/new.md");
    expect(names).toContain("raw/notes/Engineering/AI/RAG.md");
    expect(names).not.toContain("stray.txt");
  });

  it("counts a removed source in the next cycle's commit message", async () => {
    const h = await makeHarness({
      "AI/RAG.md": "rag body",
      "AI/gone.md": "gone",
    });

    await runWikiSync(optionsFor(h));
    await rm(join(h.vaultRoot, "AI", "gone.md"));

    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(result.commit.message.split("\n")[0]).toBe(
      "wiki-sync: 1 source processed, 0 pages touched",
    );
    expect(result.commit.message).toContain(
      "- sources: 0 added, 0 changed, 1 removed",
    );
    expect(formatFinalDigest(result)).toContain("1 source removed");
  });

  it("commits pending wiki edits with the no-ingest summary line", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "wiki", "index.md"),
      wikiPage("# Index hand-edited"),
    );

    const result = await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(result.commit.message).toContain(
      "- sources: 0 copied, 0 removed by sync (no ingest)",
    );
    expect(result.commit.message).toContain("- pages: 0 created, 1 updated");
    expect(progress).toContain(
      "wiki-sync: stage 3/4 — lint skipped (no ingest ran)",
    );
  });
});

describe("formatCommitMessage shape", () => {
  it("uses the singular for exactly one source and one page", () => {
    const message = formatCommitMessage({
      sourcesCount: 1,
      sourcesLine: "1 added, 0 changed, 0 removed",
      pagesCreated: 1,
      pagesUpdated: 0,
      lintReport: "outputs/lint-2026-08-20.md",
    });

    expect(message.split("\n")[0]).toBe(
      "wiki-sync: 1 source processed, 1 page touched",
    );
  });

  it("separates the summary line from the detail bullets with a blank line", () => {
    const message = formatCommitMessage({
      sourcesCount: 1,
      sourcesLine: "1 added, 0 changed, 0 removed",
      pagesCreated: 0,
      pagesUpdated: 1,
      lintReport: undefined,
    });

    expect(message.split("\n")[1]).toBe("");
  });
});

describe("formatFinalDigest sections", () => {
  function ranResult(overrides: {
    lintSummary?: string;
    commit?: CommitResult;
  }) {
    return {
      sync: { vaults: [], prunedNamespaces: [] },
      ingest: {
        status: "ran" as const,
        mode: "incremental" as const,
        digestPath: "outputs/runs/x.md",
        digest: "ingest digest body\n",
        pages: { created: [], updated: [], unavailable: undefined },
        diff: { vaults: [], empty: true },
      },
      lint: {
        reportPath: "outputs/lint-2026-08-20.md",
        reportWritten: true,
        summary: overrides.lintSummary ?? "lint summary body",
      },
      commit: overrides.commit ?? {
        status: "committed" as const,
        hash: "a1b2c3d4e5f6",
        message: "m",
      },
    };
  }

  it("states plainly when the cycle ended with nothing to commit", () => {
    const digest = formatFinalDigest(
      ranResult({
        commit: { status: "nothing-to-commit" },
      }),
    );

    expect(digest).toContain("- **Commit:** nothing to commit");
    expect(digest).not.toContain("undefined");
  });

  it("trims whitespace around the lint summary it embeds", () => {
    const digest = formatFinalDigest(
      ranResult({ lintSummary: "  padded summary  \n" }),
    );

    expect(digest).toContain("## Lint summary");
    expect(digest).not.toContain("padded summary  ");
    expect(digest).toContain("## Ingest digest");
    expect(digest).toContain("ingest digest body");
  });

  it("says the lint report was not written when the agent skipped it", () => {
    const result = ranResult({});
    const digest = formatFinalDigest({
      ...result,
      lint: { ...result.lint, reportWritten: false },
    });

    expect(digest).toContain(
      "- **Lint:** report not written (expected `outputs/lint-2026-08-20.md`)",
    );
  });

  it("ends with a newline", () => {
    expect(formatFinalDigest(ranResult({})).endsWith("\n")).toBe(true);
  });
});
