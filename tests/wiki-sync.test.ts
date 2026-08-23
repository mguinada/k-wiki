import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  type CrosslinksResult,
  formatCommitMessage,
  formatFinalDigest,
  LINT_HEARTBEAT_PREFIX,
  main,
  runCrosslinksStage,
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

/** The default lint stub: write the report where the prompt says. */
const lintStub: AgentRunner = async (_command, args, options) => {
  const prompt = args[args.indexOf("--print") + 1] ?? "";
  const reportPath = /outputs\/lint-\d{4}-\d{2}-\d{2}\.md/.exec(prompt)?.[0];

  if (reportPath !== undefined) {
    await mkdir(join(options.cwd, "outputs"), { recursive: true });
    await writeFile(
      join(options.cwd, reportPath),
      "# Lint report\n\nAll checks passed.\n",
    );
  }

  return { stdout: "lint: 149 pages audited, 0 problems", stderr: "" };
};

/**
 * The committed data-repo skeleton, built once per test file and copied
 * per harness: identical tree and git history to the per-test init it
 * replaced (one `init` commit, user t/t), minus the five git spawns
 * every makeHarness call used to pay.
 */
let dataRepoTemplate: Promise<string> | undefined;

function committedDataRepoTemplate(): Promise<string> {
  dataRepoTemplate ??= (async () => {
    const template = await mkdtemp(join(tmpdir(), "k-wiki-sync-tpl-"));

    tempDirs.push(template);

    await mkdir(join(template, "raw"), { recursive: true });
    await mkdir(join(template, "wiki"), { recursive: true });
    await writeFile(
      join(template, "raw", "manifest.json"),
      serializeManifest({ vaults: {} }),
    );
    await writeFile(join(template, "wiki", "index.md"), "# Index\n");
    await run("git", ["init", "--quiet"], { cwd: template });
    await run("git", ["config", "user.email", "t@t"], { cwd: template });
    await run("git", ["config", "user.name", "t"], { cwd: template });
    await run("git", ["add", "-A"], { cwd: template });
    await run("git", ["commit", "--quiet", "-m", "init"], {
      cwd: template,
    });

    return template;
  })();

  return dataRepoTemplate;
}

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
  await writeFile(join(promptsDir, "expunge.md"), "EXPUNGE PROMPT");
  await writeFile(
    join(promptsDir, "lint.md"),
    "AUDIT THE WIKI PROMPT\n\nSave the report to `outputs/lint-<YYYY-MM-DD>.md`.\n",
  );

  await cp(await committedDataRepoTemplate(), dataRoot, { recursive: true });

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

  it("commits a cycle whose data-repo outputs holds only the ignored snapshot", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async () => ({
      stdout: "lint: 149 pages audited, 0 problems",
      stderr: "",
    });

    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
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
    expect(h.invocations).toEqual([
      "FULL PROMPT",
      "AUDIT THE WIKI PROMPT\n\nSave the report to `outputs/lint-2026-08-20.md`.\n",
    ]);
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
      crosslinks: undefined,
      commit: { status: "nothing-to-commit" },
    });

    expect(digest).toBe("wiki-sync: nothing to do — no changed sources\n");
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
      crosslinks: undefined,
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

describe("runWikiSync crosslinks stage", () => {
  /** A domain wiki tree (wiki/ plus the sibling raw/manifest.json
   *  naming vault Engineering) for the audit to validate links
   *  against. */
  async function makeDomainWiki(h: Harness): Promise<string> {
    const root = join(dirname(h.dataRoot), "domain");

    await mkdir(join(root, "raw"), { recursive: true });
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(
      join(root, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: { Engineering: {} } }, null, 2)}\n`,
    );
    await writeFile(join(root, "wiki", "index.md"), "# Domain\\n");
    await writeFile(join(root, "wiki", "stub.md"), "# Stub\\n");

    return join(root, "wiki");
  }

  /** Point the instance's settings at the domain wiki and mark the
   *  data repo as a second brain (the operator-owned `.second-brain`
   *  marker, issue #94 — guardrails allow cross-wiki links only
   *  there). */
  async function configureDomains(h: Harness, domainWiki: string) {
    await writeFile(join(h.dataRoot, ".second-brain"), "");
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}secondBrain.domains: [${domainWiki}]\n`,
    );
  }

  /** An ingest stub filing one page whose body carries a cross-wiki
   *  link to the domain wiki (second-brain identity itself is the
   *  operator-owned `.second-brain` marker — see configureDomains). */
  function crosslinkAgent(link: string): AgentRunner {
    return async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "decision.md"),
        wikiPage(`Domain background in ${link}.`),
        { flag: "wx" },
      ).catch(() => {});
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "agent final report", stderr: "" };
    };
  }

  it("audits a configured instance every cycle and reports it in the digest", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");

    const result = await runWikiSync(optionsFor(h));

    expect(result.crosslinks).toMatchObject({
      domains: [domainWiki],
      external: 1,
      domainPages: 2,
    });
    expect(formatFinalDigest(result)).toContain(
      "- **Crosslinks:** ok — 1 cross-wiki link against 2 domain pages",
    );
  });

  it("numbers the crosslinks stage in the cycle progress", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);
    const progress: string[] = [];

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");
    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual("wiki-sync: stage 4/5 — crosslinks");
  });

  it("skips the stage outright when no domains are configured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await expect(
      runCrosslinksStage({ rawDir: join(h.dataRoot, "raw") }),
    ).resolves.toBeUndefined();
  });

  it("announces the domain wiki count on the progress line", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);
    const progress: string[] = [];

    await expect(
      runCrosslinksStage({
        rawDir: join(h.dataRoot, "raw"),
        domains: [domainWiki],
        onProgress: (message) => progress.push(message),
      }),
    ).resolves.toBeDefined();

    expect(progress).toContainEqual(
      "wiki-sync: crosslinks — auditing against 1 domain wiki",
    );
  });

  it("runs without a progress sink", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await expect(
      runCrosslinksStage({
        rawDir: join(h.dataRoot, "raw"),
        domains: [domainWiki],
      }),
    ).resolves.toBeDefined();
  });

  it("audits the wiki dir only, not the data repo around it", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    // A stray broken cross-wiki link OUTSIDE wiki/ must stay invisible
    // to the audit: only the data repo's wiki/ is audited.
    await writeFile(
      join(h.dataRoot, "stray-note.md"),
      "broken: [[engineering/missing]]\n",
    );

    await expect(
      runCrosslinksStage({
        rawDir: join(h.dataRoot, "raw"),
        domains: [domainWiki],
      }),
    ).resolves.toBeDefined();
  });

  it("fails the cycle naming a broken cross-wiki link, with no commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/missing]]");

    const before = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      /wiki\/decision\.md:\d+ -> \[\[engineering\/missing\]\]/,
    );
    expect(await headOf(h.dataRoot)).toBe(before);
  });

  it("emits no crosslinks stage line when the instance is unconfigured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).not.toContainEqual(expect.stringMatching(/crosslinks/));
  });

  it("joins every broken link into the failure message", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent(
      "[[engineering/missing]] and [[engineering/gone]]",
    );

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      /\[\[engineering\/missing\]\]; wiki\/decision\.md:\d+ -> \[\[engineering\/gone\]\]/,
    );
  });

  it("skips the audit when the instance is unconfigured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.crosslinks).toBeUndefined();
    expect(formatFinalDigest(result)).not.toContain("Crosslinks");
  });

  it("expands a leading ~ in a configured domain dir against home", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    // `~/domain/wiki` against the domain wiki's grandparent as home
    // names the same dir the harness built; home is injected —
    // mutating process.env.HOME is fragile under Stryker's sandbox.
    const result = await runCrosslinksStage({
      rawDir: join(h.dataRoot, "raw"),
      domains: ["~/domain/wiki"],
      home: dirname(dirname(domainWiki)),
    });

    expect(result?.domains).toEqual([domainWiki]);
  });

  it("runs the audit even when the ingest stage skips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");
    await runWikiSync(optionsFor(h));

    const second = await runWikiSync(optionsFor(h));

    expect(second.ingest.status).toBe("skipped");
    expect(second.crosslinks).toBeDefined();
    expect(formatFinalDigest(second)).toContain("crosslink audit passed");
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

  it("delivers the lint prompt with the concrete report path substituted", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    expect(h.invocations[1]).toContain("`outputs/lint-2026-08-20.md`");
    expect(h.invocations[1]).not.toContain("<YYYY-MM-DD>");
  });
});

const CLI_STUB =
  '#!/usr/bin/env node\nimport { existsSync } from "node:fs";\nimport { mkdir, writeFile } from "node:fs/promises";\nimport { join } from "node:path";\n// Guard: a mutated wrapper may redirect this stub into the real data\n// repo; refuse to write anywhere but this harness\'s data root.\nif (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);\nconst index = process.argv.indexOf("--print");\nconst prompt = index === -1 ? "" : process.argv[index + 1] ?? "";\nawait mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });\nawait writeFile(join(process.cwd(), "wiki", "concepts", "stub.md"), [\n  "---",\n  \'title: "Stub"\',\n  "type: concept",\n  "created: 2026-08-20",\n  "updated: 2026-08-20",\n  "tags:",\n  "  - llm",\n  "sources:",\n  \'  - "[[index]]"\',\n  "---",\n  "",\n  "stub body",\n  "",\n].join("\\n"));\nif (prompt.startsWith("Audit the wiki")) {\n  const reportPath = prompt.match(/outputs\\/lint-\\d{4}-\\d{2}-\\d{2}\\.md/)?.[0];\n  if (reportPath) {\n    await mkdir(join(process.cwd(), "outputs"), { recursive: true });\n    await writeFile(join(process.cwd(), reportPath), "# Lint\\n");\n  }\n  console.log("lint: clean");\n} else {\n  console.log("ingest report");\n}\n';

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

  it("states the isolation state on the lint invoking-agent progress line", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(progress.join("\n")).toContain(
      "wiki-sync: lint — invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
    );
  });

  it("passes --provider to the lint agent when the setting is present", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs).toContain("--provider");
    expect(lintArgs[lintArgs.indexOf("--provider") + 1]).toBe("zai");
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

  it("passes the pi isolation flags to the lint agent by default", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(
      ["--no-context-files", "--no-extensions", "--no-skills"].every((flag) =>
        lintArgs.includes(flag),
      ),
    ).toBe(true);
  });

  it("omits the isolation flags on an isolate: false opt-out", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nreasoning: high\nisolate: false\n",
    );
    await runWikiSync(optionsFor(h));

    for (const args of h.argRecords) {
      expect(
        ["--no-context-files", "--no-extensions", "--no-skills"].some((flag) =>
          args.includes(flag),
        ),
      ).toBe(false);
    }
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

  it("leaves files staged outside the cycle pathspecs out of the commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(join(h.dataRoot, "hand-notes.md"), "hand notes\n");
    await runGit(h.dataRoot, ["add", "hand-notes.md"], process.env);

    await runWikiSync(optionsFor(h));

    const { stdout: names } = await runGit(
      h.dataRoot,
      ["show", "--name-only", "--pretty=format:", "HEAD"],
      process.env,
    );

    expect(names).not.toContain("hand-notes.md");

    const { stdout: status } = await runGit(
      h.dataRoot,
      ["status", "--porcelain"],
      process.env,
    );

    expect(status).toContain("A  hand-notes.md");
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
    crosslinks?: CrosslinksResult;
    commit?: CommitResult;
  }) {
    return {
      sync: { vaults: [], prunedNamespaces: [] },
      ingest: {
        status: "ran" as const,
        mode: "incremental" as const,
        digestPath: "outputs/runs/x.md",
        digest: "ingest digest body\n",
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: undefined,
        },
        diff: { vaults: [], empty: true },
      },
      lint: {
        reportPath: "outputs/lint-2026-08-20.md",
        reportWritten: true,
        summary: overrides.lintSummary ?? "lint summary body",
      },
      crosslinks: overrides.crosslinks,
      commit: overrides.commit ?? {
        status: "committed" as const,
        hash: "a1b2c3d4e5f6",
        message: "m",
      },
    };
  }

  it("lists the crosslink audit when the instance is configured", () => {
    const digest = formatFinalDigest(
      ranResult({
        crosslinks: { domains: ["/d/wiki"], external: 1, domainPages: 12 },
      }),
    );

    expect(digest).toContain(
      "- **Crosslinks:** ok — 1 cross-wiki link against 12 domain pages",
    );
  });

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
