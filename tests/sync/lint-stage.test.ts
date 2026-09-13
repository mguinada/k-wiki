import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import type { AgentRunner } from "../../src/ingest/agent-run.ts";
import { runLintStage } from "../../src/sync/lint-stage.ts";
import {
  lintWindowPath,
  writeLintWindowSnapshot,
} from "../../src/sync/lint-window.ts";

/**
 * The lint stage (issue #359): window/full mode selection, the
 * composed prompt (worklists + window list), the snapshot's
 * advance-on-success / untouched-on-failure semantics, and the
 * empty-window skip. One expectation per it block; facts that share
 * one setup share a harness built by their local helper.
 */

const run = promisify(execFile);
const NOW = () => new Date("2026-09-12T12:00:00.000Z");
const SETTINGS_YML = "command: pi\nmodel: GLM-5.2\nreasoning: high\n";

const LINT_PROMPT =
  "AUDIT THE WIKI PROMPT (full)\n\nSave the report to `outputs/lint-<YYYY-MM-DD>-full.md`.\n";
const LINT_WINDOW_PROMPT =
  "AUDIT THE WINDOW PROMPT\n\nSave the report to `outputs/lint-<YYYY-MM-DD>.md`.\n";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface StageHarness {
  readonly dataRoot: string;
  readonly wikiDir: string;
  readonly promptsDir: string;
  readonly settingsPath: string;
  readonly prompts: string[];
  get agent(): AgentRunner;
  set agent(next: AgentRunner);
}

/** The lint-stub default: record the prompt, write the report the
 *  prompt names. */
const lintStub: AgentRunner = async (_command, args, options) => {
  const prompt = args[args.indexOf("--print") + 1] ?? "";
  const reportPath = /outputs\/lint-\d{4}-\d{2}-\d{2}(-full)?\.md/.exec(
    prompt,
  )?.[0];

  if (reportPath !== undefined) {
    await mkdir(join(options.cwd, "outputs"), { recursive: true });
    await writeFile(join(options.cwd, reportPath), "# Lint report\n");
  }

  return { stdout: "lint done", stderr: "" };
};

async function makeHarness(
  pages: Record<string, string>,
): Promise<StageHarness> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-lint-stage-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const wikiDir = join(dataRoot, "wiki");
  const promptsDir = join(tmp, "prompts");
  const settingsPath = join(tmp, "settings.yml");

  await mkdir(wikiDir, { recursive: true });
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(
    join(dataRoot, ".gitignore"),
    "outputs/last-ingested-manifest.json\n",
  );

  for (const [file, body] of Object.entries(pages)) {
    await mkdir(join(wikiDir, file, ".."), { recursive: true });
    await writeFile(join(wikiDir, file), body, "utf8");
  }

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "lint.md"), LINT_PROMPT);
  await writeFile(join(promptsDir, "lint-window.md"), LINT_WINDOW_PROMPT);
  await writeFile(settingsPath, SETTINGS_YML);
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });

  const prompts: string[] = [];
  let agent: AgentRunner = lintStub;

  return {
    dataRoot,
    wikiDir,
    promptsDir,
    settingsPath,
    prompts,
    get agent() {
      return agent;
    },
    set agent(next: AgentRunner) {
      agent = next;
    },
  };
}

function optionsFor(h: StageHarness) {
  const runAgent: AgentRunner = async (command, args, options) => {
    const prompt = args[args.indexOf("--print") + 1] ?? "";

    h.prompts.push(prompt);

    return h.agent(command, args, options);
  };

  return {
    settingsPath: h.settingsPath,
    run: runContext({
      rawDir: join(h.dataRoot, "raw"),
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t" },
      now: NOW,
    }),
    promptsDir: h.promptsDir,
    runAgent,
  };
}

const CONCEPT = [
  "---",
  'title: "Concept"',
  "type: concept",
  "created: 2026-09-01",
  "updated: 2026-09-01",
  "tags:",
  "  - llm",
  "sources:",
  '  - "[[src]]"',
  "---",
  "",
].join("\n");

const SOURCE = [
  "---",
  'title: "Src"',
  "type: source",
  "created: 2026-09-01",
  "updated: 2026-09-01",
  "tags:",
  "  - source",
  "---",
  "",
  "Hub page. See [[concept]].",
  "",
].join("\n");

const INDEX = [
  "---",
  'title: "Index"',
  "type: topic",
  "created: 2026-09-01",
  "updated: 2026-09-01",
  "tags:",
  "  - nav",
  "---",
  "",
  "# Index",
  "",
  "- [[concept]]",
  "",
].join("\n");

const BASE_PAGES = {
  "index.md": INDEX,
  "sources/src.md": SOURCE,
  "concepts/concept.md": CONCEPT,
};

/** Advance the harness past a first successful audit: the snapshot
 *  exists and the recorded prompts are cleared for the run under
 *  test. */
async function audited(h: StageHarness): Promise<void> {
  await runLintStage(optionsFor(h));
  h.prompts.length = 0;
}

describe("runLintStage mode selection (first run)", () => {
  it("reports the full-audit mode when no snapshot exists", async () => {
    const h = await makeHarness(BASE_PAGES);
    const result = await runLintStage(optionsFor(h));

    expect(result.mode).toBe("full");
  });

  it("leaves the window page list undefined on the full audit", async () => {
    const h = await makeHarness(BASE_PAGES);
    const result = await runLintStage(optionsFor(h));

    expect(result.windowPages).toBeUndefined();
  });

  it("composes the full-audit prompt", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toContain("AUDIT THE WIKI PROMPT (full)");
  });
});

describe("runLintStage mode selection (snapshot present)", () => {
  async function editedWindowHarness(): Promise<StageHarness> {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    // Change one page; its reverse-link neighbor (src links to
    // concept) and the index (it links to concept) join the window.
    await writeFile(
      join(h.wikiDir, "concepts", "concept.md"),
      `${CONCEPT}edited\n`,
      "utf8",
    );

    return h;
  }

  it("reports the windowed mode", async () => {
    const h = await editedWindowHarness();
    const result = await runLintStage(optionsFor(h));

    expect(result.mode).toBe("window");
  });

  it("lists the changed page and its reverse-link neighbors", async () => {
    const h = await editedWindowHarness();
    const result = await runLintStage(optionsFor(h));

    expect(result.windowPages).toEqual([
      "concepts/concept.md",
      "index.md",
      "sources/src.md",
    ]);
  });

  it("composes the windowed prompt", async () => {
    const h = await editedWindowHarness();

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toContain("AUDIT THE WINDOW PROMPT");
  });

  it("names every window page in the prompt's page list", async () => {
    const h = await editedWindowHarness();
    const result = await runLintStage(optionsFor(h));
    const prompt = h.prompts[0] ?? "";
    const named = (result.windowPages ?? []).map((page) => `- wiki/${page}`);
    const missing = named.filter((line) => !prompt.includes(line));

    expect(missing).toEqual([]);
  });

  it("uses the windowed prompt, never the full-audit prompt", async () => {
    const h = await editedWindowHarness();

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).not.toContain("AUDIT THE WIKI PROMPT (full)");
  });
});

describe("runLintStage full option", () => {
  it("reports the full-audit mode whatever the snapshot says", async () => {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    const result = await runLintStage({ ...optionsFor(h), full: true });

    expect(result.mode).toBe("full");
  });

  it("composes the full-audit prompt with the full option", async () => {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    await runLintStage({ ...optionsFor(h), full: true });

    expect(h.prompts[0]).toContain("AUDIT THE WIKI PROMPT (full)");
  });
});

describe("runLintStage snapshot semantics", () => {
  it("stamps the snapshot with the data root after a successful audit", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    const snapshot = JSON.parse(
      await readFile(lintWindowPath(h.dataRoot), "utf8"),
    );

    expect(snapshot.snapshotFor).toBe(h.dataRoot);
  });

  it("records every page's hash in the snapshot", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    const snapshot = JSON.parse(
      await readFile(lintWindowPath(h.dataRoot), "utf8"),
    );

    expect(Object.keys(snapshot.pages).sort()).toEqual([
      "concepts/concept.md",
      "index.md",
      "sources/src.md",
    ]);
  });

  it("leaves the snapshot untouched when the agent fails", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    const before = await readFile(lintWindowPath(h.dataRoot), "utf8");

    h.agent = async () => {
      throw new Error("lint agent exploded");
    };
    await writeFile(
      join(h.wikiDir, "concepts", "concept.md"),
      `${CONCEPT}edited\n`,
      "utf8",
    );

    await runLintStage(optionsFor(h)).catch(() => {});

    expect(await readFile(lintWindowPath(h.dataRoot), "utf8")).toBe(before);
  });

  it("fails a run whose agent errors after its guardrails passed", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    // A timed-out lint left a guardrail-passed edit behind.
    await writeFile(
      join(h.wikiDir, "concepts", "concept.md"),
      `${CONCEPT}partial lint edit\n`,
      "utf8",
    );

    h.agent = async () => {
      throw new Error("timeout");
    };

    await expect(runLintStage(optionsFor(h))).rejects.toThrow("timeout");
  });

  it("re-enters a timed-out run's partial edits into the next window", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    await writeFile(
      join(h.wikiDir, "concepts", "concept.md"),
      `${CONCEPT}partial lint edit\n`,
      "utf8",
    );

    h.agent = async () => {
      throw new Error("timeout");
    };

    await runLintStage(optionsFor(h)).catch(() => {});

    h.agent = lintStub;

    const result = await runLintStage(optionsFor(h));

    expect(result.windowPages).toContain("concepts/concept.md");
  });
});

describe("runLintStage empty window", () => {
  it("skips the agent when nothing changed since the snapshot", async () => {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    const result = await runLintStage(optionsFor(h));

    expect(result.skipped).toBe("empty-window");
  });

  it("writes no report on the empty-window skip", async () => {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    const result = await runLintStage(optionsFor(h));

    expect(result.reportWritten).toBe(false);
  });

  it("invokes no agent on the empty-window skip", async () => {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    await runLintStage(optionsFor(h));

    expect(h.prompts).toEqual([]);
  });
});

describe("runLintStage worklists", () => {
  it("embeds the deterministic worklists in the prompt", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toContain("Deterministic worklists");
  });

  it("carries the orphan section in the prompt", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toContain("### Orphan candidates (");
  });

  it("carries the tag-inventory section in the prompt", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toContain("### Tag inventory (");
  });
});

describe("runLintStage windowed worklists", () => {
  async function sourceEditedHarness(): Promise<StageHarness> {
    const h = await makeHarness(BASE_PAGES);

    await audited(h);

    // Edit the source page: its window is itself plus its linkers
    // (concept, through its `sources` citation) — index.md stays out,
    // so its tag entry must not appear in the windowed worklists.
    await writeFile(
      join(h.wikiDir, "sources", "src.md"),
      `${SOURCE}edited\n`,
      "utf8",
    );

    return h;
  }

  it("lists the window's scope as changed source plus its linker", async () => {
    const h = await sourceEditedHarness();
    const result = await runLintStage(optionsFor(h));

    expect(result.windowPages).toEqual([
      "concepts/concept.md",
      "sources/src.md",
    ]);
  });

  it("carries a window page's tag entry in the windowed worklists", async () => {
    const h = await sourceEditedHarness();

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toMatch(/- concepts\/concept\.md — llm/);
  });

  it("drops out-of-window pages' tag entries from the worklists", async () => {
    const h = await sourceEditedHarness();

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).not.toMatch(/- index\.md — nav/);
  });

  it("carries the full audit's whole tag inventory", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    const tagged = ["- index.md — nav", "- sources/src.md — source"];
    const prompt = h.prompts[0] ?? "";
    const missing = tagged.filter((line) => !prompt.includes(line));

    expect(missing).toEqual([]);
  });
});

describe("runLintStage pre-run capture", () => {
  it("captures its own pre-run state when the caller passes none", async () => {
    const h = await makeHarness(BASE_PAGES);
    const saboteur: AgentRunner = async (_command, args, options) => {
      const prompt = args[args.indexOf("--print") + 1] ?? "";
      const reportPath = /outputs\/lint-\d{4}-\d{2}-\d{2}(-full)?\.md/.exec(
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
      runLintStage({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow(/lint guardrail check 2 \(frontmatter\)/);
  });
});

describe("writeLintWindowSnapshot foreign-stamp fallback", () => {
  it("warns and audits fully against a foreign snapshot", async () => {
    const h = await makeHarness(BASE_PAGES);

    await writeLintWindowSnapshot(
      h.wikiDir,
      lintWindowPath(h.dataRoot),
      "/other",
    );

    const result = await runLintStage(optionsFor(h));

    expect(result.mode).toBe("full");
  });
});
