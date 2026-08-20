import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../src/data/init-data-repo.ts";
import {
  type AgentRunner,
  type AgentSettings,
  composePrompt,
  createAgentProgressSink,
  diffManifests,
  formatDigest,
  type IngestRun,
  loadAgentSettings,
  main,
  parseSettings,
  runWikiIngest,
  spawnAgent,
} from "../src/ingest/wiki-ingest.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  serializeManifest,
  type VaultNotes,
} from "../src/sync/manifest.ts";

const SETTINGS_YML = `# Agent configuration (issue #11).
command: pi
model: GLM-5.2 # trailing comment
reasoning: "high"
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

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function manifestWith(vault: string, notes: VaultNotes): Manifest {
  return { vaults: { [vault]: notes } };
}

function entry(content: string) {
  return { hash: hashOf(content), last_synced: "2026-08-20T00:00:00.000Z" };
}

describe("parseSettings", () => {
  it("parses the command, model, and reasoning scalars", () => {
    expect(parseSettings(SETTINGS_YML, "settings.yml")).toEqual({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
    });
  });

  it("unquotes single-quoted values", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: 'high'\n",
      "s",
    );

    expect(settings.reasoning).toBe("high");
  });

  it("accepts an indented comment line", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n  # indented note\n",
      "s",
    );

    expect(settings.model).toBe("m");
  });

  it("accepts a whitespace-only line", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n   \n",
      "s",
    );

    expect(settings.command).toBe("pi");
  });

  it("accepts a space between key and colon", () => {
    const settings = parseSettings(
      "command : pi\nmodel: m\nreasoning: h\n",
      "s",
    );

    expect(settings.command).toBe("pi");
  });

  it("rejects an unknown key", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: high\nextra: x\n", "s"),
    ).toThrow('invalid agent settings at s: unknown setting "extra"');
  });

  it("reports a one-character key as unknown, not malformed", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: h\nx: v\n", "s"),
    ).toThrow('invalid agent settings at s: unknown setting "x"');
  });

  it("rejects a missing required key", () => {
    expect(() => parseSettings("command: pi\nreasoning: high\n", "s")).toThrow(
      'invalid agent settings at s: missing setting "model"',
    );
  });

  it("rejects a missing command key", () => {
    expect(() => parseSettings("model: m\nreasoning: h\n", "s")).toThrow(
      'missing setting "command"',
    );
  });

  it("rejects a missing reasoning key", () => {
    expect(() => parseSettings("command: pi\nmodel: m\n", "s")).toThrow(
      'missing setting "reasoning"',
    );
  });

  it("rejects an empty value", () => {
    expect(() =>
      parseSettings("command:\nmodel: m\nreasoning: h\n", "s"),
    ).toThrow('setting "command" needs a value');
  });

  it("rejects nested (indented) lines", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\n  nested: true\n",
        "s",
      ),
    ).toThrow("nested values are not supported");
  });

  it("rejects duplicate keys", () => {
    expect(() =>
      parseSettings("command: pi\ncommand: pi\nmodel: m\nreasoning: h\n", "s"),
    ).toThrow('duplicate setting "command"');
  });

  it("rejects a line without a colon separator", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: high\nbroken\n", "s"),
    ).toThrow("expected `key: value`");
  });

  it("names the settings file in every error", () => {
    expect(() => parseSettings("command: pi\n", "my-settings.yml")).toThrow(
      "my-settings.yml",
    );
  });
});

describe("diffManifests", () => {
  const previous = manifestWith("Engineering", {
    "a.md": entry("a"),
    "b.md": entry("b"),
    "c.md": entry("c"),
  });

  it("marks a path present only in current as added", () => {
    const current = manifestWith("Engineering", {
      "a.md": entry("a"),
      "b.md": entry("b"),
      "c.md": entry("c"),
      "d.md": entry("d"),
    });

    expect(diffManifests(previous, current).vaults[0]).toMatchObject({
      vault: "Engineering",
      added: ["d.md"],
    });
  });

  it("marks a changed hash as changed", () => {
    const current = manifestWith("Engineering", {
      "a.md": entry("a2"),
      "b.md": entry("b"),
      "c.md": entry("c"),
    });

    expect(diffManifests(previous, current).vaults[0]).toMatchObject({
      changed: ["a.md"],
    });
  });

  it("marks a path missing from current as removed", () => {
    const current = manifestWith("Engineering", {
      "a.md": entry("a"),
      "c.md": entry("c"),
    });

    expect(diffManifests(previous, current).vaults[0]).toMatchObject({
      removed: ["b.md"],
    });
  });

  it("reports an empty diff when nothing changed", () => {
    expect(diffManifests(previous, previous).empty).toBe(true);
  });

  it("treats a vault present only in current as fully added", () => {
    const diff = diffManifests(
      manifestWith("Engineering", { "a.md": entry("a") }),
      {
        vaults: {
          Engineering: { "a.md": entry("a") },
          Notes: { "n.md": entry("n") },
        },
      },
    );

    expect(diff.vaults).toHaveLength(1);
    expect(diff.vaults[0]).toMatchObject({
      vault: "Notes",
      added: ["n.md"],
      changed: [],
      removed: [],
    });
  });

  it("treats a vault present only in previous as fully removed", () => {
    const diff = diffManifests(
      { vaults: { Old: { "x.md": entry("x") } } },
      emptyManifest(),
    );

    expect(diff.vaults[0]).toMatchObject({
      vault: "Old",
      removed: ["x.md"],
    });
  });

  it("sorts the paths within each vault", () => {
    const current = manifestWith("Engineering", {
      "z.md": entry("z"),
      "a.md": entry("a"),
    });

    expect(diffManifests(emptyManifest(), current).vaults[0]?.added).toEqual([
      "a.md",
      "z.md",
    ]);
  });
});

describe("loadAgentSettings", () => {
  it("fails naming the file when it cannot be read", async () => {
    await expect(loadAgentSettings("/no/such/settings.yml")).rejects.toThrow(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });
});

describe("composePrompt", () => {
  const diff = diffManifests(
    manifestWith("Engineering", {
      "old.md": entry("old"),
      "gone.md": entry("gone"),
    }),
    manifestWith("Engineering", {
      "new.md": entry("new"),
      "old.md": entry("old2"),
    }),
  );

  it("returns the prompt text unchanged for a full ingest", () => {
    expect(composePrompt("PROMPT", undefined)).toBe("PROMPT");
  });

  it("appends the changed sources to the incremental prompt", () => {
    const composed = composePrompt("PROMPT", diff);

    expect(composed).toContain("Changed sources since the previous ingestion:");
    expect(composed).toContain("+ Engineering/new.md");
    expect(composed).toContain("~ Engineering/old.md");
    expect(composed).toContain("- Engineering/gone.md");
  });

  it("renders the exact incremental prompt format", () => {
    expect(composePrompt("PROMPT", diff)).toBe(
      [
        "PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "+ Engineering/new.md",
        "~ Engineering/old.md",
        "- Engineering/gone.md",
      ].join("\n"),
    );
  });
});

function digestRun(overrides: Partial<IngestRun> = {}): IngestRun {
  const settings: AgentSettings = {
    command: "pi",
    model: "GLM-5.2",
    reasoning: "high",
  };

  return {
    startedAt: new Date("2026-08-20T17:30:00.000Z"),
    mode: "incremental",
    promptFile: "prompts/incremental.md",
    settings,
    diff: diffManifests(
      manifestWith("Engineering", {
        "a.md": entry("a"),
        "b.md": entry("b"),
        "c.md": entry("c"),
      }),
      manifestWith("Engineering", {
        "a.md": entry("a2"),
        "b.md": entry("b"),
        "d.md": entry("d"),
      }),
    ),
    pages: {
      created: ["wiki/concepts/new.md"],
      updated: ["wiki/index.md", "wiki/log.md"],
      unavailable: undefined,
    },
    agentOutput: "AGENT REPORT",
    ...overrides,
  };
}

describe("formatDigest", () => {
  it("states the agent command, model, and reasoning level", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("`pi`");
    expect(digest).toContain("`GLM-5.2`");
    expect(digest).toContain("`high`");
  });

  it("opens with the digest heading and run timestamp", () => {
    expect(formatDigest(digestRun())).toContain(
      "# Wiki ingest digest — 2026-08-20T17:30:00.000Z",
    );
  });

  it("states the mode and the prompt file used", () => {
    const digest = formatDigest(
      digestRun({ mode: "full", promptFile: "prompts/ingest.md" }),
    );

    expect(digest).toContain("**Mode:** full");
    expect(digest).toContain("`prompts/ingest.md`");
  });

  it("counts sources added, changed, and removed", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("**Sources:** 1 added, 1 changed, 1 removed");
  });

  it("lists the changed source paths with vault names", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("**Engineering**");
    expect(digest).toContain("- + Engineering/d.md");
    expect(digest).toContain("~ Engineering/a.md");
    expect(digest).toContain("- − Engineering/c.md");
  });

  it("labels the created and updated page lists", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("## Changed sources");
    expect(digest).toContain("## Wiki pages (git diff)");
    expect(digest).toContain("Created:");
    expect(digest).toContain("Updated:");
  });

  it("carries the agent report under its own heading", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("## Agent report");
    expect(digest).toContain("AGENT REPORT");
  });

  it("counts and lists created and updated wiki pages", () => {
    const digest = formatDigest(digestRun());

    expect(digest).toContain("**Wiki pages:** 1 created, 2 updated");
    expect(digest).toContain("- wiki/concepts/new.md");
    expect(digest).toContain("- wiki/index.md");
  });

  it("embeds the agent report verbatim", () => {
    expect(formatDigest(digestRun())).toContain("AGENT REPORT");
  });

  it("points the reviewer at contradictions and unresolved questions", () => {
    expect(formatDigest(digestRun())).toContain("unresolved questions");
  });

  it("notes when the wiki git diff was unavailable", () => {
    const digest = formatDigest(
      digestRun({ pages: { created: [], updated: [], unavailable: "no git" } }),
    );

    expect(digest).toContain("**Wiki pages:** unavailable — no git");
    expect(digest).toContain("unavailable: no git");
  });

  it("changes the reported agent config when the model changes", () => {
    const other = formatDigest(
      digestRun({
        settings: { command: "pi", model: "OTHER-MODEL", reasoning: "high" },
      }),
    );

    expect(other).toContain("`OTHER-MODEL`");
    expect(other).not.toContain("`GLM-5.2`");
  });

  it("counts all sources as added on a full ingest without listing each", () => {
    const digest = formatDigest(
      digestRun({
        mode: "full",
        promptFile: "prompts/ingest.md",
        diff: diffManifests(
          emptyManifest(),
          manifestWith("Engineering", {
            "a.md": entry("a"),
            "b.md": entry("b"),
          }),
        ),
      }),
    );

    expect(digest).toContain("**Sources:** 2 added");
    expect(digest).not.toContain("- + Engineering/");
  });
});

const run = promisify(execFile);

/** A data repo: raw/ with a manifest, wiki/ with a page, committed to git. */
async function makeDataRepo(notes: VaultNotes): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-ingest-"));

  tempDirs.push(dataRoot);

  const manifest = manifestWith("Engineering", notes);

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    serializeManifest(manifest),
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "A-page.md"), "# A page\n");
  await writeFile(join(dataRoot, "wiki", "gone.md"), "# Gone\n");
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

  return dataRoot;
}

interface Harness {
  readonly dataRoot: string;
  readonly outputsDir: string;
  readonly promptsDir: string;
  readonly settingsPath: string;
  readonly invocations: {
    command: string;
    args: readonly string[];
    cwd: string;
  }[];
  runAgent: AgentRunner;
}

/** Fixture prompt files plus a recording, wiki-writing fake agent. */
async function makeHarness(notes: VaultNotes): Promise<Harness> {
  const dataRoot = await makeDataRepo(notes);
  const outputsDir = join(dataRoot, "outputs");
  const promptsDir = join(dataRoot, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "ingest.md"), "FULL PROMPT");
  await writeFile(join(promptsDir, "incremental.md"), "INCREMENTAL PROMPT");

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(settingsPath, SETTINGS_YML);

  const invocations: Harness["invocations"] = [];
  const runAgent: AgentRunner = async (command, args, options) => {
    invocations.push({ command, args, cwd: options.cwd });
    await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
    await writeFile(join(options.cwd, "wiki", "concepts", "new.md"), "New", {
      flag: "wx",
    }).catch(() => {});
    await writeFile(join(options.cwd, "wiki", "index.md"), "# Index v2\n");
    await writeFile(join(options.cwd, "wiki", "A-page.md"), "# A page v2\n");
    await rm(join(options.cwd, "wiki", "gone.md")).catch(() => {});

    return { stdout: "agent final report", stderr: "" };
  };

  return {
    dataRoot,
    outputsDir,
    promptsDir,
    settingsPath,
    invocations,
    runAgent,
  };
}

function optionsFor(h: Harness) {
  return {
    settingsPath: h.settingsPath,
    rawDir: join(h.dataRoot, "raw"),
    outputsDir: h.outputsDir,
    promptsDir: h.promptsDir,
    runAgent: h.runAgent,
    now: () => new Date("2026-08-20T18:00:00.000Z"),
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

describe("runWikiIngest", () => {
  it("uses the full ingest prompt when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    expect(invocation(h, 0).args.at(-1)).toBe("FULL PROMPT");
  });

  it("invokes the agent in the data repo root", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).cwd).toBe(h.dataRoot);
  });

  it("passes the model and reasoning level from settings as agent flags", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("GLM-5.2");
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
    expect(args).toContain("--print");
  });

  it("writes the manifest snapshot the next run diffs against", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await runWikiIngest(optionsFor(h));

    const snapshot = parseManifest(
      await (await import("node:fs/promises")).readFile(
        join(h.outputsDir, "last-ingested-manifest.json"),
        "utf8",
      ),
      "snapshot",
    );

    expect(snapshot.vaults.Engineering?.["a.md"]?.hash).toBe(hashOf("a"));
  });

  it("skips the agent when nothing changed since the snapshot", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const messages: string[] = [];
    const first = await runWikiIngest(optionsFor(h));
    const second = await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(first.status).toBe("ran");
    expect(second).toMatchObject({
      status: "skipped",
      reason: "no changed sources since the last ingest; nothing to do",
    });
    expect(messages).toContain(
      "no changed sources since the last ingest; nothing to do",
    );
    expect(h.invocations).toHaveLength(1);
  });

  it("skips the agent when the manifest holds no notes at all", async () => {
    const h = await makeHarness({});
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("skipped");
    expect(h.invocations).toHaveLength(0);
  });

  it("selects the incremental prompt and names the changed source", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
    expect(invocation(h, 1).args.at(-1)).toContain("Engineering/a.md");
  });

  it("names a removed source in the incremental prompt", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- Engineering/a.md");
  });

  it("derives created and updated wiki pages from git status", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages.created).toEqual(["wiki/concepts/new.md"]);
    expect(result.pages.updated).toEqual(["wiki/A-page.md", "wiki/index.md"]);
  });

  it("ignores wiki pages the run deleted", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages.created).not.toContain("wiki/gone.md");
    expect(result.pages.updated).not.toContain("wiki/gone.md");
  });

  it("writes the digest under outputs/runs with a sortable timestamp", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.digestPath).toBe(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
    );

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("**Mode:** full · prompt `prompts/ingest.md`");
    expect(digest).toContain("**Sources:** 1 added");
    expect(digest).toContain("wiki/concepts/new.md");
    expect(digest).toContain("agent final report");
  });

  it("reports unavailable wiki counts when the data repo has no git", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await rm(join(h.dataRoot, ".git"), { recursive: true });

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.pages).toEqual({
      created: [],
      updated: [],
      unavailable: expect.any(String),
    });
  });

  it("fails naming the prompt file when it is missing", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await rm(join(h.promptsDir, "ingest.md"));

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      "cannot read prompt",
    );
  });

  it("falls back to the wall clock for the digest timestamp", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const result = await runWikiIngest({
      settingsPath: h.settingsPath,
      rawDir: join(h.dataRoot, "raw"),
      outputsDir: h.outputsDir,
      promptsDir: h.promptsDir,
      runAgent: h.runAgent,
    });

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }

    expect(result.digestPath).toMatch(
      /\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/,
    );
  });

  it("reports each pipeline step on the progress sink", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      expect.stringContaining("wiki-ingest: raw dir"),
      expect.stringContaining(
        "invoking agent: pi --model GLM-5.2 --thinking high",
      ),
      "wiki-ingest: agent finished",
    ]);
  });

  it("emits a heartbeat while a slow agent run is in flight", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: slow,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual(
      expect.arrayContaining(["wiki-ingest: agent still running (0s)"]),
    );
  });

  it("formats the heartbeat clock as minutes and padded seconds", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const messages: string[] = [];
    const slow: AgentRunner = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ stdout: "R", stderr: "" }), 200_000),
      );

    vi.useFakeTimers();

    try {
      const run = runWikiIngest({
        ...optionsFor(h),
        runAgent: slow,
        heartbeatMs: 1000,
        onProgress: (message) => messages.push(message),
      });
      let settled = false;

      run.finally(() => {
        settled = true;
      });

      // Advance fake time in slices so real I/O (manifest reads, git)
      // keeps progressing between timer ticks.
      for (let tick = 0; !settled && tick < 500; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      await run;
    } finally {
      vi.useRealTimers();
    }

    expect(messages).toContain("wiki-ingest: agent still running (2m07s)");
  });

  it("stops the heartbeat when the agent run ends", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const messages: string[] = [];
    const fast: AgentRunner = async () => ({
      stdout: "fast report",
      stderr: "",
    });

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: fast,
      heartbeatMs: 40,
      onProgress: (message) => messages.push(message),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      messages.filter((message) => message.includes("still running")),
    ).toEqual([]);
  });

  it("enforces the timeout on the real agent runner", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
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
      await runWikiIngest({
        settingsPath: h.settingsPath,
        rawDir: join(h.dataRoot, "raw"),
        outputsDir: h.outputsDir,
        promptsDir: h.promptsDir,
        timeoutMs: 200,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 1 second$/);
  });

  it("fails with a sync hint when the raw dir has no manifest", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await rm(join(h.dataRoot, "raw", "manifest.json"));

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow("sync-vault");
  });

  it("reports an agent failure with its exit code", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1\nstderr tail");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow("code 1");
  });

  it("leaves no snapshot and no digest when the agent fails", async () => {
    const h = await makeHarness({ "a.md": entry("a") });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow();

    const { readFile } = await import("node:fs/promises");

    await expect(
      readFile(join(h.outputsDir, "last-ingested-manifest.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the snapshot untouched when the digest write fails", async () => {
    const h = await makeHarness({ "a.md": entry("a") });

    await mkdir(join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"), {
      recursive: true,
    });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow();

    const { readFile } = await import("node:fs/promises");

    await expect(
      readFile(join(h.outputsDir, "last-ingested-manifest.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("spawnAgent", () => {
  const noOptions = { cwd: tmpdir(), env: process.env };

  it("resolves the captured stdout of a successful child", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "console.log('agent says hi')"],
      noOptions,
    );

    expect(result.stdout).toContain("agent says hi");
  });

  it("rejects naming the exit code of a failing child", async () => {
    await expect(
      spawnAgent(process.execPath, ["-e", "process.exit(7)"], noOptions),
    ).rejects.toThrow("exited with code 7");
  });

  it("rejects when the command cannot start", async () => {
    await expect(
      spawnAgent("no-such-agent-command", [], noOptions),
    ).rejects.toThrow("could not start");
  });

  it("captures stderr of a successful child", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "console.error('noise')"],
      noOptions,
    );

    expect(result.stderr).toContain("noise");
  });

  it("drops the head of a long agent stderr, keeping the end", async () => {
    const filler = "y".repeat(1200);
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        [
          "-e",
          `console.error("HEAD-MARK ${filler} END-MARK"); process.exit(5)`,
        ],
        noOptions,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      `agent exited with code 5: ${"y".repeat(490)} END-MARK`,
    );
  });

  it("kills and fails an agent that exceeds its timeout", async () => {
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          ...noOptions,
          timeoutMs: 150,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 1 second$/);
  });

  it("reports a multi-second timeout in plural", async () => {
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          ...noOptions,
          timeoutMs: 1500,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 2 seconds$/);
  });

  it("kills and fails an agent that floods past the output cap", async () => {
    await expect(
      spawnAgent(
        process.execPath,
        ["-e", "process.stdout.write('z'.repeat(17 * 1024 * 1024))"],
        noOptions,
      ),
    ).rejects.toThrow("killed with SIGKILL");
  });

  it("collects output exactly at the cap without killing", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "process.stdout.write('z'.repeat(16 * 1024 * 1024))"],
      noOptions,
    );

    expect(result.stdout).toHaveLength(16 * 1024 * 1024);
  });

  it("closes the agent stdin instead of leaving an open pipe", async () => {
    const result = await spawnAgent(
      process.execPath,
      [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => console.log('stdin-eof')); process.stdin.on('data', () => {});",
      ],
      noOptions,
    );

    expect(result.stdout).toContain("stdin-eof");
  });
});

describe("createAgentProgressSink", () => {
  const dim = (text: string) => `<${text}>`;

  function makeSink(animated: boolean) {
    const written: string[] = [];
    const lines: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      (text) => lines.push(text),
      animated,
      dim,
    );

    return { sink, written, lines };
  }

  it("appends plain lines when not animated", () => {
    const { sink, written, lines } = makeSink(false);

    sink.render("wiki-ingest: agent finished");

    expect(written).toEqual([]);
    expect(lines).toEqual(["<wiki-ingest: agent finished>"]);
  });

  it("keeps heartbeat messages on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent still running (2m07s)");

    expect(written).toEqual(["\r⠋ <wiki-ingest: agent still running (2m07s)>"]);
  });

  it("scrolls non-heartbeat messages as events on the animated sink", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent finished");

    expect(written).toEqual(["<wiki-ingest: agent finished>\n"]);
  });

  it("clears the animated line on end", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent still running (0s)");
    sink.end();

    expect(written[1]).toMatch(/^\r\s+\r$/);
  });

  it("does nothing on end when not animated", () => {
    const { sink, written, lines } = makeSink(false);

    sink.end();

    expect(written).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("runGit reuse sanity", () => {
  it("reports git status for a wiki change in the temp data repo", async () => {
    const dataRoot = await makeDataRepo({ "a.md": entry("a") });

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");
    await mkdir(join(dataRoot, "wiki", "concepts"));
    await writeFile(join(dataRoot, "wiki", "concepts", "x.md"), "x");

    const { stdout } = await runGit(
      dataRoot,
      ["status", "--porcelain", "-uall", "--", "wiki"],
      process.env,
    );
    const lines = stdout.split("\n").filter(Boolean);

    expect(lines).toContain("?? wiki/concepts/x.md");
    expect(lines).toContain(" M wiki/index.md");
  });
});

describe("wiki-ingest CLI", () => {
  const STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const index = process.argv.indexOf("--print");
await writeFile(join(process.cwd(), "stub-prompt.txt"), process.argv[index + 1] ?? "");
await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "concepts", "stub.md"), "stub");
console.log("stub report");
`;

  /** A harness whose settings point at an executable stub agent. */
  async function makeCliHarness(): Promise<Harness> {
    const h = await makeHarness({ "a.md": entry("a") });
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

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the switches and defaults in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--settings");
    expect(out).toContain("--outputs");
    expect(out).toContain("<raw-dir>");
    expect(out).toContain("Default");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "/no/such/raw-dir"]);

    expect(out).toContain("Usage: wiki-ingest");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 with a stderr message when settings cannot be read", async () => {
    const { err } = await runCli(["--settings", "/no/such/settings.yml"]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
    expect(process.exitCode).toBe(1);
  });

  it("runs the stub agent end to end and prints the digest", async () => {
    const h = await makeCliHarness();
    const { out, err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
    expect(out).toContain("**Wiki pages:** 1 created, 0 updated");
    expect(err).toContain("wiki-ingest: mode full, invoking agent");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the skip line for a second run with no changes", async () => {
    const h = await makeCliHarness();
    const args = [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];

    await runCli(args);

    const { out } = await runCli(args);

    expect(out).toBe(
      "wiki-ingest: no changed sources since the last ingest; nothing to do",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1800",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
    expect(process.exitCode).toBeUndefined();
  });

  it("converts --timeout seconds to the agent deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "slow-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('slow but fine');\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("slow but fine");
    expect(process.exitCode).toBeUndefined();
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stalled-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toMatch(/timed out after 1 second/);
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for an unknown option", async () => {
    const { err } = await runCli(["--bogus"]);

    expect(err).toContain("unknown option");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --settings has no value", async () => {
    const { err } = await runCli(["--settings"]);

    expect(err).toContain("needs a path value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for more than one positional argument", async () => {
    const { err } = await runCli(["one", "two"]);

    expect(err).toContain("expected at most one <raw-dir>");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --outputs without a value", async () => {
    const { err } = await runCli(["--outputs"]);

    expect(err).toContain("--outputs needs a path value");
    expect(process.exitCode).toBe(1);
  });

  it("documents the --timeout switch and its default in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--timeout <secs>");
    expect(out).toContain("1800");
  });

  it("exits 1 for --timeout without a value", async () => {
    const { err } = await runCli(["--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout zero", async () => {
    const { err } = await runCli(["--timeout", "0"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout negative", async () => {
    const { err } = await runCli(["--timeout", "-5"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const { err } = await runCli(["--timeout", "abc"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const { err } = await runCli(["--timeout", "5x"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
    expect(process.exitCode).toBe(1);
  });
});
