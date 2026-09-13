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
 * empty-window skip.
 */

const run = promisify(execFile);
const NOW = () => new Date("2026-09-12T12:00:00.000Z");
const SETTINGS_YML = "command: pi\nmodel: GLM-5.2\nreasoning: high\n";

const LINT_PROMPT =
  "AUDIT THE WIKI PROMPT (full)\n\nSave the report to `outputs/lint-<YYYY-MM-DD>.md`.\n";
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
  const reportPath = /outputs\/lint-\d{4}-\d{2}-\d{2}\.md/.exec(prompt)?.[0];

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
    "outputs/lint-window.json\noutputs/last-ingested-manifest.json\n",
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

describe("runLintStage mode selection", () => {
  it("audits the full wiki when no snapshot exists (first run)", async () => {
    const h = await makeHarness(BASE_PAGES);

    const result = await runLintStage(optionsFor(h));

    expect(result.mode).toBe("full");
    expect(result.windowPages).toBeUndefined();
    expect(h.prompts[0]).toContain("AUDIT THE WIKI PROMPT (full)");
  });

  it("audits the window when a snapshot exists", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));
    h.prompts.length = 0;

    // Change one page; its reverse-link neighbor (src links to
    // concept) joins the window.
    await writeFile(
      join(h.wikiDir, "concepts", "concept.md"),
      `${CONCEPT}edited\n`,
      "utf8",
    );

    const result = await runLintStage(optionsFor(h));

    expect(result.mode).toBe("window");
    expect(result.windowPages).toEqual([
      "concepts/concept.md",
      "index.md",
      "sources/src.md",
    ]);
    expect(h.prompts[0]).toContain("AUDIT THE WINDOW PROMPT");
    expect(h.prompts[0]).toContain("- wiki/concepts/concept.md");
    expect(h.prompts[0]).toContain("- wiki/index.md");
    expect(h.prompts[0]).toContain("- wiki/sources/src.md");
    expect(h.prompts[0]).not.toContain("AUDIT THE WIKI PROMPT (full)");
  });

  it("forces the full audit with the full option", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));
    h.prompts.length = 0;

    const result = await runLintStage({ ...optionsFor(h), full: true });

    expect(result.mode).toBe("full");
    expect(h.prompts[0]).toContain("AUDIT THE WIKI PROMPT (full)");
  });
});

describe("runLintStage snapshot semantics", () => {
  it("writes the snapshot after a successful audit", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    const snapshot = JSON.parse(
      await readFile(lintWindowPath(h.dataRoot), "utf8"),
    );

    expect(snapshot.snapshotFor).toBe(h.dataRoot);
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

    await expect(runLintStage(optionsFor(h))).rejects.toThrow(
      "lint agent exploded",
    );

    expect(await readFile(lintWindowPath(h.dataRoot), "utf8")).toBe(before);
  });

  it("re-audits a timed-out run's partial edits through their hashes", async () => {
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

    // The next run's window must include the partially-edited page.
    h.agent = lintStub;

    const result = await runLintStage(optionsFor(h));

    expect(result.mode).toBe("window");
    expect(result.windowPages).toContain("concepts/concept.md");
  });
});

describe("runLintStage empty window", () => {
  it("skips the agent when nothing changed since the snapshot", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));
    h.prompts.length = 0;

    const result = await runLintStage(optionsFor(h));

    expect(result.skipped).toBe("empty-window");
    expect(result.reportWritten).toBe(false);
    expect(h.prompts).toEqual([]);
  });
});

describe("runLintStage worklists", () => {
  it("embeds the deterministic worklists in the prompt", async () => {
    const h = await makeHarness(BASE_PAGES);

    await runLintStage(optionsFor(h));

    expect(h.prompts[0]).toContain("Deterministic worklists");
    expect(h.prompts[0]).toContain("### Orphan candidates (");
    expect(h.prompts[0]).toContain("### Tag inventory (");
  });

  it("scopes the worklists to the window on a windowed audit", async () => {
    const h = await makeHarness(BASE_PAGES);

    // The full audit's tag inventory lists every tagged page.
    await runLintStage(optionsFor(h));
    expect(h.prompts[0]).toMatch(/- index\.md — nav/);
    expect(h.prompts[0]).toMatch(/- sources\/src\.md — source/);

    // Edit the source page: its window is itself plus its linkers
    // (concept, through its `sources` citation) — index.md stays out,
    // so its tag entry must not appear in the windowed worklists.
    h.prompts.length = 0;
    await writeFile(
      join(h.wikiDir, "sources", "src.md"),
      `${SOURCE}edited\n`,
      "utf8",
    );

    const result = await runLintStage(optionsFor(h));

    expect(result.windowPages).toEqual([
      "concepts/concept.md",
      "sources/src.md",
    ]);
    expect(h.prompts[0]).toMatch(/- concepts\/concept\.md — llm/);
    expect(h.prompts[0]).not.toMatch(/- index\.md — nav/);
  });
});

describe("runLintStage pre-run capture", () => {
  it("captures its own pre-run state when the caller passes none", async () => {
    const h = await makeHarness(BASE_PAGES);
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
