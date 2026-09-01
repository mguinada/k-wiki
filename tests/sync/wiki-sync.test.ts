import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../src/data/git.ts";
import {
  type AgentRunner,
  createAgentProgressSink,
} from "../../src/ingest/agent-run.ts";
import { serializeManifest } from "../../src/sync/manifest.ts";
import {
  type CommitResult,
  type CrosslinksResult,
  formatCommitMessage,
  formatFinalDigest,
  LINT_HEARTBEAT_PREFIX,
  main,
  runCrosslinksStage,
  runLintStage,
  runVerificationStage,
  runWikiSync,
} from "../../src/sync/wiki-sync.ts";

const run = promisify(execFile);

const NOW = () => new Date("2026-08-20T18:00:00.000Z");

const SETTINGS_YML = "command: pi\nmodel: GLM-5.2\nreasoning: high\n";

/** A wiki page body with valid §9 frontmatter (guardrail 2 must
 *  pass) whose title kebab-cases to the file name the caller writes
 *  (check-fidelity must pass; `index` callers rely on the structural
 *  exemption). */
function wikiPage(body: string, title = "Page"): string {
  return frontmatterPage(title, "concept", ["sources:", '  - "[[src]]"'], body);
}

/** A wiki page whose frontmatter carries the given type plus extra
 *  fields — the shape the fidelity/provenance failure fixtures build. */
function frontmatterPage(
  title: string,
  type: string,
  extra: readonly string[],
  body: string,
): string {
  return [
    "---",
    `title: "${title}"`,
    `type: ${type}`,
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    ...extra,
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
}, 120_000);

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
    wikiPage("New page", "New"),
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
    await mkdir(join(template, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(template, ".gitignore"),
      "# Obsidian UI state: never part of the wiki (external writer; guardrail 1 hazard)\n.obsidian/\nwiki/.obsidian/\n\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n",
    );
    await writeFile(
      join(template, "raw", "manifest.json"),
      serializeManifest({ vaults: {} }),
    );
    await writeFile(join(template, "wiki", "index.md"), "# Index\n");
    await writeFile(
      join(template, "wiki", "sources", "src.md"),
      "---\ntitle: Src\ntype: source\ncreated: 2026-08-20\nupdated: 2026-08-20\ntags:\n  - source\n---\nHub.\n",
    );
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

/** A domain wiki tree beside the harness's data repo (wiki/ plus the
 *  sibling raw/manifest.json naming vault Engineering) for crosslink
 *  audit and verification-ordering tests to validate links against. */
async function makeDomainWiki(h: Harness): Promise<string> {
  const root = join(dirname(h.dataRoot), "domain");

  await mkdir(join(root, "raw"), { recursive: true });
  await mkdir(join(root, "wiki"), { recursive: true });
  await writeFile(
    join(root, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: { Engineering: {} } }, null, 2)}\n`,
  );
  await writeFile(join(root, "wiki", "index.md"), "# Domain\n");
  await writeFile(join(root, "wiki", "stub.md"), "# Stub\n");

  return join(root, "wiki");
}

/** Point the instance's settings at a domain wiki and mark the data
 *  repo as a second brain (the operator-owned `.second-brain` marker,
 *  issue #94 — guardrails allow cross-wiki links only there). */
async function configureDomains(h: Harness, domainWiki: string) {
  await writeFile(join(h.dataRoot, ".second-brain"), "");
  await writeFile(
    h.settingsPath,
    `${SETTINGS_YML}secondBrain.domains: [${domainWiki}]\n`,
  );
}

describe("runWikiSync", () => {
  it("commits the whole cycle in the data repo", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
  });

  it("summarizes the touched-page count in the commit message subject", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    await runWikiSync(optionsFor(h));
    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain("wiki-sync: 1 source processed, 2 pages touched");
  });

  it("summarizes added sources in the commit message", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    await runWikiSync(optionsFor(h));
    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain("- sources: 1 added, 0 changed, 0 removed");
  });

  it("summarizes created and updated pages in the commit message", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    await runWikiSync(optionsFor(h));
    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain("- pages: 1 created, 1 updated");
  });

  it("names the lint report in the commit message", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    await runWikiSync(optionsFor(h));
    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain("- lint: outputs/lint-2026-08-20.md");
  });

  it("processes a renamed source in the next cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "---\ntags: [a]\n---\nbody\n" });

    await runWikiSync(optionsFor(h));
    await rm(join(h.vaultRoot, "AI", "RAG.md"));
    await writeFile(
      join(h.vaultRoot, "AI", "Deep research.md"),
      "---\ntags: [a, b]\n---\nbody\n",
    );
    await runWikiSync(optionsFor(h));

    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain("wiki-sync: 1 source processed");
  });

  it("counts a renamed source in the commit message source summary", async () => {
    const h = await makeHarness({ "AI/RAG.md": "---\ntags: [a]\n---\nbody\n" });

    await runWikiSync(optionsFor(h));
    await rm(join(h.vaultRoot, "AI", "RAG.md"));
    await writeFile(
      join(h.vaultRoot, "AI", "Deep research.md"),
      "---\ntags: [a, b]\n---\nbody\n",
    );
    await runWikiSync(optionsFor(h));

    const { stdout } = await runGit(
      h.dataRoot,
      ["log", "-1", "--pretty=%B"],
      process.env,
    );

    expect(stdout).toContain(
      "- sources: 0 added, 0 changed, 0 removed, 1 renamed",
    );
  });

  it("marks the lint report as written", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.lint?.reportWritten).toBe(true);
  });

  it("writes the lint report into the data repo outputs", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    await runWikiSync(optionsFor(h));

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

  it("excludes the ignored ingest snapshot from the cycle commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async () => ({
      stdout: "lint: 149 pages audited, 0 problems",
      stderr: "",
    });

    await runWikiSync(optionsFor(h));

    const { stdout: names } = await run("git", [
      "-C",
      h.dataRoot,
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);

    expect(names).not.toContain("outputs/last-ingested-manifest.json");
  });

  it("skips the ingest when nothing changed", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));
    const result = await runWikiSync(optionsFor(h));

    expect(result.ingest.status).toBe("skipped");
  });

  it("runs no lint stage when nothing changed", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));
    const result = await runWikiSync(optionsFor(h));

    expect(result.lint).toBeUndefined();
  });

  it("commits nothing when nothing changed", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));
    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("nothing-to-commit");
  });

  it("leaves the data repo HEAD untouched when nothing changed", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));
    const headBefore = await headOf(h.dataRoot);
    await runWikiSync(optionsFor(h));

    expect(await headOf(h.dataRoot)).toBe(headBefore);
  });

  it("runs no agent on a no-change cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));
    await runWikiSync(optionsFor(h));

    expect(h.invocations).toEqual([
      "FULL PROMPT",
      "AUDIT THE WIKI PROMPT\n\nSave the report to `outputs/lint-2026-08-20.md`.\n",
    ]);
  });

  it("fails the cycle when the ingest agent fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");
  });

  it("commits nothing when the ingest agent fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    const headBefore = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");

    expect(await headOf(h.dataRoot)).toBe(headBefore);
  });

  it("fails the cycle when a lint guardrail trips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue lint", stderr: "" };
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "guardrail check 2 (frontmatter)",
    );
  });

  it("reverts to the pre-run commit when a lint guardrail trips", async () => {
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
  });

  it("removes the rogue page when the lint revert runs", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue lint", stderr: "" };
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "guardrail check 2 (frontmatter)",
    );

    await expect(
      readFile(join(h.dataRoot, "wiki", "concepts", "broken.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the ingest changes when the lint revert runs", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue lint", stderr: "" };
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "guardrail check 2 (frontmatter)",
    );

    await expect(
      readFile(join(h.dataRoot, "wiki", "concepts", "new.md"), "utf8"),
    ).resolves.toContain("New page");
  });

  it("re-runs a full ingest after a failed run even when sync reports no changes", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");

    h.ingestAgent = ingestStub;

    const result = await runWikiSync(optionsFor(h));

    expect(result.ingest.status).toBe("ran");
  });

  it("invokes the full prompt again on the retry run", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");

    h.ingestAgent = ingestStub;

    await runWikiSync(optionsFor(h));

    expect(h.invocations.filter((p) => p === "FULL PROMPT")).toHaveLength(2);
  });

  it("commits the retry cycle after a failed run", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");

    h.ingestAgent = ingestStub;

    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
  });

  it("digests no source changes on the retry run", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.ingestAgent = async () => {
      throw new Error("agent exploded");
    };

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow("agent exploded");

    h.ingestAgent = ingestStub;

    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toContain("no source changes");
  });
});

describe("runWikiSync ingest pre-flight (issue #146)", () => {
  /** The hazard order of k-wiki-meta-data 72dce82: commit the Obsidian
   *  UI state first, add the ignore rule afterwards — gitignore does
   *  not apply to tracked files. */
  async function trackIgnoredObsidianState(h: Harness): Promise<void> {
    // Start from a .gitignore without the Obsidian rule, so the UI
    // state is trackable; the rule lands only after the commit.
    await writeFile(
      join(h.dataRoot, ".gitignore"),
      "outputs/last-ingested-manifest.json\n",
    );
    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      h.dataRoot,
      "commit",
      "--quiet",
      "-m",
      "track obsidian state",
    ]);
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");
  }

  it("surfaces the tracked-but-ignored warning in the cycle progress", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await trackIgnoredObsidianState(h);

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(
      progress.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes("git rm --cached .obsidian/workspace.json"),
      ),
    ).toBe(true);
  });

  it("emits exactly one pre-flight warning per tracked-but-ignored file", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await trackIgnoredObsidianState(h);

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(
      progress.filter((message) => message.includes("is tracked but ignored")),
    ).toHaveLength(1);
  });

  it("still commits the cycle when a tracked-but-ignored file is present", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await trackIgnoredObsidianState(h);

    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
  });
});

describe("runWikiSync repo-sourced instances", () => {
  /** A harness whose config is repo-sourced (the meta shape): a
   *  committed temp source repo, `source: "repo"` config, and the
   *  same committed data-repo skeleton and agent stubs as the vault
   *  harness (issue #145: stage 1 dispatches on source kind). */
  async function makeRepoHarness(): Promise<
    Harness & { readonly sourceRoot: string }
  > {
    const h = await makeHarness({});
    const sourceRoot = join(dirname(h.dataRoot), "source");

    await mkdir(join(sourceRoot, "docs"), { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "readme body\n");
    await writeFile(join(sourceRoot, "docs", "guide.md"), "guide\n");
    await run("git", ["init", "--quiet"], { cwd: sourceRoot });
    await run("git", ["config", "user.email", "t@t"], { cwd: sourceRoot });
    await run("git", ["config", "user.name", "t"], { cwd: sourceRoot });
    await run("git", ["add", "-A"], { cwd: sourceRoot });
    await run("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: sourceRoot,
    });
    await writeFile(
      h.configPath,
      JSON.stringify({
        dataRoot: h.dataRoot,
        vaults: [
          {
            source: "repo",
            name: "k-wiki",
            root: sourceRoot,
            include: ["README.md", "docs/*.md"],
          },
        ],
      }),
    );

    return { ...h, sourceRoot };
  }

  it("commits a repo-sourced cycle", async () => {
    const h = await makeRepoHarness();
    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
  });

  it("projects the source repo files into raw notes for a repo-sourced config", async () => {
    const h = await makeRepoHarness();
    await runWikiSync(optionsFor(h));

    await expect(
      readFile(join(h.dataRoot, "raw", "notes", "k-wiki", "README.md"), "utf8"),
    ).resolves.toBe("readme body\n");
  });

  it("stamps the manifest with the source repo HEAD for a repo-sourced config", async () => {
    const h = await makeRepoHarness();
    await runWikiSync(optionsFor(h));

    const manifest = JSON.parse(
      await readFile(join(h.dataRoot, "raw", "manifest.json"), "utf8"),
    );
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: h.sourceRoot,
    });

    expect(manifest.source_commit).toBe(stdout.trim());
  });

  it("refuses a mixed vault+repo config", async () => {
    const h = await makeRepoHarness();

    await writeFile(
      h.configPath,
      JSON.stringify({
        vaults: [
          {
            source: "repo",
            name: "k-wiki",
            root: h.sourceRoot,
            include: ["README.md"],
          },
          {
            name: "Engineering",
            root: join(dirname(h.dataRoot), "vault"),
            exclude: "wiki:false",
          },
        ],
      }),
    );

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "mixed source kinds",
    );
  });

  it("carries the copied-source count in the repo sync summary", async () => {
    const h = await makeRepoHarness();
    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toContain(
      "2 sources copied, 0 sources removed",
    );
  });

  it("carries the source commit in the repo sync summary", async () => {
    const h = await makeRepoHarness();
    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toMatch(/at commit [0-9a-f]{8}/);
  });

  it("stamps the repo sync summary with exactly the 8-char source commit", async () => {
    const h = await makeRepoHarness();
    const result = await runWikiSync(optionsFor(h));
    const { stdout: sourceHead } = await run("git", ["rev-parse", "HEAD"], {
      cwd: h.sourceRoot,
    });
    const sha8 = sourceHead.trim().slice(0, 8);

    expect(formatFinalDigest(result)).toMatch(
      new RegExp(
        `^- \\*\\*Sync:\\*\\* 2 sources copied, 0 sources removed at commit ${sha8}$`,
        "m",
      ),
    );
  });

  it("ends the vault sync summary line right after the removed count", async () => {
    const h = await makeRepoHarness();

    await writeFile(
      h.configPath,
      JSON.stringify({
        dataRoot: h.dataRoot,
        vaults: [
          {
            name: "Engineering",
            root: join(dirname(h.dataRoot), "vault"),
            exclude: "wiki:false",
          },
        ],
      }),
    );
    await mkdir(join(dirname(h.dataRoot), "vault"), { recursive: true });
    await writeFile(
      join(dirname(h.dataRoot), "vault", "note.md"),
      "note body\n",
    );

    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toMatch(
      /^- \*\*Sync:\*\* 1 source copied, 0 sources removed$/m,
    );
  });

  it("announces stage 1 as sync-repo for a repo-sourced config", async () => {
    const h = await makeRepoHarness();
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual("wiki-sync: stage 1/5 — sync-repo");
  });

  it("does not announce sync-vault for a repo-sourced config", async () => {
    const h = await makeRepoHarness();
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).not.toContainEqual("wiki-sync: stage 1/5 — sync-vault");
  });
});

describe("runWikiSync publish stage (issue #15)", () => {
  /** Point the harness's config at a mirror vault (guide §26). */
  async function configurePublish(h: Harness, mirror: string): Promise<void> {
    const config = JSON.parse(await readFile(h.configPath, "utf8"));

    config.publish = { mirror, include: ["wiki/**"] };
    await writeFile(h.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  it("publishes the wiki into the configured mirror after the commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");

    await configurePublish(h, mirror);
    const result = await runWikiSync(optionsFor(h));

    expect(result.publish).toBeDefined();
    await expect(
      readFile(join(mirror, "wiki", "concepts", "new.md"), "utf8"),
    ).resolves.toContain("New page");
  });

  it("re-roots the mirror when the config sets publish.root", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");

    const config = JSON.parse(await readFile(h.configPath, "utf8"));

    config.publish = { mirror, include: ["wiki/**"], root: "wiki" };
    await writeFile(h.configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await runWikiSync(optionsFor(h));

    expect(result.publish).toBeDefined();
    await expect(
      readFile(join(mirror, "concepts", "new.md"), "utf8"),
    ).resolves.toContain("New page");
  });

  it("skips publish when the config has no publish section", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.publish).toBeUndefined();
  });

  it("digests the publish summary", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");

    await configurePublish(h, mirror);
    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toMatch(
      /^- \*\*Publish:\*\* ok — \d+ files? copied, \d+ files? removed/m,
    );
  });

  it("heals a mangled mirror on a no-change cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");

    await configurePublish(h, mirror);
    await runWikiSync(optionsFor(h));
    await rm(join(mirror, "wiki", "concepts", "new.md"));

    const second = await runWikiSync(optionsFor(h));

    await expect(
      readFile(join(mirror, "wiki", "concepts", "new.md"), "utf8"),
    ).resolves.toContain("New page");
    expect(second.publish).toEqual({ copied: 1, removed: 0 });
  });

  it("numbers the publish stage after the commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");
    const progress: string[] = [];

    await configurePublish(h, mirror);
    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual("wiki-sync: stage 5/6 — commit");
    expect(progress).toContainEqual("wiki-sync: stage 6/6 — publish");
  });

  it("withholds the nothing-to-do digest when publish did work", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");

    await configurePublish(h, mirror);
    await runWikiSync(optionsFor(h));
    await writeFile(join(mirror, "wiki", "stray.md"), "mangled\n");

    const second = await runWikiSync(optionsFor(h));

    expect(second.publish).toEqual({ copied: 0, removed: 1 });
    expect(formatFinalDigest(second)).not.toMatch(/^wiki-sync: nothing to do/);
  });

  it("keeps the nothing-to-do digest over a quiet mirror", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const mirror = join(dirname(h.dataRoot), "KWiki");

    await configurePublish(h, mirror);
    await runWikiSync(optionsFor(h));

    const second = await runWikiSync(optionsFor(h));

    expect(second.publish).toEqual({ copied: 0, removed: 0 });
    expect(formatFinalDigest(second)).toMatch(/^wiki-sync: nothing to do/);
  });
});

describe("formatFinalDigest", () => {
  it("states nothing to do when the cycle was a no-op", () => {
    const digest = formatFinalDigest({
      sync: { vaults: [], prunedNamespaces: [] },
      ingest: { status: "skipped", reason: "no changed sources" },
      lint: undefined,
      crosslinks: undefined,
      verification: {
        fidelity: { problems: [], quotes: 0, titles: 0, skipped: 0, pages: 1 },
        provenance: {
          problems: [],
          sources: 0,
          origins: 0,
          missingOrigins: 0,
          pages: 1,
        },
      },
      commit: { status: "nothing-to-commit" },
    });

    expect(digest).toBe(
      "wiki-sync: nothing to do — no changed sources; fidelity + provenance ok\n",
    );
  });

  it("leads the digest with the synced-source count", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(formatFinalDigest(result)).toContain(
      "1 source copied, 0 sources removed",
    );
  });

  it("digests a full ingest with its digest pointer", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(formatFinalDigest(result)).toContain(
      "- **Ingest:** full — digest below",
    );
  });

  it("digests the lint report path", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(formatFinalDigest(result)).toContain(
      "- **Lint:** report `outputs/lint-2026-08-20.md`",
    );
  });

  it("digests the commit hash", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(formatFinalDigest(result)).toContain(
      `- **Commit:** \`${result.commit.hash.slice(0, 8)}\``,
    );
  });

  it("digests the lint summary section", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(formatFinalDigest(result)).toContain("## Lint summary");
  });

  it("digests the ingest digest section", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(formatFinalDigest(result)).toContain("## Ingest digest");
  });

  it("names pruned namespaces in the sync summary", () => {
    const digest = formatFinalDigest({
      sync: { vaults: [], prunedNamespaces: ["Old"] },
      ingest: { status: "skipped", reason: "no changed sources" },
      lint: undefined,
      crosslinks: undefined,
      verification: {
        fidelity: { problems: [], quotes: 0, titles: 0, skipped: 0, pages: 1 },
        provenance: {
          problems: [],
          sources: 0,
          origins: 0,
          missingOrigins: 0,
          pages: 1,
        },
      },
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
      { dim: (text) => text, yellow: (text) => text },
      [LINT_HEARTBEAT_PREFIX],
    );

    sink.render(`${LINT_HEARTBEAT_PREFIX} (2m07s)`);

    expect(written[0]).toContain("\r");
  });
});

describe("runWikiSync crosslinks stage", () => {
  /** An ingest stub filing one page whose body carries a cross-wiki
   *  link to the domain wiki (second-brain identity itself is the
   *  operator-owned `.second-brain` marker — see configureDomains). */
  function crosslinkAgent(link: string): AgentRunner {
    return async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "decision.md"),
        wikiPage(`Domain background in ${link}.`, "Decision"),
        { flag: "wx" },
      ).catch(() => {});
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "agent final report", stderr: "" };
    };
  }

  it("audits a configured instance every cycle", async () => {
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
  });

  it("reports the crosslink audit in the digest", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");

    const result = await runWikiSync(optionsFor(h));

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

    expect(progress).toContainEqual("wiki-sync: stage 4/6 — crosslinks");
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

    await runCrosslinksStage({
      rawDir: join(h.dataRoot, "raw"),
      domains: [domainWiki],
      onProgress: (message) => progress.push(message),
    });

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

  it("fails the cycle naming a broken cross-wiki link", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/missing]]");

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      /wiki\/decision\.md:\d+ -> \[\[engineering\/missing\]\]/,
    );
  });

  it("commits nothing when the crosslink audit fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/missing]]");

    const before = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

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

  it("skips the crosslinks audit when the instance is unconfigured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(result.crosslinks).toBeUndefined();
  });

  it("digests no crosslinks section when the instance is unconfigured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).not.toContain("Crosslinks");
  });

  it("expands a leading ~ in a configured domain dir against home", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    // Inject the domain wiki's grandparent so `~/domain/wiki` names
    // the same dir the harness built. Injected, not env-mutated:
    // `os.homedir()` reads the process's C environ, which worker
    // threads (Stryker's vitest pool) do not share with `process.env`.
    const result = await runCrosslinksStage({
      rawDir: join(h.dataRoot, "raw"),
      domains: ["~/domain/wiki"],
      home: dirname(dirname(domainWiki)),
    });

    expect(result?.domains).toEqual([domainWiki]);
  });

  it("skips the ingest on a no-change cycle even with domains configured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");
    await runWikiSync(optionsFor(h));

    const second = await runWikiSync(optionsFor(h));

    expect(second.ingest.status).toBe("skipped");
  });

  it("still audits crosslinks when the ingest stage skips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");
    await runWikiSync(optionsFor(h));

    const second = await runWikiSync(optionsFor(h));

    expect(second.crosslinks).toBeDefined();
  });

  it("digests the passed crosslink audit when the ingest stage skips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);

    await configureDomains(h, domainWiki);
    h.ingestAgent = crosslinkAgent("[[engineering/stub]]");
    await runWikiSync(optionsFor(h));

    const second = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(second)).toContain("crosslink audit passed");
  });
});

describe("runVerificationStage", () => {
  /** A minimal data-repo shape for the stage: wiki/ beside raw/,
   *  one title-clean concept page with a resolvable source link. */
  async function makeVerificationRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-verify-"));

    tempDirs.push(root);

    await mkdir(join(root, "wiki", "concepts"), { recursive: true });
    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await mkdir(join(root, "raw"), { recursive: true });
    await writeFile(join(root, "wiki", "index.md"), "# Index\n");
    await writeFile(
      join(root, "wiki", "sources", "src.md"),
      "---\ntitle: Src\ntype: source\ncreated: 2026-08-20\nupdated: 2026-08-20\ntags:\n  - source\n---\nHub.\n",
    );
    await writeFile(
      join(root, "wiki", "concepts", "clean.md"),
      wikiPage("Clean body", "Clean"),
    );

    return root;
  }

  it("reports no fidelity problems for a faithful wiki", async () => {
    const root = await makeVerificationRoot();

    const result = await runVerificationStage({ rawDir: join(root, "raw") });

    expect(result.fidelity.problems).toEqual([]);
  });

  it("reports no provenance problems for a coherent wiki", async () => {
    const root = await makeVerificationRoot();

    const result = await runVerificationStage({ rawDir: join(root, "raw") });

    expect(result.provenance.problems).toEqual([]);
  });

  it("rejects listing one line per fidelity problem", async () => {
    const root = await makeVerificationRoot();

    await writeFile(
      join(root, "wiki", "concepts", "drifted.md"),
      wikiPage("Drifted body", "Elsewhere"),
    );
    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await mkdir(join(root, "raw", "notes", "Engineering", "AI"), {
      recursive: true,
    });
    await writeFile(
      join(root, "raw", "notes", "Engineering", "AI", "RAG.md"),
      "rag body without the command\n",
    );
    await writeFile(
      join(root, "wiki", "sources", "misquote.md"),
      frontmatterPage(
        "Misquote",
        "source",
        ["origin: notes/Engineering/AI/RAG.md"],
        "Run `npm run build`.",
      ),
    );

    await expect(
      runVerificationStage({ rawDir: join(root, "raw") }),
    ).rejects.toThrow(
      "fidelity check failed:\n" +
        'wiki/concepts/drifted.md -> title "Elsewhere" does not kebab to drifted\n' +
        "wiki/sources/misquote.md -> `npm run build` not in origin notes/Engineering/AI/RAG.md",
    );
  });

  it("rejects listing one line per provenance problem", async () => {
    const root = await makeVerificationRoot();

    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(root, "wiki", "sources", "dead-origin.md"),
      frontmatterPage(
        "Dead Origin",
        "source",
        ["origin: notes/Engineering/gone.md"],
        "body without artifacts",
      ),
    );
    await writeFile(
      join(root, "wiki", "sources", "dead-link.md"),
      frontmatterPage(
        "Dead Link",
        "concept",
        ["sources:", '  - "[[gone-page]]"'],
        "body",
      ),
    );

    await expect(
      runVerificationStage({ rawDir: join(root, "raw") }),
    ).rejects.toThrow(
      "provenance check failed:\n" +
        "wiki/sources/dead-link.md -> [[gone-page]] (missing source page)\n" +
        "wiki/sources/dead-origin.md -> origin notes/Engineering/gone.md (missing under raw/)",
    );
  });

  it("announces the check on the progress line", async () => {
    const root = await makeVerificationRoot();
    const progress: string[] = [];

    await runVerificationStage({
      rawDir: join(root, "raw"),
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContain(
      "wiki-sync: verification — checking citation fidelity and provenance",
    );
  });
});

describe("runWikiSync verification stage", () => {
  it("reports the fidelity line in the cycle digest", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toMatch(
      /- \*\*Fidelity:\*\* ok — \d+ tokens? trace to origins, \d+ titles? match(?:es)? across \d+ pages?/,
    );
  });

  it("reports the provenance line in the cycle digest", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toMatch(
      /- \*\*Provenance:\*\* ok — \d+ source links? resolve, \d+ origins? exist across \d+ pages?/,
    );
  });

  it("numbers the verification stage in the cycle progress", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual("wiki-sync: stage 4/5 — verification");
  });

  it("numbers the commit stage in the cycle progress", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual("wiki-sync: stage 5/5 — commit");
  });

  it("announces the crosslinks stage when domains are configured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);
    const progress: string[] = [];

    await configureDomains(h, domainWiki);

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContain("wiki-sync: stage 4/6 — crosslinks");
  });

  it("runs verification after the crosslink audit when domains are configured", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const domainWiki = await makeDomainWiki(h);
    const progress: string[] = [];

    await configureDomains(h, domainWiki);

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (m) => progress.push(m),
    });

    const crosslinks = progress.indexOf("wiki-sync: stage 4/6 — crosslinks");
    const verification = progress.indexOf(
      "wiki-sync: stage 5/6 — verification",
    );

    expect(verification).toBeGreaterThan(crosslinks);
  });

  /** A lint agent that also writes a title-drifted page, tripping
   *  the fidelity check after the guardrails pass. */
  function fidelityDriftLintAgent(): AgentRunner {
    return async (command, args, options) => {
      const result = await lintStub(command, args, options);

      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "drifted.md"),
        wikiPage("Drifted body", "Elsewhere"),
      );

      return result;
    };
  }

  it("fails the cycle on a fidelity problem", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = fidelityDriftLintAgent();

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      "fidelity check failed:\n" +
        'wiki/concepts/drifted.md -> title "Elsewhere" does not kebab to drifted',
    );
  });

  it("reverts to the pre-run commit when verification fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = fidelityDriftLintAgent();

    const headBefore = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

    expect(await headOf(h.dataRoot)).toBe(headBefore);
  });

  it("announces the lint revert on the progress line when verification fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = fidelityDriftLintAgent();

    const headBefore = await headOf(h.dataRoot);
    const progress: string[] = [];

    await expect(
      runWikiSync({ ...optionsFor(h), onProgress: (m) => progress.push(m) }),
    ).rejects.toThrow();

    expect(progress).toContain(
      `wiki-sync: verification failed — reverting lint edits to ${headBefore.slice(0, 8)} (ingest edits kept)`,
    );
  });

  it("removes the reverted lint report when verification fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = fidelityDriftLintAgent();

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

    await expect(
      readFile(join(h.dataRoot, "outputs", "lint-2026-08-20.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the drifted page when verification reverts the lint edits", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = fidelityDriftLintAgent();

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

    await expect(
      readFile(join(h.dataRoot, "wiki", "concepts", "drifted.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the ingest edits when verification reverts the lint edits", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = fidelityDriftLintAgent();

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

    await expect(
      readFile(join(h.dataRoot, "wiki", "concepts", "new.md"), "utf8"),
    ).resolves.toContain("New page");
  });

  /** A lint agent that also writes a page with a dead origin link,
   *  tripping the provenance check after the guardrails pass. */
  function deadOriginLintAgent(): AgentRunner {
    return async (command, args, options) => {
      const result = await lintStub(command, args, options);

      await mkdir(join(options.cwd, "wiki", "sources"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "sources", "dead-origin.md"),
        frontmatterPage(
          "Dead Origin",
          "source",
          ["origin: notes/Engineering/gone.md"],
          "body without artifacts",
        ),
      );

      return result;
    };
  }

  it("fails the cycle on a provenance problem", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = deadOriginLintAgent();

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow(
      /provenance check failed:[\s\S]*dead-origin\.md -> origin notes\/Engineering\/gone\.md \(missing under raw\/\)/,
    );
  });

  it("commits nothing when the provenance check fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = deadOriginLintAgent();

    const headBefore = await headOf(h.dataRoot);

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

    expect(await headOf(h.dataRoot)).toBe(headBefore);
  });

  it("removes the rogue page when the provenance check fails", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = deadOriginLintAgent();

    await expect(runWikiSync(optionsFor(h))).rejects.toThrow();

    await expect(
      readFile(join(h.dataRoot, "wiki", "sources", "dead-origin.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips the ingest on a second unchanged cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const result = await runWikiSync(optionsFor(h));

    expect(result.ingest.status).toBe("skipped");
  });

  it("checks the wiki even when the ingest stage skips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const result = await runWikiSync(optionsFor(h));

    expect(result.verification.fidelity.problems).toEqual([]);
  });

  it("digests nothing to do for an unchanged second cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toContain("nothing to do");
  });

  it("digests fidelity and provenance ok for an unchanged second cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const result = await runWikiSync(optionsFor(h));

    expect(formatFinalDigest(result)).toContain("; fidelity + provenance ok");
  });
});

describe("runWikiSync lint stage", () => {
  it("captures its own pre-run state when the caller passes none", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const saboteur: AgentRunner = async (_command, args, options) => {
      const prompt = args[args.indexOf("--print") + 1] ?? "";
      const reportPath = /outputs\/lint-\d{4}-\d{2}-\d{2}\.md/.exec(
        prompt,
      )?.[0];

      if (reportPath !== undefined) {
        await mkdir(join(options.cwd, "outputs"), { recursive: true });
        await writeFile(join(options.cwd, reportPath), "# Lint report\n");
      }

      await writeFile(
        join(options.cwd, "wiki", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "lint done", stderr: "" };
    };

    await expect(
      runLintStage({
        settingsPath: h.settingsPath,
        rawDir: join(h.dataRoot, "raw"),
        promptsDir: h.promptsDir,
        env: optionsFor(h).env,
        now: NOW,
        runAgent: saboteur,
      }),
    ).rejects.toThrow(/lint guardrail check 2 \(frontmatter\)/);
  });

  it("derives the report path from the real clock when the caller passes none", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const expectedPath = `outputs/lint-${new Date().toISOString().slice(0, 10)}.md`;

    const result = await runLintStage({
      settingsPath: h.settingsPath,
      rawDir: join(h.dataRoot, "raw"),
      promptsDir: h.promptsDir,
      env: optionsFor(h).env,
      runAgent: lintStub,
    });

    expect(result.reportPath).toBe(expectedPath);
  });
  it("reports an unwritten lint report", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async () => ({ stdout: "lint done", stderr: "" });

    const result = await runWikiSync(optionsFor(h));

    expect(result.lint?.reportWritten).toBe(false);
  });

  it("commits the cycle even when the lint agent wrote no outputs report", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = async () => ({ stdout: "lint done", stderr: "" });

    const result = await runWikiSync(optionsFor(h));

    expect(result.commit.status).toBe("committed");
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
  });

  it("leaves no date placeholder in the lint prompt", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    expect(h.invocations[1]).not.toContain("<YYYY-MM-DD>");
  });
});

const CLI_STUB =
  '#!/usr/bin/env node\nimport { existsSync } from "node:fs";\nimport { mkdir, writeFile } from "node:fs/promises";\nimport { join } from "node:path";\n// Guard: a mutated wrapper may redirect this stub into the real data\n// repo; refuse to write anywhere but this harness\'s data root.\nif (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);\nconst index = process.argv.indexOf("--print");\nconst prompt = index === -1 ? "" : process.argv[index + 1] ?? "";\nawait mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });\nawait writeFile(join(process.cwd(), "wiki", "concepts", "stub.md"), [\n  "---",\n  \'title: "Stub"\',\n  "type: concept",\n  "created: 2026-08-20",\n  "updated: 2026-08-20",\n  "tags:",\n  "  - llm",\n  "sources:",\n  \'  - "[[src]]"\',\n  "---",\n  "",\n  "stub body",\n  "",\n].join("\\n"));\nif (prompt.startsWith("Audit the wiki")) {\n  const reportPath = prompt.match(/outputs\\/lint-\\d{4}-\\d{2}-\\d{2}\\.md/)?.[0];\n  if (reportPath) {\n    await mkdir(join(process.cwd(), "outputs"), { recursive: true });\n    await writeFile(join(process.cwd(), reportPath), "# Lint\\n");\n  }\n  console.log("lint: clean");\n} else {\n  console.log("ingest report");\n}\n';

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

  it("documents the --settings switch in the help text", async () => {
    expect((await runCli(["--help"])).out).toContain("--settings");
  });

  it("documents the isolate whitelist keys in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("isolate.skills");
    expect(out).toContain("isolate.extensions");
  });

  it("documents the --outputs switch in the help text", async () => {
    expect((await runCli(["--help"])).out).toContain("--outputs");
  });

  it("documents the --timeout switch in the help text", async () => {
    expect((await runCli(["--help"])).out).toContain("--timeout");
  });

  it("documents the config positional in the help text", async () => {
    expect((await runCli(["--help"])).out).toContain("<config>");
  });

  it("documents the raw-dir positional in the help text", async () => {
    expect((await runCli(["--help"])).out).toContain("<raw-dir>");
  });

  it("documents the defaults in the help text", async () => {
    expect((await runCli(["--help"])).out).toContain("Default");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "/no/such/config"]);

    expect(out).toContain("Usage: wiki-sync");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("names the unknown option in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--nope"]);

    expect(err).toContain('wiki-sync: unknown option "--nope"');
  });

  it("exits 1 on an unknown option", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "--nope"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the invalid --timeout in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout", "zero"]);

    expect(err).toContain("--timeout needs a positive integer");
  });

  it("exits 1 when --timeout is not a positive integer", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "--timeout", "zero"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --settings value in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--outputs",
      h.outputsDir,
      h.configPath,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(err).toContain("--settings needs a path value");
  });

  it("exits 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--outputs",
      h.outputsDir,
      h.configPath,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("names the extra positional arguments in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "a.json", "raw", "extra"]);

    expect(err).toContain("expected at most two arguments");
  });

  it("exits 1 on more than two positional arguments", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "a.json", "raw", "extra"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the unread settings file in the error", async () => {
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
  });

  it("exits 1 with a stderr message when settings cannot be read", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
      h.configPath,
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the cycle digest header through main", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(cycleArgs(h));

    expect(out).toContain("# wiki-sync cycle digest");
  });

  it("prints the lint summary through main", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(cycleArgs(h));

    expect(out).toContain("## Lint summary");
  });

  it("announces the commit stage on stderr through main", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(cycleArgs(h));

    expect(err).toContain("wiki-sync: stage 5/5 — commit");
  });

  it("leaves the exit code unset for a successful cycle through main", async () => {
    const h = await makeCliHarness();
    await runCli(cycleArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("prints nothing to do for a second run with no changes", async () => {
    const h = await makeCliHarness();

    await runCli(cycleArgs(h));

    const { out } = await runCli(cycleArgs(h));

    expect(out).toContain("nothing to do");
  });

  it("leaves the exit code unset for a nothing-to-do run", async () => {
    const h = await makeCliHarness();

    await runCli(cycleArgs(h));
    await runCli(cycleArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("names the invalid zero timeout in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout", "0"]);

    expect(err).toContain("--timeout needs a positive integer");
  });

  it("rejects a zero timeout with exit 1", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "--timeout", "0"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the trailing-junk timeout in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout", "5x"]);

    expect(err).toContain("--timeout needs a positive integer");
  });

  it("rejects a timeout with trailing junk with exit 1", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "--timeout", "5x"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --timeout value in the error", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cycleArgs(h), "--timeout"]);

    expect(err).toContain("--timeout needs a positive integer");
  });

  it("rejects --timeout without a value with exit 1", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "--timeout"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the cycle digest under a tight timeout budget", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([...cycleArgs(h), "--timeout", "30"]);

    expect(out).toContain("# wiki-sync cycle digest");
  });

  it("completes the cycle under a tight timeout budget", async () => {
    const h = await makeCliHarness();
    await runCli([...cycleArgs(h), "--timeout", "30"]);

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

  it("names the agent exit code in the error when a stage fails through main", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(stub, "#!/usr/bin/env node\nprocess.exit(4);\n", {
      mode: 0o755,
    });

    const { err } = await runCli(cycleArgs(h));

    expect(err).toContain("code 4");
  });

  it("exits 1 when a stage fails through main", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(stub, "#!/usr/bin/env node\nprocess.exit(4);\n", {
      mode: 0o755,
    });

    await runCli(cycleArgs(h));

    expect(process.exitCode).toBe(1);
  });

  it("kills the agent with a timeout error when --timeout expires", async () => {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      '#!/usr/bin/env node\nimport { existsSync } from "node:fs";\nif (!existsSync(process.cwd() + "/.cli-test-repo")) process.exit(5);\nawait new Promise((resolve) => setTimeout(resolve, 2500));\nconsole.log("slow agent done");\n',
      { mode: 0o755 },
    );

    const { err } = await runCli([...cycleArgs(h), "--timeout", "1"]);

    expect(err).toContain("timed out after 1 second");
  });

  it("exits 1 when --timeout expires", async () => {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      '#!/usr/bin/env node\nimport { existsSync } from "node:fs";\nif (!existsSync(process.cwd() + "/.cli-test-repo")) process.exit(5);\nawait new Promise((resolve) => setTimeout(resolve, 2500));\nconsole.log("slow agent done");\n',
      { mode: 0o755 },
    );

    await runCli([...cycleArgs(h), "--timeout", "1"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the unread settings file in the error when the config argument is omitted", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
    ]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("exits 1 when the config argument is omitted and settings cannot be read", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("names the inaccessible vault root in the error before failing", async () => {
    const h = await makeHarness({});
    const { err } = await runCli([h.configPath, join(h.dataRoot, "raw")]);

    expect(err).toContain('vault root for "Engineering" is not accessible');
  });

  it("exits 1 at an inaccessible vault after reading the repo's default settings", async () => {
    const h = await makeHarness({});
    await runCli([h.configPath, join(h.dataRoot, "raw")]);

    expect(process.exitCode).toBe(1);
  });

  it("writes the run digest under the --outputs directory", async () => {
    const h = await makeCliHarness();

    await runCli(cycleArgs(h));

    expect((await readdir(join(h.outputsDir, "runs"))).length).toBeGreaterThan(
      0,
    );
  });

  it("prints the cycle digest when --outputs is omitted", async () => {
    const h = await makeCliHarness();

    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      h.configPath,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("# wiki-sync cycle digest");
  });

  it("defaults the digest directory to the repo outputs when --outputs is omitted", async () => {
    const h = await makeCliHarness();
    const runsDir = join(
      fileURLToPath(new URL("../..", import.meta.url)),
      "outputs",
      "runs",
    );
    const before = await readdir(runsDir).catch(() => [] as string[]);

    await runCli([
      "--settings",
      h.settingsPath,
      h.configPath,
      join(h.dataRoot, "raw"),
    ]);

    expect((await readdir(runsDir)).length).toBeGreaterThan(before.length);
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
      "wiki-sync: stage 1/5 — sync-vault",
      "wiki-sync: stage 2/5 — wiki-ingest",
      "wiki-sync: stage 3/5 — lint",
      "wiki-sync: lint — invoking agent:",
      "wiki-sync: lint — agent finished",
      "wiki-sync: lint — guardrails passed",
      "wiki-sync: stage 4/5 — verification",
      "wiki-sync: stage 5/5 — commit",
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

  it("passes one --skill/-e flag per whitelisted entry to the lint agent (issue #144)", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const skillDir = join(
      dirname(h.settingsPath),
      "skills",
      "obsidian-markdown",
    );

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n");
    await mkdir(join(dirname(h.settingsPath), "exts"), { recursive: true });
    await writeFile(
      join(dirname(h.settingsPath), "exts", "web-access.ts"),
      "export {};\n",
    );
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [skills/obsidian-markdown]\nisolate.extensions: [exts/web-access.ts]\n`,
    );

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs.slice(0, 7)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--skill",
      skillDir,
      "-e",
      join(dirname(h.settingsPath), "exts", "web-access.ts"),
    ]);
  });

  it("warns and omits an absent whitelist entry before the lint run (issue #144)", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [skills/absent]\n`,
    );
    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(progress.join("\n")).toContain(
      `WARNING — isolate.skills entry "${join(dirname(h.settingsPath), "skills", "absent")}" not found; omitted`,
    );

    for (const args of h.argRecords) {
      expect(args).not.toContain("--skill");
    }
  });

  it("records the whitelist state on the lint invoking-agent progress line (issue #144)", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const skillDir = join(
      dirname(h.settingsPath),
      "skills",
      "obsidian-markdown",
    );
    const progress: string[] = [];

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n");
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [skills/obsidian-markdown]\n`,
    );
    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(progress.join("\n")).toContain(
      "wiki-sync: lint — invoking agent: pi --model GLM-5.2 --thinking high (isolated +1 skill)",
    );
  });

  it("passes the --provider flag to the lint agent when the setting is present", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs).toContain("--provider");
  });

  it("passes the provider value to the lint agent when the setting is present", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs[lintArgs.indexOf("--provider") + 1]).toBe("zai");
  });

  it("passes the --model flag to the lint agent", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs).toContain("--model");
  });

  it("passes the model value to the lint agent", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs).toContain("GLM-5.2");
  });

  it("passes the --thinking flag to the lint agent", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

    expect(lintArgs).toContain("--thinking");
  });

  it("passes the reasoning value to the lint agent", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await runWikiSync(optionsFor(h));

    const lintArgs = h.argRecords[1] ?? [];

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
  /** A lint agent that writes one frontmatter-free page, tripping
   *  guardrail check 2. */
  function rogueLintAgent(): AgentRunner {
    return async (_command, _args, options) => {
      await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "concepts", "broken.md"),
        "no frontmatter\n",
      );

      return { stdout: "rogue lint", stderr: "" };
    };
  }

  it("rejects with an Error when a lint guardrail trips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = rogueLintAgent();

    const error = await runWikiSync(optionsFor(h)).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("names the check, revert target, and problems in the lint guardrail error", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = rogueLintAgent();

    const error = (await runWikiSync(optionsFor(h)).then(
      () => undefined,
      (cause: unknown) => cause,
    )) as Error;

    expect(error.message).toMatch(
      /^lint guardrail check 2 \(frontmatter\) failed; reverted to [0-9a-f]{8} — wiki\/concepts\/broken\.md: no frontmatter block$/,
    );
  });

  it("carries no agent cause when the lint guardrail trips", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    h.lintAgent = rogueLintAgent();

    const error = (await runWikiSync(optionsFor(h)).then(
      () => undefined,
      (cause: unknown) => cause,
    )) as Error;

    expect(error.cause).toBeUndefined();
  });

  it("announces the tripped lint guardrail on the progress line", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    h.lintAgent = rogueLintAgent();

    await expect(
      runWikiSync({
        ...optionsFor(h),
        onProgress: (message) => progress.push(message),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

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
  /** The paths the HEAD commit touched. */
  async function committedNames(dataRoot: string): Promise<string[]> {
    const { stdout } = await runGit(
      dataRoot,
      ["show", "--name-only", "--pretty=format:", "HEAD"],
      process.env,
    );

    return stdout.split("\n").filter(Boolean);
  }

  it("commits a full 40-char commit hash", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stray = join(h.dataRoot, "stray.txt");

    await writeFile(stray, "stray\n");

    const result = await runWikiSync(optionsFor(h));

    if (result.commit.status !== "committed") {
      throw new Error("expected a committed cycle");
    }

    expect(result.commit.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("commits the lint report in the cycle commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stray = join(h.dataRoot, "stray.txt");

    await writeFile(stray, "stray\n");

    await runWikiSync(optionsFor(h));

    const names = await committedNames(h.dataRoot);

    expect(names).toContain("outputs/lint-2026-08-20.md");
  });

  it("commits the ingest page in the cycle commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stray = join(h.dataRoot, "stray.txt");

    await writeFile(stray, "stray\n");

    await runWikiSync(optionsFor(h));

    const names = await committedNames(h.dataRoot);

    expect(names).toContain("wiki/concepts/new.md");
  });

  it("commits the synced raw note in the cycle commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stray = join(h.dataRoot, "stray.txt");

    await writeFile(stray, "stray\n");

    await runWikiSync(optionsFor(h));

    const names = await committedNames(h.dataRoot);

    expect(names).toContain("raw/notes/Engineering/AI/RAG.md");
  });

  it("leaves stray files out of the cycle commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const stray = join(h.dataRoot, "stray.txt");

    await writeFile(stray, "stray\n");

    await runWikiSync(optionsFor(h));

    const names = await committedNames(h.dataRoot);

    expect(names).not.toContain("stray.txt");
  });

  it("leaves files staged outside the cycle pathspecs out of the commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(join(h.dataRoot, "hand-notes.md"), "hand notes\n");
    await runGit(h.dataRoot, ["add", "hand-notes.md"], process.env);

    await runWikiSync(optionsFor(h));

    const names = await committedNames(h.dataRoot);

    expect(names).not.toContain("hand-notes.md");
  });

  it("keeps hand-staged files staged after the cycle commit", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });

    await writeFile(join(h.dataRoot, "hand-notes.md"), "hand notes\n");
    await runGit(h.dataRoot, ["add", "hand-notes.md"], process.env);

    await runWikiSync(optionsFor(h));

    const { stdout: status } = await runGit(
      h.dataRoot,
      ["status", "--porcelain"],
      process.env,
    );

    expect(status).toContain("A  hand-notes.md");
  });

  it("summarizes the removed source in the next cycle's subject line", async () => {
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
  });

  it("counts the removed source in the commit message source summary", async () => {
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

    expect(result.commit.message).toContain(
      "- sources: 0 added, 0 changed, 1 removed",
    );
  });

  it("digests the removed source count", async () => {
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

    expect(result.commit.message).toMatch(
      /- sources: 0 copied, 0 removed by sync \(no ingest\)[\s\S]*- pages: 0 created, 1 updated/,
    );
  });

  it("announces the skipped lint stage on a no-ingest cycle", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];

    await runWikiSync(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "wiki", "index.md"),
      wikiPage("# Index hand-edited"),
    );

    await runWikiSync({
      ...optionsFor(h),
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContain(
      "wiki-sync: stage 3/5 — lint skipped (no ingest ran)",
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
      verification: {
        fidelity: { problems: [], quotes: 3, titles: 2, skipped: 0, pages: 4 },
        provenance: {
          problems: [],
          sources: 5,
          origins: 1,
          missingOrigins: 0,
          pages: 4,
        },
      },
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

  it("aggregates copied and removed counts across multiple vaults", () => {
    const digest = formatFinalDigest({
      ...ranResult({}),
      sync: {
        vaults: [
          {
            vault: "Engineering",
            candidates: 2,
            selected: 2,
            copied: ["a1.md", "a2.md"],
            unchanged: [],
            removed: [],
          },
          {
            vault: "Research",
            candidates: 1,
            selected: 1,
            copied: [],
            unchanged: [],
            removed: ["b1.md"],
          },
        ],
        prunedNamespaces: [],
      },
    });

    expect(digest).toContain("2 sources copied, 1 source removed");
  });

  it("states plainly when the cycle ended with nothing to commit", () => {
    const digest = formatFinalDigest(
      ranResult({
        commit: { status: "nothing-to-commit" },
      }),
    );

    expect(digest).toContain("- **Commit:** nothing to commit");
  });

  it("never interpolates undefined into a nothing-to-commit digest", () => {
    const digest = formatFinalDigest(
      ranResult({
        commit: { status: "nothing-to-commit" },
      }),
    );

    expect(digest).not.toContain("undefined");
  });

  it("separates the lint heading from its body with a blank line", () => {
    const digest = formatFinalDigest(
      ranResult({ lintSummary: "padded summary" }),
    );

    expect(digest).toContain("## Lint summary\n\npadded summary");
  });

  it("separates the ingest digest heading from its body with a blank line", () => {
    const digest = formatFinalDigest(ranResult({}));

    expect(digest).toContain("## Ingest digest\n\ningest digest body");
  });

  it("keeps the leading whitespace of the ingest digest body", () => {
    const base = ranResult({});

    base.ingest.digest = "  indented digest body\n";

    expect(formatFinalDigest(base)).toContain(
      "## Ingest digest\n\n  indented digest body",
    );
  });

  it("reports the ingest mode under the Ingest line for a run", () => {
    const digest = formatFinalDigest(ranResult({}));

    expect(digest).toContain("- **Ingest:** incremental — digest below");
  });

  it("states the skip reason under the Ingest line when no ingest ran", () => {
    const base = ranResult({});

    base.ingest = {
      status: "skipped",
      reason: "no source changes",
    };

    expect(formatFinalDigest(base)).toContain(
      "- **Ingest:** skipped — no source changes",
    );
  });

  it("states the lint skip when no ingest ran", () => {
    const base = ranResult({});

    base.ingest = { status: "skipped", reason: "no source changes" };
    base.lint = undefined;

    expect(formatFinalDigest(base)).toContain(
      "- **Lint:** skipped — no ingest ran",
    );
  });

  it("embeds the lint summary under the Lint summary heading", () => {
    const digest = formatFinalDigest(
      ranResult({ lintSummary: "  padded summary  \n" }),
    );

    expect(digest).toContain("## Lint summary");
  });

  it("trims the trailing whitespace of the lint summary it embeds", () => {
    const digest = formatFinalDigest(
      ranResult({ lintSummary: "  padded summary  \n" }),
    );

    expect(digest).not.toContain("padded summary  ");
  });

  it("separates the lint summary from the ingest digest", () => {
    const digest = formatFinalDigest(
      ranResult({ lintSummary: "  padded summary  \n" }),
    );

    expect(digest).toContain("## Ingest digest");
  });

  it("keeps the ingest digest body beside the lint summary", () => {
    const digest = formatFinalDigest(
      ranResult({ lintSummary: "  padded summary  \n" }),
    );

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

  it("uses the singular wording for one token, title, and page in the fidelity line", () => {
    const base = ranResult({});
    const digest = formatFinalDigest({
      ...base,
      verification: {
        fidelity: { problems: [], quotes: 1, titles: 1, skipped: 0, pages: 1 },
        provenance: {
          problems: [],
          sources: 1,
          origins: 1,
          missingOrigins: 0,
          pages: 1,
        },
      },
    });

    expect(digest).toContain(
      "- **Fidelity:** ok — 1 token traces to origins, 1 title matches across 1 page\n",
    );
  });

  it("uses the singular wording for one link, origin, and page in the provenance line", () => {
    const base = ranResult({});
    const digest = formatFinalDigest({
      ...base,
      verification: {
        fidelity: { problems: [], quotes: 1, titles: 1, skipped: 0, pages: 1 },
        provenance: {
          problems: [],
          sources: 1,
          origins: 1,
          missingOrigins: 0,
          pages: 1,
        },
      },
    });

    expect(digest).toContain(
      "- **Provenance:** ok — 1 source link resolves, 1 origin exists across 1 page\n",
    );
  });

  it("uses the plural wording for several tokens and titles in the fidelity line", () => {
    const digest = formatFinalDigest(ranResult({}));

    expect(digest).toContain(
      "- **Fidelity:** ok — 3 tokens trace to origins, 2 titles match across 4 pages\n",
    );
  });

  it("uses the plural wording for several links and pages in the provenance line", () => {
    const digest = formatFinalDigest(ranResult({}));

    expect(digest).toContain(
      "- **Provenance:** ok — 5 source links resolve, 1 origin exists across 4 pages\n",
    );
  });
});

describe("runWikiSync environment passthrough", () => {
  it("passes the caller's env to the agent invocation", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    let agentEnv: NodeJS.ProcessEnv | undefined;

    h.ingestAgent = async (_command, _args, options) => {
      agentEnv = options.env;

      return { stdout: "ingest report", stderr: "" };
    };

    await runWikiSync({
      ...optionsFor(h),
      env: { ...optionsFor(h).env, K_WIKI_TEST_ENV_SENTINEL: "sentinel" },
    });

    expect(agentEnv?.K_WIKI_TEST_ENV_SENTINEL).toBe("sentinel");
  });
});

describe("runLintStage heartbeat clock", () => {
  it("reports the elapsed time since the lint run started in the heartbeat", async () => {
    const h = await makeHarness({ "AI/RAG.md": "rag body" });
    const progress: string[] = [];
    let clock = NOW().getTime();

    await runLintStage({
      settingsPath: h.settingsPath,
      rawDir: join(h.dataRoot, "raw"),
      promptsDir: h.promptsDir,
      env: optionsFor(h).env,
      heartbeatMs: 1,
      now: () => new Date(clock),
      runAgent: async () => {
        clock += 60_000;
        await new Promise((resolve) => setTimeout(resolve, 20));

        return { stdout: "lint done", stderr: "" };
      },
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContainEqual(
      "wiki-sync: lint agent still running (1m00s)",
    );
  });
});
