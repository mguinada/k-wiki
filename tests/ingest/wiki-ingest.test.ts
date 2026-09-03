import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createAgentProgressSink } from "../../src/cli/progress.ts";
import { runContext } from "../../src/cli/run-context.ts";
import { runGit } from "../../src/data/git.ts";
import { type AgentRunner, readPrompt } from "../../src/ingest/agent-run.ts";
import { loadAgentSettings } from "../../src/ingest/agent-settings.ts";
import { diffManifests } from "../../src/ingest/manifest-diff.ts";
import {
  composeExpungePrompt,
  composePrompt,
  removedNoteContent,
  runWikiIngest,
} from "../../src/ingest/wiki-ingest.ts";
import { parseManifest, serializeManifest } from "../../src/sync/manifest.ts";
import {
  commitAll,
  entry,
  frontmatterSaboteur,
  type Harness,
  hashOf,
  invocation,
  makeDataRepo,
  makeHarness,
  manifestWith,
  optionsFor,
  run,
  SETTINGS_YML,
  type Track,
  wikiPage,
} from "./harness.ts";

const tempDirs: string[] = [];

const track: Track = (dir) => tempDirs.push(dir);

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
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

  it("labels the changed-sources section of the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain(
      "Changed sources since the previous ingestion:",
    );
  });

  it("lists an added source with a plus in the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain("+ Engineering/new.md");
  });

  it("lists a changed source with a tilde in the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain("~ Engineering/old.md");
  });

  it("lists a removed source with a minus in the incremental prompt", () => {
    expect(composePrompt("PROMPT", diff)).toContain("- Engineering/gone.md");
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

  it("renders a rename pair as one arrow line", () => {
    const renamed = diffManifests(
      manifestWith("Engineering", { "old.md": entry("same") }),
      manifestWith("Engineering", { "new.md": entry("same") }),
    );

    expect(composePrompt("PROMPT", renamed)).toBe(
      [
        "PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "→ Engineering/old.md → Engineering/new.md",
      ].join("\n"),
    );
  });

  it("appends the operator note below the changed-source list under an Operator note heading", () => {
    expect(composePrompt("PROMPT", diff, "re-adjudicate: under-filed")).toBe(
      [
        "PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "+ Engineering/new.md",
        "~ Engineering/old.md",
        "- Engineering/gone.md",
        "",
        "Operator note:",
        "",
        "re-adjudicate: under-filed",
      ].join("\n"),
    );
  });

  it("leaves a full-ingest prompt unchanged when a note is given", () => {
    expect(composePrompt("PROMPT", undefined, "NOTE")).toBe("PROMPT");
  });
});

describe("composeExpungePrompt", () => {
  const diff = diffManifests(
    manifestWith("Engineering", {
      "gone.md": entry("gone"),
      "a.md": entry("a"),
    }),
    manifestWith("Engineering", { "a.md": entry("a") }),
  );

  it("appends the changed sources, note content, and direct set", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      diff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      ["index.md", "overview.md"],
    );

    expect(composed).toBe(
      [
        "EXPUNGE PROMPT",
        "",
        "Changed sources since the previous ingestion:",
        "",
        "- Engineering/gone.md",
        "",
        "Removed notes with their last synced content:",
        "",
        "### Engineering/gone.md (raw/notes/Engineering/gone.md)",
        "",
        "````markdown",
        "last body",
        "````",
        "",
        "Direct set (deterministic seed — a lower bound, not a boundary):",
        "",
        "- wiki/index.md",
        "- wiki/overview.md",
      ].join("\n"),
    );
  });

  it("states unavailable content instead of an empty fence", () => {
    const composed = composeExpungePrompt(
      "P",
      diff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: undefined,
        },
      ],
      [],
    );

    expect(composed).toContain(
      "(last synced content unavailable: no committed git history — purge by path, title, and full-text search)",
    );
  });

  const mixedDiff = diffManifests(
    manifestWith("Engineering", {
      "gone.md": entry("gone"),
      "keep.md": entry("keep"),
    }),
    manifestWith("Engineering", {
      "keep.md": entry("keep"),
      "fresh.md": entry("fresh"),
    }),
  );

  it("embeds the incremental instruction block under the expunge prompt", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      mixedDiff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      [],
      "INCREMENTAL PROMPT",
    );

    expect(composed).toContain(
      [
        "EXPUNGE PROMPT",
        "",
        "This run also carries added, edited, or renamed sources (`+`, `~`, `→` in the list below). In the same run, process them exactly as an incremental ingestion would:",
        "",
        "INCREMENTAL PROMPT",
      ].join("\n"),
    );
  });

  it("lists the addition a mixed expunge run also carries", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      mixedDiff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      [],
      "INCREMENTAL PROMPT",
    );

    expect(composed).toContain("+ Engineering/fresh.md");
  });

  it("lists the removal a mixed expunge run also carries", () => {
    const composed = composeExpungePrompt(
      "EXPUNGE PROMPT",
      mixedDiff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "last body",
        },
      ],
      [],
      "INCREMENTAL PROMPT",
    );

    expect(composed).toContain("- Engineering/gone.md");
  });

  it("wraps a note body whose own fences are four backticks long", () => {
    const composed = composeExpungePrompt(
      "P",
      diff,
      [
        {
          vault: "Engineering",
          path: "gone.md",
          rawPath: "raw/notes/Engineering/gone.md",
          content: "````\nnested fence\n````",
        },
      ],
      [],
    );

    expect(composed).toContain(
      "`````markdown\n````\nnested fence\n````\n`````",
    );
  });
});

describe("removedNoteContent", () => {
  it("returns the HEAD content while the removal is uncommitted", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "last body" }, track);

    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));

    await expect(
      removedNoteContent(dataRoot, "raw/notes/Engineering/a.md", process.env),
    ).resolves.toBe("last body");
  });

  it("returns the parent-tree content after the deletion is committed", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "final body" }, track);

    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));
    await run("git", ["-C", dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "remove note",
    ]);

    await expect(
      removedNoteContent(dataRoot, "raw/notes/Engineering/a.md", process.env),
    ).resolves.toBe("final body");
  });

  it("returns undefined for a path git never knew", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/never.md",
        process.env,
      ),
    ).resolves.toBeUndefined();
  });

  it("returns undefined outside a git repository", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await rm(join(dataRoot, ".git"), { recursive: true });

    await expect(
      removedNoteContent(dataRoot, "raw/notes/Engineering/a.md", process.env),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for an expected hash outside a git repository", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await rm(join(dataRoot, ".git"), { recursive: true });

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("a"),
      ),
    ).resolves.toBeUndefined();
  });

  it("returns the blob matching the expected hash, skipping newer committed edits", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "first body" }, track);

    await writeFile(
      join(dataRoot, "raw", "notes", "Engineering", "a.md"),
      "second body",
    );
    await commitAll(dataRoot, "edit body");
    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));
    await commitAll(dataRoot, "remove note");

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("first body"),
      ),
    ).resolves.toBe("first body");
  });

  it("returns the HEAD blob when it matches the expected hash", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "last body" }, track);

    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("last body"),
      ),
    ).resolves.toBe("last body");
  });

  it("returns undefined when no committed blob matches the expected hash", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "first body" }, track);

    await writeFile(
      join(dataRoot, "raw", "notes", "Engineering", "a.md"),
      "second body",
    );
    await commitAll(dataRoot, "edit body");
    await rm(join(dataRoot, "raw", "notes", "Engineering", "a.md"));
    await commitAll(dataRoot, "remove note");

    await expect(
      removedNoteContent(
        dataRoot,
        "raw/notes/Engineering/a.md",
        process.env,
        hashOf("never committed"),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("runWikiIngest", () => {
  it("runs the agent when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("uses threaded agent settings instead of re-reading the file", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const settings = await loadAgentSettings(h.settingsPath);

    // A settings file the parser must refuse: only the threaded
    // object can carry the run (R-1, one settings.yml parse per run).
    await writeFile(h.settingsPath, "command: [broken\n");

    const result = await runWikiIngest({ ...optionsFor(h), settings });

    expect(result.status).toBe("ran");
  });

  it("uses the full ingest prompt when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args.at(-1)).toBe("FULL PROMPT");
  });

  it("invokes the agent in the data repo root", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).cwd).toBe(h.dataRoot);
  });

  it("passes the --provider flag when the setting is present", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--provider");
  });

  it("passes the provider value after --provider", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nprovider: zai\nreasoning: high\n",
    );
    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--provider") + 1]).toBe("zai");
  });

  it("passes the --model flag from settings", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--model");
  });

  it("passes the model value after --model", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--model") + 1]).toBe("GLM-5.2");
  });

  it("passes the --thinking flag from settings", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--thinking");
  });

  it("passes the reasoning level after --thinking", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("passes the prompt via --print", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toContain("--print");
  });

  it("passes the pi isolation flags by default", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const args = invocation(h, 0).args;

    expect(
      ["--no-context-files", "--no-extensions", "--no-skills"].every((flag) =>
        args.includes(flag),
      ),
    ).toBe(true);
  });

  it("omits the isolation flags on an isolate: false opt-out", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(
      h.settingsPath,
      "command: pi\nmodel: GLM-5.2\nreasoning: high\nisolate: false\n",
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toEqual([
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "FULL PROMPT",
    ]);
  });

  it("passes one --skill/-e flag per whitelisted entry after the isolation flags (issue #144)", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const skillDir = join(h.dataRoot, ".agents", "skills", "obsidian-markdown");

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n");
    await mkdir(join(h.dataRoot, "exts"), { recursive: true });
    await writeFile(join(h.dataRoot, "exts", "web-access.ts"), "export {};\n");
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [.agents/skills/obsidian-markdown]\nisolate.extensions: [exts/web-access.ts]\n`,
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args.slice(0, 7)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--skill",
      skillDir,
      "-e",
      join(h.dataRoot, "exts", "web-access.ts"),
    ]);
  });

  it("warns and omits an absent whitelist entry (issue #144)", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const progress: string[] = [];

    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [.agents/skills/absent]\n`,
    );
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => progress.push(message) }),
    });

    expect(progress).toContain(
      `WARNING — isolate.skills entry "${join(h.dataRoot, ".agents", "skills", "absent")}" not found; omitted`,
    );
    expect(invocation(h, 0).args).not.toContain("--skill");
  });

  it("records the whitelist state in the digest header (issue #144)", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const skillDir = join(h.dataRoot, ".agents", "skills", "obsidian-markdown");

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n");
    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate.skills: [.agents/skills/obsidian-markdown]\n`,
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran ingest");
    }

    expect(result.digest).toContain("· isolated +1 skill");
  });

  it("keeps the whitelist keys ignored on an isolate: false opt-out", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(
      h.settingsPath,
      `${SETTINGS_YML}isolate: false\nisolate.skills: [.agents/skills/absent]\n`,
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 0).args).toEqual([
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "FULL PROMPT",
    ]);
  });

  it("writes the manifest snapshot the next run diffs against", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const snapshot = parseManifest(
      await (await import("node:fs/promises")).readFile(h.snapshotPath, "utf8"),
      "snapshot",
    );

    expect(snapshot.vaults.Engineering?.["a.md"]?.hash).toBe(hashOf("a"));
  });

  it("stamps the written snapshot with the data repo root", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const snapshot = JSON.parse(await readFile(h.snapshotPath, "utf8"));

    expect(snapshot.snapshotFor).toBe(h.dataRoot);
  });

  it("writes no snapshot into the wrapper's outputs dir", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    await expect(readFile(h.legacySnapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the written snapshot out of the data repo's git status", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const { stdout } = await run("git", [
      "-C",
      h.dataRoot,
      "status",
      "--porcelain",
      "-uall",
      "--",
      "outputs",
    ]);

    expect(stdout).toBe("");
  });

  it("appends the snapshot ignore entry to an existing data-repo .gitignore", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(join(h.dataRoot, ".gitignore"), "scratch/");

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n",
    );
  });

  it("leaves a data-repo .gitignore that already ignores the snapshot untouched", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const before =
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n";

    await writeFile(join(h.dataRoot, ".gitignore"), before);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("appends the snapshot ignore entry without adding a blank line after a terminated .gitignore", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(join(h.dataRoot, ".gitignore"), "scratch/\n");

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(
      "scratch/\n# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n",
    );
  });

  it("creates the data-repo .gitignore with only the snapshot entry when none exists", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(
      "# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)\noutputs/last-ingested-manifest.json\n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n",
    );
  });

  it("treats a whitespace-padded snapshot entry line as already present", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const before =
      "scratch/\n  outputs/last-ingested-manifest.json  \n# static dashboard: regenerated per checkout, never committed (issue #73)\ndashboard.html\n";

    await writeFile(join(h.dataRoot, ".gitignore"), before);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("treats an anchored dashboard.html entry line as already present", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const before =
      "scratch/\noutputs/last-ingested-manifest.json\n/dashboard.html\n";

    await writeFile(join(h.dataRoot, ".gitignore"), before);

    await runWikiIngest(optionsFor(h));

    expect(await readFile(join(h.dataRoot, ".gitignore"), "utf8")).toBe(before);
  });

  it("adopts a legacy wrapper snapshot when the data repo has none", async () => {
    const h = await makeHarness({ "a.md": "a2" }, track);

    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("adopts a legacy snapshot when the data repo outputs dir already holds files", async () => {
    const h = await makeHarness({ "a.md": "a2" }, track);

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      join(h.dataRoot, "outputs", "lint-2026-08-24.md"),
      "lint report\n",
    );
    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("announces the legacy snapshot adoption on progress", async () => {
    const h = await makeHarness({ "a.md": "a2" }, track);
    const messages: string[] = [];

    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some((message) =>
        message.startsWith("wiki-ingest: adopting legacy snapshot from"),
      ),
    ).toBe(true);
  });

  it("keeps guarding an adopted legacy snapshot stamped for a foreign root", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some((message) =>
        message.includes("is stamped for /foreign/data-root"),
      ),
    ).toBe(true);
  });

  it("prefers the data-repo snapshot when both locations hold one", async () => {
    const h = await makeHarness({ "a.md": "a2" }, track);

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );
    await mkdir(h.outputsDir, { recursive: true });
    await writeFile(
      h.legacySnapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: h.dataRoot },
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("runs a full ingest instead of expunging on a foreign snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("warns loudly when the snapshot is stamped for another data root", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes("is stamped for /foreign/data-root"),
      ),
    ).toBe(true);
  });

  it("promises a self-healing full-run fallback in the foreign-snapshot warning of an unscoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
        { snapshotFor: "/foreign/data-root" },
      ),
    );

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("falling back to a full run") &&
          message.includes("this warning will not repeat"),
      ),
    ).toBe(true);
  });

  it("runs a full ingest on an unstamped legacy snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("warns that an unstamped legacy snapshot has no instance stamp", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes("has no instance stamp"),
      ),
    ).toBe(true);
  });

  it("the legacy-snapshot warning states the self-healing rewrite", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith("Engineering", { "gone.md": entry("gone") }),
      ),
    );

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some((message) =>
        message.includes(
          "rewrites the snapshot, so this warning will not repeat",
        ),
      ),
    ).toBe(true);
  });

  it("rejects a snapshot that is not valid JSON", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(h.snapshotPath, "not json");

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("names the JSON parse failure as the cause of the rejection", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(h.snapshotPath, "not json");

    await expect(runWikiIngest(optionsFor(h))).rejects.toHaveProperty(
      "cause",
      expect.any(SyntaxError),
    );
  });

  it("runs the agent on the first ingest before skipping", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const first = await runWikiIngest(optionsFor(h));

    expect(first.status).toBe("ran");
  });

  it("skips the agent when nothing changed since the snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await runWikiIngest(optionsFor(h));
    const second = await runWikiIngest(optionsFor(h));

    expect(second).toMatchObject({
      status: "skipped",
      reason: "no changed sources since the last ingest; nothing to do",
    });
  });

  it("announces the skip on the progress line", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await runWikiIngest(optionsFor(h));
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages).toContain(
      "no changed sources since the last ingest; nothing to do",
    );
  });

  it("does not invoke the agent again when nothing changed", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));
    await runWikiIngest(optionsFor(h));

    expect(h.invocations).toHaveLength(1);
  });

  it("skips the agent when the manifest holds no notes at all", async () => {
    const h = await makeHarness({}, track);
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("skipped");
  });

  it("invokes no agent when the manifest holds no notes at all", async () => {
    const h = await makeHarness({}, track);

    await runWikiIngest(optionsFor(h));

    expect(h.invocations).toHaveLength(0);
  });

  it("runs the agent again when a source changed", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("selects the incremental prompt for a changed source", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("names the changed source in the incremental prompt", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("Engineering/a.md");
  });

  it("runs the agent on an expunge cycle", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("marks a removed-source run as expunge mode", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("expunge");
  });

  it("delivers the expunge prompt for a removed source", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("EXPUNGE PROMPT");
  });

  it("lists the removed source in the expunge prompt", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- Engineering/gone.md");
  });

  it("heads the removed note's content block with its raw path", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "### Engineering/gone.md (raw/notes/Engineering/gone.md)",
    );
  });

  it("embeds the removed note's last content in the expunge prompt", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("DISTINCTIVE GONE BODY");
  });

  it("names the wiki index page in the expunge prompt", async () => {
    const h = await makeHarness({ "gone.md": "DISTINCTIVE GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- wiki/index.md");
  });

  it("runs a mixed expunge cycle", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("marks a mixed run as expunge mode", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("expunge");
  });

  it("delivers the expunge prompt inside a mixed run", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("EXPUNGE PROMPT");
  });

  it("delivers the incremental prompt inside a mixed expunge run", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("lists the addition a mixed expunge run carries", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("+ Engineering/fresh.md");
  });

  it("lists the removal a mixed expunge run carries", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "fresh.md"),
      "FRESH",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "keep.md": entry("KEEP"),
          "fresh.md": entry("FRESH"),
        }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("- Engineering/gone.md");
  });

  it("delivers no incremental prompt when the run removes sources only", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).not.toContain("INCREMENTAL PROMPT");
  });

  it("runs an expunge cycle that also edits a kept source", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "keep.md"),
      "KEEP v2",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "keep.md": entry("KEEP v2") }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("appends the incremental prompt to an expunge run carrying edited sources", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "keep.md": "KEEP" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "keep.md"),
      "KEEP v2",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "keep.md": entry("KEEP v2") }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("runs an expunge cycle that also renames a source", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "old.md": "SAME" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "old.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "new.md"),
      "SAME",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "new.md": entry("SAME") }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("appends the incremental prompt to an expunge run carrying renamed sources", async () => {
    const h = await makeHarness(
      { "gone.md": "GONE BODY", "old.md": "SAME" },
      track,
    );

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "old.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "new.md"),
      "SAME",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "new.md": entry("SAME") }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("labels the expunge digest header with the run timestamp", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain(
      "# Wiki ingest digest (expunge) — 2026-08-20T18:00:00.000Z",
    );
  });

  it("states the expunge mode in the run digest", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain("**Mode:** expunge");
  });

  it("carries the expunge direct set heading in the run digest", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain("## Expunge direct set");
  });

  it("lists the affected wiki page in the run digest's direct set", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain("- wiki/index.md");
  });

  it("treats an equal-hash remove and add pair as a change, not expunge", async () => {
    const h = await makeHarness({ "a.md": "same" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "same",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "b.md": entry("same") })),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("incremental");
  });

  it("names the equal-hash pair as a rename in the incremental prompt", async () => {
    const h = await makeHarness({ "a.md": "same" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "same",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "b.md": entry("same") })),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("runs the cycle after a committed body edit and move", async () => {
    const h = await makeHarness({ "a.md": "old body" }, track);

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("expunges a rename whose committed body edit the snapshot skipped", async () => {
    const h = await makeHarness({ "a.md": "old body" }, track);

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("expunge");
  });

  it("lists the moved note as added when the pair is not renamed", async () => {
    const h = await makeHarness({ "a.md": "old body" }, track);

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("+ Engineering/b.md");
  });

  it("does not render the arrow pair across a committed body edit", async () => {
    const h = await makeHarness({ "a.md": "old body" }, track);

    await runWikiIngest(optionsFor(h));

    const note = join(h.dataRoot, "raw", "notes", "Engineering", "a.md");

    await writeFile(note, "new body");
    await commitAll(h.dataRoot, "edit body");
    await rm(note);
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      "new body",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry("new body") }),
      ),
    );
    await commitAll(h.dataRoot, "move note");
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).not.toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("still pairs a rename whose committed interim edit touched only frontmatter", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged }, track);

    await runWikiIngest(optionsFor(h));

    const dir = join(h.dataRoot, "raw", "notes", "Engineering");

    await writeFile(join(dir, "a.md"), retagged);
    await commitAll(h.dataRoot, "retag note");
    await rm(join(dir, "a.md"));
    await writeFile(join(dir, "b.md"), retagged);
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("treats a frontmatter-only interim edit as an incremental run", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged }, track);

    await runWikiIngest(optionsFor(h));

    const dir = join(h.dataRoot, "raw", "notes", "Engineering");

    await writeFile(join(dir, "a.md"), retagged);
    await commitAll(h.dataRoot, "retag note");
    await rm(join(dir, "a.md"));
    await writeFile(join(dir, "b.md"), retagged);
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await commitAll(h.dataRoot, "move note");

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("incremental");
  });

  it("pairs the frontmatter-retagged move as a rename", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged }, track);

    await runWikiIngest(optionsFor(h));

    const dir = join(h.dataRoot, "raw", "notes", "Engineering");

    await writeFile(join(dir, "a.md"), retagged);
    await commitAll(h.dataRoot, "retag note");
    await rm(join(dir, "a.md"));
    await writeFile(join(dir, "b.md"), retagged);
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await commitAll(h.dataRoot, "move note");
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("runs the cycle after a frontmatter-only edit during a move", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      retagged,
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("treats a frontmatter-only edit during a move as an incremental run", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      retagged,
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.mode).toBe("incremental");
  });

  it("pairs a frontmatter-only edit during a move as a rename", async () => {
    const tagged = "---\ntags: [a]\n---\nSame body.\n";
    const retagged = "---\ntags: [a, b]\n---\nSame body.\n";
    const h = await makeHarness({ "a.md": tagged }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "a.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "b.md"),
      retagged,
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", { "b.md": entry(retagged) }),
      ),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "→ Engineering/a.md → Engineering/b.md",
    );
  });

  it("announces the expunge trigger and direct set on the progress sink", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);
    const messages: string[] = [];

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages).toContain(
      "wiki-ingest: expunge — 1 removed source; direct set: wiki/index.md, wiki/overview.md",
    );
  });

  it("pluralizes the preview line for several removed sources", async () => {
    const h = await makeHarness({ "a.md": "A", "b.md": "B" }, track);
    const messages: string[] = [];

    await runWikiIngest(optionsFor(h));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages).toContain(
      "wiki-ingest: expunge — 2 removed sources; direct set: wiki/A-page.md, wiki/concepts/new.md, wiki/index.md, wiki/overview.md, wiki/sources/src.md",
    );
  });

  it("seeds the source page whose origin names the removed note in the prompt", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await mkdir(join(h.dataRoot, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "sources", "gone note.md"),
      "---\ntitle: Gone note\ntype: source\norigin: raw/notes/Engineering/gone.md\n---\nbody",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "origin page",
    ]);
    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain(
      "- wiki/sources/gone note.md",
    );
  });

  it("names the origin-linked source page on the progress line", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);
    const messages: string[] = [];

    await mkdir(join(h.dataRoot, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "sources", "gone note.md"),
      "---\ntitle: Gone note\ntype: source\norigin: raw/notes/Engineering/gone.md\n---\nbody",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    await run("git", [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "origin page",
    ]);
    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages.some((m) => m.includes("wiki/sources/gone note.md"))).toBe(
      true,
    );
  });

  it("passes the injected environment through to the agent", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const env = { KWIKI_TEST: "yes" };
    let seen: NodeJS.ProcessEnv | undefined;
    const recording: AgentRunner = async (_command, _args, options) => {
      seen = options.env;

      return { stdout: "report", stderr: "" };
    };

    await runWikiIngest({ ...optionsFor(h, { env }), runAgent: recording });

    expect(seen).toBe(env);
  });

  it("does not count a staged wiki rename as a deleted page", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const quiet: AgentRunner = async () => ({
      stdout: "quiet report",
      stderr: "",
    });

    await run("git", [
      "-C",
      h.dataRoot,
      "mv",
      "wiki/A-page.md",
      "wiki/B-page.md",
    ]);

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual([]);
  });

  it("does not count a staged wiki rename as a created page", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const quiet: AgentRunner = async () => ({
      stdout: "quiet report",
      stderr: "",
    });

    await run("git", [
      "-C",
      h.dataRoot,
      "mv",
      "wiki/A-page.md",
      "wiki/B-page.md",
    ]);

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.created).toEqual([]);
  });

  it("does not count a staged wiki rename as an updated page", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const quiet: AgentRunner = async () => ({
      stdout: "quiet report",
      stderr: "",
    });

    await run("git", [
      "-C",
      h.dataRoot,
      "mv",
      "wiki/A-page.md",
      "wiki/B-page.md",
    ]);

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.updated).toEqual([]);
  });

  it("counts an untracked page the run deleted as deleted", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    const deleting: AgentRunner = async (_command, _args, options) => {
      await rm(join(options.cwd, "wiki", "concepts", "new.md"));
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "page deleted", stderr: "" };
    };

    const result = await runWikiIngest({
      ...optionsFor(h),
      runAgent: deleting,
    });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual(["wiki/concepts/new.md"]);
  });

  it("does not count a wiki deletion that predates the run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const quiet: AgentRunner = async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "quiet report", stderr: "" };
    };

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "wiki", "A-page.md"));
    await writeFile(
      join(h.dataRoot, "raw", "notes", "Engineering", "a.md"),
      "a2",
    );
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a2") })),
    );

    const result = await runWikiIngest({ ...optionsFor(h), runAgent: quiet });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual([]);
  });

  it("keeps the underlying read error as cause when the prompt is missing", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await rm(join(h.promptsDir, "ingest.md"));

    let cause: unknown;

    try {
      await runWikiIngest(optionsFor(h));
    } catch (error) {
      cause = (error as Error).cause;
    }

    expect(cause).toBeInstanceOf(Error);
  });

  it("labels the heartbeat line for an expunge run", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      runAgent: slow,
      heartbeatMs: 40,
    });

    expect(messages).toContain("wiki-ingest: expunge agent still running (0s)");
  });

  it("states unavailable content when the removed note has no git history", async () => {
    const h = await makeHarness({ "gone.md": "GONE BODY" }, track);

    // Rewrite the initial commit without the note: the repo keeps a
    // commit to revert to (guardrails), but no history knows the note.
    await run("git", [
      "-C",
      h.dataRoot,
      "rm",
      "--quiet",
      "--cached",
      "raw/notes/Engineering/gone.md",
    ]);
    await run("git", [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "--amend",
      "--no-edit",
    ]);

    await runWikiIngest(optionsFor(h));
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "gone.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", {})),
    );

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("no committed git history");
  });

  it("derives the run's created wiki pages from git status", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.created).toEqual(["wiki/concepts/new.md"]);
  });

  it("derives the run's updated wiki pages from git status", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.updated).toEqual(["wiki/A-page.md", "wiki/index.md"]);
  });

  it("does not report a deleted wiki page as created", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.created).not.toContain("wiki/gone.md");
  });

  it("does not report a deleted wiki page as updated", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.updated).not.toContain("wiki/gone.md");
  });

  it("reports wiki pages the run deleted under their own category", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toEqual(["wiki/gone.md"]);
  });

  it("counts a page deleted by the run even when it was dirty before the run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const deleting: AgentRunner = async (_command, _args, options) => {
      await rm(join(options.cwd, "wiki", "A-page.md"));
      await writeFile(
        join(options.cwd, "wiki", "index.md"),
        wikiPage("# Index v2"),
      );

      return { stdout: "page deleted", stderr: "" };
    };

    await writeFile(join(h.dataRoot, "wiki", "A-page.md"), "# A page dirty\n");

    const result = await runWikiIngest({
      ...optionsFor(h),
      runAgent: deleting,
    });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.pages.deleted).toContain("wiki/A-page.md");
  });

  it("lists the run's single-source changed pages in the digest's unverified frontier", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digest).toContain(
      "- wiki/concepts/new.md (1 source: [[src]])",
    );
  });

  it("writes the digest under outputs/runs with a sortable timestamp", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digestPath).toBe(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
    );
  });

  it("records the mode and prompt in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("**Mode:** full · prompt `prompts/ingest.md`");
  });

  it("records the source counts in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("**Sources:** 1 added");
  });

  it("names the created wiki page in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("wiki/concepts/new.md");
  });

  it("embeds the agent report in the written digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const { readFile } = await import("node:fs/promises");
    const result = await runWikiIngest(optionsFor(h));

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    const digest = await readFile(result.digestPath, "utf8");

    expect(digest).toContain("agent final report");
  });

  it("fails with no commit to revert to when the data repo has no git", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await rm(join(h.dataRoot, ".git"), { recursive: true });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      "no commit to revert to",
    );
  });

  it("runs no agent when the data repo has no git to revert to", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await rm(join(h.dataRoot, ".git"), { recursive: true });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      "no commit to revert to",
    );

    expect(h.invocations).toHaveLength(0);
  });

  it("fails naming the prompt file when it is missing", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await rm(join(h.promptsDir, "ingest.md"));

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow(
      /cannot read prompt at .*ingest\.md/,
    );
  });

  it("runs without an injected clock", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest({
      settingsPath: h.settingsPath,
      run: runContext({ rawDir: join(h.dataRoot, "raw") }),
      outputsDir: h.outputsDir,
      promptsDir: h.promptsDir,
      runAgent: h.runAgent,
    });

    expect(result.status).toBe("ran");
  });

  it("falls back to the wall clock for the digest timestamp", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest({
      settingsPath: h.settingsPath,
      run: runContext({ rawDir: join(h.dataRoot, "raw") }),
      outputsDir: h.outputsDir,
      promptsDir: h.promptsDir,
      runAgent: h.runAgent,
    });

    if (result.status !== "ran") {
      throw new Error("expected a ran cycle");
    }

    expect(result.digestPath).toMatch(
      /\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/,
    );
  });

  it("reports each pipeline step on the progress sink", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages).toEqual([
      expect.stringContaining("wiki-ingest: raw dir"),
      expect.stringContaining(
        "wiki-ingest: ignoring outputs/last-ingested-manifest.json",
      ),
      expect.stringContaining("wiki-ingest: ignoring dashboard.html"),
      expect.stringContaining(
        "invoking agent: pi --model GLM-5.2 --thinking high",
      ),
      "wiki-ingest: agent finished",
      "wiki-ingest: guardrails passed",
      expect.stringContaining("wiki-ingest: dashboard refreshed at"),
    ]);
  });

  it("states the isolation state on the invoking-agent progress line", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages.join("\n")).toContain(
      "invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
    );
  });

  it("emits a heartbeat while a slow agent run is in flight", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];
    const slow: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      runAgent: slow,
      heartbeatMs: 40,
    });

    expect(messages).toEqual(
      expect.arrayContaining(["wiki-ingest: agent still running (0s)"]),
    );
  });

  it("formats the heartbeat clock as minutes and padded seconds", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];
    let clock = new Date("2026-08-20T17:58:00.000Z");
    const slow: AgentRunner = async () => {
      clock = new Date(clock.getTime() + 127_000);

      await new Promise((resolve) => setTimeout(resolve, 60));

      return { stdout: "slow agent report", stderr: "" };
    };

    await runWikiIngest({
      ...optionsFor(h, {
        now: () => clock,
        onProgress: (message) => messages.push(message),
      }),
      runAgent: slow,
      heartbeatMs: 20,
    });

    expect(messages).toContain("wiki-ingest: agent still running (2m07s)");
  });

  it("stops the heartbeat when the agent run ends", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];
    const fast: AgentRunner = async () => ({
      stdout: "fast report",
      stderr: "",
    });

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      runAgent: fast,
      heartbeatMs: 40,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      messages.filter((message) => message.includes("still running")),
    ).toEqual([]);
  });

  it("enforces the timeout on the real agent runner", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
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
        run: runContext({ rawDir: join(h.dataRoot, "raw") }),
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
    const h = await makeHarness({ "a.md": "a" }, track);

    await rm(join(h.dataRoot, "raw", "manifest.json"));

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow("sync-vault");
  });

  it("reports an agent failure with its exit code", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1\nstderr tail");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow("code 1");
  });

  it("leaves no snapshot and no digest when the agent fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow();

    const { readFile } = await import("node:fs/promises");

    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(
        join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when the digest write fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await mkdir(join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"), {
      recursive: true,
    });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow();
  });

  it("leaves no snapshot when the digest write fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await mkdir(join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"), {
      recursive: true,
    });

    await expect(runWikiIngest(optionsFor(h))).rejects.toThrow();

    const { readFile } = await import("node:fs/promises");

    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("runWikiIngest tracked-but-ignored pre-flight (issue #146)", () => {
  /** Track `.obsidian/workspace.json` in the data repo, then add the
   *  ignore rule afterwards — the hazard order from k-wiki-meta-data
   *  commit 72dce82: gitignore does not apply to tracked files. */
  async function trackIgnoredObsidianState(h: Harness): Promise<void> {
    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await commitAll(h.dataRoot, "track obsidian state");
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");
  }

  it("still runs a full ingest over a tracked-but-ignored file", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await trackIgnoredObsidianState(h);

    const result = await runWikiIngest(optionsFor(h));

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("warns pre-flight with the untrack fix for a tracked-but-ignored file", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await trackIgnoredObsidianState(h);

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes(".obsidian/workspace.json") &&
          message.includes("git rm --cached .obsidian/workspace.json"),
      ),
    ).toBe(true);
  });

  it("warns once per tracked-but-ignored file", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await writeFile(join(h.dataRoot, ".obsidian", "app.json"), "{}");
    await commitAll(h.dataRoot, "track obsidian state");
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    const warnings = messages.filter((message) => message.includes("WARNING"));

    expect(warnings).toHaveLength(2);
  });

  it("stays silent when no tracked file is ignored", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(join(h.dataRoot, ".obsidian"), { recursive: true });
    await writeFile(join(h.dataRoot, ".obsidian", "workspace.json"), "{}");
    await writeFile(join(h.dataRoot, ".gitignore"), ".obsidian/\n");

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(messages.some((message) => message.includes("WARNING"))).toBe(false);
  });

  it("warns for a tracked snapshot after appending its ignore entry", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") })),
    );
    await commitAll(h.dataRoot, "track the snapshot");

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
    });

    expect(
      messages.some(
        (message) =>
          message.includes("WARNING") &&
          message.includes(
            "git rm --cached outputs/last-ingested-manifest.json",
          ),
      ),
    ).toBe(true);
  });
});

describe("runWikiIngest --sources", () => {
  /** A stamped snapshot for the harness manifest: the corpus is fully
   *  ingested, so the manifest diff is empty and only --sources runs. */
  async function seedSnapshot(
    h: Harness,
    notes: Record<string, string>,
    stamp = h.dataRoot,
  ): Promise<void> {
    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(
        manifestWith(
          "Engineering",
          Object.fromEntries(
            Object.entries(notes).map(([path, content]) => [
              path,
              entry(content),
            ]),
          ),
        ),
        { snapshotFor: stamp },
      ),
    );
  }

  it("completes when a rename candidate is missing from raw", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a", "old.md": "old" });

    // The manifest swaps old.md for new.md — a rename candidate —
    // but new.md's projection never reached disk: the pairing read
    // misses, the run must treat it as plain added and complete.
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(
        manifestWith("Engineering", {
          "a.md": entry("a"),
          "new.md": entry("new"),
        }),
      ),
    );

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("bypasses the empty-diff skip and runs the agent", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result.status).toBe("ran");
  });

  it("runs a scoped selection in incremental mode", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a", "gone.md": "gone" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result).toMatchObject({ status: "ran", mode: "incremental" });
  });

  it("forces the incremental prompt, never full or expunge", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a", "gone.md": "gone" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(invocation(h, 0).args.at(-1)).toContain("INCREMENTAL PROMPT");
  });

  it("replaces a manifest diff whose removals would route to expunge", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a", "gone.md": "gone" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result).toMatchObject({
      status: "ran",
      diff: { vaults: [{ vault: "Engineering", changed: ["a.md"] }] },
    });
  });

  it("renders one ~ line per explicit source, deduped", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" }, track);
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/b.md", "Engineering/a.md", "Engineering/b.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(
      ["a.md", "b.md"].map(
        (f) => prompt.split(`~ Engineering/${f}`).length - 1,
      ),
    ).toEqual([1, 1]);
  });

  it("sorts explicit-source ~ lines in manifest order", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" }, track);
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/b.md", "Engineering/a.md", "Engineering/b.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt.indexOf("~ Engineering/a.md")).toBeLessThan(
      prompt.indexOf("~ Engineering/b.md"),
    );
  });

  it("announces changed sources since the previous ingestion", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" }, track);
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/b.md", "Engineering/a.md", "Engineering/b.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("Changed sources since the previous ingestion:");
  });

  it("carries the --note text below the ~ lines under an Operator note heading", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
      note: "recovery: file the four pre-adjudicated pages",
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("Operator note:");
    expect(prompt.indexOf("~ Engineering/a.md")).toBeLessThan(
      prompt.indexOf("Operator note:"),
    );
    expect(prompt).toContain("recovery: file the four pre-adjudicated pages");
  });

  it("applies the default operator note when --sources runs without one", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("Operator note:");
    expect(prompt).toContain(
      "Sources re-opened by the operator: unchanged content does not imply a no-op; re-adjudicate filing decisions; if declining, state per concept why its treatment fails the page bar.",
    );
  });

  it("omits the operator note on an ordinary incremental run", async () => {
    const h = await makeHarness({ "a.md": "a", "b.md": "b" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest(optionsFor(h));

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("+ Engineering/b.md");
    expect(prompt).not.toContain("Operator note:");
  });

  it("marks the digest Mode line with sources selected explicitly", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });
    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("sources selected explicitly");
  });

  it("runs the run to a guardrail failure", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("omits the sources-selected marker from an ordinary failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).not.toContain("sources selected explicitly");
  });

  it("lists the explicitly named source in a scoped prompt", async () => {
    const h = await makeHarness(
      {
        "a.md": "a",
        "new.md": "added since snapshot",
      },
      track,
    );
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).toContain("~ Engineering/a.md");
  });

  it("hides manifest changes the explicit list does not name", async () => {
    const h = await makeHarness(
      {
        "a.md": "a",
        "new.md": "added since snapshot",
      },
      track,
    );
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const prompt = invocation(h, 0).args.at(-1) ?? "";

    expect(prompt).not.toContain("new.md");
  });

  it("holds a manifest-only added note out of the merged snapshot", async () => {
    const h = await makeHarness(
      {
        "a.md": "a v2",
        "new.md": "added since snapshot",
      },
      track,
    );
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const snapshot = parseManifest(
      await readFile(h.snapshotPath, "utf8"),
      h.snapshotPath,
    );

    expect(snapshot.vaults.Engineering?.["new.md"]).toBeUndefined();
    expect(snapshot.vaults.Engineering?.["a.md"]).toEqual(entry("a v2"));
  });

  it("reports the full held-back counts on the progress line", async () => {
    const h = await makeHarness(
      {
        "a.md": "a v2",
        "b.md": "b v2",
        "new.md": "added since snapshot",
      },
      track,
    );
    await seedSnapshot(h, { "a.md": "a", "b.md": "b" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/a.md"],
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 added, 1 changed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("stays silent when the scoped run covers every pending change", async () => {
    const h = await makeHarness({ "a.md": "a v2", "new.md": "added" }, track);
    await seedSnapshot(h, { "a.md": "a" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/a.md", "Engineering/new.md"],
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBeUndefined();
  });

  it("counts a pending rename outside the sources as held back", async () => {
    const h = await makeHarness(
      {
        "a.md": "a v2",
        "b.md": "b v2",
        "moved.md": "moved",
      },
      track,
    );
    await seedSnapshot(h, {
      "a.md": "a",
      "b.md": "b",
      "old.md": "moved",
    });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/a.md"],
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 changed, 1 renamed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("counts a covered rename's source path as a held-back removal", async () => {
    const h = await makeHarness({ "moved.md": "moved", "b.md": "b v2" }, track);
    await seedSnapshot(h, { "old.md": "moved", "b.md": "b" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/moved.md"],
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 changed, 1 removed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("announces a held-back removal when a covered rename is the only pending change", async () => {
    const h = await makeHarness({ "moved.md": "moved" }, track);
    await seedSnapshot(h, { "old.md": "moved" });
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/moved.md"],
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 removed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("expunges a covered rename's source path on the next ordinary run", async () => {
    const h = await makeHarness({ "moved.md": "moved" }, track);
    await seedSnapshot(h, { "old.md": "moved" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/moved.md"],
    });

    const snapshot = parseManifest(
      await readFile(h.snapshotPath, "utf8"),
      h.snapshotPath,
    );

    expect(snapshot.vaults.Engineering?.["old.md"]).toBeDefined();
    expect(snapshot.vaults.Engineering?.["moved.md"]).toBeDefined();

    const pending = await runWikiIngest(optionsFor(h));

    expect(pending).toMatchObject({ status: "ran", mode: "expunge" });
  });

  it("counts a pending removal as held back", async () => {
    const h = await makeHarness({ "a.md": "a", "doomed.md": "doomed" }, track);
    await seedSnapshot(h, { "a.md": "a", "doomed.md": "doomed" });
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "doomed.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") })),
    );
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/a.md"],
    });

    expect(
      messages.find((message) => message.startsWith("wiki-ingest: scoped run")),
    ).toBe(
      "wiki-ingest: scoped run held back pending changes outside --sources (1 removed) — the merged snapshot leaves them for the next ordinary run",
    );
  });

  it("keeps a pending removal in the merged snapshot for the next expunge run", async () => {
    const h = await makeHarness({ "a.md": "a", "doomed.md": "doomed" }, track);
    await seedSnapshot(h, { "a.md": "a", "doomed.md": "doomed" });

    // A sync removed the note: raw file gone, manifest updated, the
    // snapshot (and the expunge it routes to) still ahead.
    await rm(join(h.dataRoot, "raw", "notes", "Engineering", "doomed.md"));
    await writeFile(
      join(h.dataRoot, "raw", "manifest.json"),
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") })),
    );

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const snapshot = parseManifest(
      await readFile(h.snapshotPath, "utf8"),
      h.snapshotPath,
    );

    expect(snapshot.vaults.Engineering?.["doomed.md"]).toBeDefined();

    const pending = await runWikiIngest(optionsFor(h));

    expect(pending).toMatchObject({ status: "ran", mode: "expunge" });
  });

  it("still ingests manifest changes pending behind a scoped run", async () => {
    const h = await makeHarness(
      {
        "a.md": "a",
        "new.md": "added since snapshot",
      },
      track,
    );
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    const pending = await runWikiIngest(optionsFor(h));

    expect(pending.status).toBe("ran");
  });

  it("pairs the pending manifest change into the follow-up prompt", async () => {
    const h = await makeHarness(
      {
        "a.md": "a",
        "new.md": "added since snapshot",
      },
      track,
    );
    await seedSnapshot(h, { "a.md": "a" });

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    await runWikiIngest(optionsFor(h));

    expect(invocation(h, 1).args.at(-1)).toContain("+ Engineering/new.md");
  });

  it("rejects unknown paths naming every path joined with a comma", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/nope.md", "Engineering/also-missing.md"],
      }),
    ).rejects.toThrow(
      "unknown --sources path(s): Engineering/nope.md, Engineering/also-missing.md",
    );
  });

  it("treats an empty --sources array as absent and runs the manifest diff", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const result = await runWikiIngest({ ...optionsFor(h), sources: [] });

    expect(result).toMatchObject({ status: "ran", mode: "full" });
  });

  it("records sources selected explicitly on the failure digest of a reverted scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("sources selected explicitly");
  });

  it("rejects --sources when no snapshot exists", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({ ...optionsFor(h), sources: ["Engineering/a.md"] }),
    ).rejects.toThrow(/run a full ingest first/);
  });

  it("rejects --sources on a foreign-stamped snapshot", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" }, "/foreign/data-root");

    await expect(
      runWikiIngest({ ...optionsFor(h), sources: ["Engineering/a.md"] }),
    ).rejects.toThrow(/run a full ingest first/);
  });

  it("promises no full-run fallback in the foreign-snapshot warning of a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" }, "/foreign/data-root");
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/a.md"],
    }).catch(() => undefined);

    expect(
      messages.some((message) =>
        message.includes("falling back to a full run"),
      ),
    ).toBe(false);
  });

  it("ends the scoped foreign-snapshot warning at the ignore clause", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" }, "/foreign/data-root");
    const messages: string[] = [];

    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => messages.push(message) }),
      sources: ["Engineering/a.md"],
    }).catch(() => undefined);

    const warning = messages.find((message) => message.includes("WARNING"));

    expect(warning?.endsWith("ignoring it")).toBe(true);
  });

  it("completes a successful scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    const result = await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(result.status).toBe("ran");
  });

  it("rewrites the snapshot idempotently when it matches the manifest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });
    const before = await readFile(h.snapshotPath, "utf8");

    await runWikiIngest({
      ...optionsFor(h),
      sources: ["Engineering/a.md"],
    });

    expect(await readFile(h.snapshotPath, "utf8")).toBe(before);
  });

  it("propagates the failing scoped agent error", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 1");
  });

  it("leaves the snapshot untouched when the scoped agent run fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });
    const before = await readFile(h.snapshotPath, "utf8");
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 1");

    expect(await readFile(h.snapshotPath, "utf8")).toBe(before);
  });

  it("surfaces the guardrail failure on a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("auto-reverts the offending page when a guardrail trips on a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(h.dataRoot, "wiki", "bad.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the snapshot when a guardrail trips on a scoped run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    await seedSnapshot(h, { "a.md": "a" });
    const before = await readFile(h.snapshotPath, "utf8");

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        sources: ["Engineering/a.md"],
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    expect(await readFile(h.snapshotPath, "utf8")).toBe(before);
  });
});

describe("runWikiIngest guardrails", () => {
  const digestPath = (h: Harness) =>
    join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md");

  it("completes a clean run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("keeps the agent's changes on a clean run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const page = await readFile(
      join(h.dataRoot, "wiki", "concepts", "new.md"),
      "utf8",
    );

    expect(page).toContain("New");
  });

  it("reverts and fails the run when a changed page has broken frontmatter", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("removes the offending page when the frontmatter guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(h.dataRoot, "wiki", "bad.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no snapshot when the frontmatter guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    await expect(readFile(h.snapshotPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails the run when the frontmatter guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();
  });

  it("writes a failure digest naming the tripped check", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("Check 2 (frontmatter)");
  });

  it("names the offending page in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("wiki/bad.md");
  });

  it("embeds the agent report in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(digestPath(h), "utf8");

    expect(digest).toContain("rogue report");
  });

  it("reverts and fails the run when the agent writes outside the whitelist", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "raw", "notes"), { recursive: true });
      await writeFile(join(options.cwd, "raw", "notes", "rogue.md"), "x\n");

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 1 (immutability)");
    await expect(
      readFile(join(h.dataRoot, "raw", "notes", "rogue.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reverts raw tampering even when the agent fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "raw", "notes"), { recursive: true });
      await writeFile(join(options.cwd, "raw", "notes", "rogue.md"), "x\n");

      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 1 (immutability)");
    await expect(
      readFile(join(h.dataRoot, "raw", "notes", "rogue.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps valid changes when the agent fails and guardrails pass", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const failing: AgentRunner = async (_command, _args, options) => {
      await writeFile(join(options.cwd, "wiki", "ok.md"), wikiPage("Kept"));

      throw new Error("agent exited with code 1");
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: failing }),
    ).rejects.toThrow("code 1");
    expect(await readFile(join(h.dataRoot, "wiki", "ok.md"), "utf8")).toContain(
      "Kept",
    );
  });

  it("reverts and fails the run when a changed page leaves a dangling wikilink", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await writeFile(
        join(options.cwd, "wiki", "dangling.md"),
        wikiPage("See [[Nowhere]]."),
      );

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 3 (wikilinks)");
    await expect(
      readFile(join(h.dataRoot, "wiki", "dangling.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks a wiki page that was already dirty before the run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(
      join(h.dataRoot, "wiki", "index.md"),
      wikiPage("# Index v2"),
    );

    const saboteur: AgentRunner = async () => {
      await writeFile(
        join(h.dataRoot, "wiki", "index.md"),
        "still dirty, now broken\n",
      );

      return { stdout: "rogue report", stderr: "" };
    };

    await expect(
      runWikiIngest({ ...optionsFor(h), runAgent: saboteur }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });
});

describe("runGit reuse sanity", () => {
  it("reports an untracked wiki file in git status", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

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
  });

  it("reports a modified wiki page in git status", async () => {
    const dataRoot = await makeDataRepo({ "a.md": "a" }, track);

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");

    const { stdout } = await runGit(
      dataRoot,
      ["status", "--porcelain", "-uall", "--", "wiki"],
      process.env,
    );
    const lines = stdout.split("\n").filter(Boolean);

    expect(lines).toContain(" M wiki/index.md");
  });
});

describe("runWikiIngest failure reporting detail", () => {
  it("names the check, the revert target, and the problems in the error", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("formats the guardrail error message with the revert target", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toMatch(
      /^guardrail check 2 \(frontmatter\) failed; run reverted to [0-9a-f]{8} — wiki\/bad\.md: no frontmatter block$/,
    );
  });

  it("leaves the cause unset for a guardrail failure", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).cause).toBeUndefined();
  });

  it("reports the guardrail failure on progress", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const progress: string[] = [];

    await expect(
      runWikiIngest({
        ...optionsFor(h, { onProgress: (message) => progress.push(message) }),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");

    expect(progress.join("\n")).toMatch(
      /^wiki-ingest: guardrail check 2 \(frontmatter\) failed — reverting to [0-9a-f]{8}$/m,
    );
  });

  it("joins multiple guardrail problems with a semicolon in the error", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad-1.md", "bad-2.md"),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toContain(
      "wiki/bad-1.md: no frontmatter block; wiki/bad-2.md: no frontmatter block",
    );
  });

  it("keeps the agent error as the cause when the guardrails also fail", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const saboteur: AgentRunner = async (_command, _args, options) => {
      await mkdir(join(options.cwd, "raw", "notes"), { recursive: true });
      await writeFile(join(options.cwd, "raw", "notes", "rogue.md"), "x\n");

      throw new Error("agent exited with code 1");
    };

    const error = await runWikiIngest({
      ...optionsFor(h),
      runAgent: saboteur,
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      cause: { message: "agent exited with code 1" },
    });
  });

  it("rejects the run when the agent sabotages the frontmatter", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();
  });

  it("states the mode in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("**Mode:** full");
  });

  it("names the prompt file in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain("prompt `prompts/ingest.md`");
  });

  it("reports the wiki pages as unavailable in the failure digest", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow();

    const digest = await readFile(
      join(h.outputsDir, "runs", "2026-08-20T18-00-00.000Z.md"),
      "utf8",
    );

    expect(digest).toContain(
      "**Wiki pages:** unavailable — run reverted — guardrail check 2 (frontmatter) tripped",
    );
  });

  it("announces a kept-changes agent failure on progress", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const progress: string[] = [];
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 9");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h, { onProgress: (message) => progress.push(message) }),
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 9");

    expect(progress).toContain(
      "wiki-ingest: agent failed — guardrails passed, changes kept",
    );
  });

  it("rejects a kept-changes agent failure with the agent error", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const failing: AgentRunner = async () => {
      throw new Error("agent exited with code 9");
    };

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: failing,
      }),
    ).rejects.toThrow("agent exited with code 9");
  });
});

describe("error causes and sink prefixes", () => {
  it("rejects settings loading with an Error", async () => {
    const error = await loadAgentSettings("/no/such/settings.yml").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("attaches the read error as the cause of a settings failure", async () => {
    const error = await loadAgentSettings("/no/such/settings.yml").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("rejects prompt loading with an Error", async () => {
    const error = await readPrompt("/no/such/prompt.md").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it("attaches the read error as the cause of a prompt failure", async () => {
    const error = await readPrompt("/no/such/prompt.md").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("animates any of several heartbeat prefixes", () => {
    const written: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      () => {},
      true,
      { dim: (text) => text, yellow: (text) => text },
      ["first-prefix:", "second-prefix:"],
    );

    sink.render("second-prefix: still running (1m)");

    expect(written).toEqual(["\r⠋ second-prefix: still running (1m)"]);
  });

  it("animates a single string heartbeat prefix", () => {
    const written: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      () => {},
      true,
      { dim: (text) => text, yellow: (text) => text },
      "pfx:",
    );

    sink.render("pfx: agent still running (0s)");

    expect(written).toEqual(["\r⠋ pfx: agent still running (0s)"]);
  });
});

describe("runWikiIngest dashboard hook (issue #73)", () => {
  it("regenerates the dashboard after a successful run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("renders the dashboard as an HTML document after a successful run", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("marks the regenerated dashboard as generated", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html).toContain("generated");
  });

  it("rejects the run when a guardrail trips and a stale dashboard exists", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(join(h.dataRoot, "dashboard.html"), "STALE\n");

    await expect(
      runWikiIngest({
        ...optionsFor(h),
        runAgent: frontmatterSaboteur("bad.md"),
      }),
    ).rejects.toThrow("guardrail check 2 (frontmatter)");
  });

  it("leaves a stale dashboard untouched when a guardrail trips", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await writeFile(join(h.dataRoot, "dashboard.html"), "STALE\n");

    await runWikiIngest({
      ...optionsFor(h),
      runAgent: frontmatterSaboteur("bad.md"),
    }).then(
      () => undefined,
      () => undefined,
    );

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html).toBe("STALE\n");
  });

  it("adds dashboard.html to the data repo gitignore", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const gitignore = await readFile(join(h.dataRoot, ".gitignore"), "utf8");

    expect(gitignore.split("\n")).toContain("dashboard.html");
  });

  it("keeps the run successful when the dashboard refresh fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    // A directory at the output path makes the write fail; the run
    // itself must stay successful (the dashboard is derived).
    await mkdir(join(h.dataRoot, "dashboard.html"));

    const result = await runWikiIngest(optionsFor(h));

    expect(result.status).toBe("ran");
  });

  it("stamps the regenerated dashboard with the run's clock", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest({
      ...optionsFor(h, { now: () => new Date("2031-03-04T05:06:07.000Z") }),
    });

    const html = await readFile(join(h.dataRoot, "dashboard.html"), "utf8");

    expect(html).toContain("generated 2031-03-04 05:06 UTC");
  });

  it("warns on the progress sink when the dashboard refresh fails", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const progress: string[] = [];

    await mkdir(join(h.dataRoot, "dashboard.html"));
    await runWikiIngest({
      ...optionsFor(h, { onProgress: (message) => progress.push(message) }),
    });

    expect(progress.join("\n")).toContain("dashboard refresh failed");
  });
});

describe("gitignore guard progress", () => {
  it("reports the manifest ignore entry the run appended", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];
    const options = {
      ...optionsFor(h, { onProgress: (m: string) => messages.push(m) }),
    };

    await runWikiIngest(options);

    expect(
      messages.some((m) =>
        m.includes("ignoring outputs/last-ingested-manifest.json"),
      ),
    ).toBe(true);
  });

  it("reports the dashboard ignore entry the run appended", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);
    const messages: string[] = [];
    const options = {
      ...optionsFor(h, { onProgress: (m: string) => messages.push(m) }),
    };

    await runWikiIngest(options);

    expect(messages.some((m) => m.includes("ignoring dashboard.html"))).toBe(
      true,
    );
  });

  it("stays silent about entries a previous run already appended", async () => {
    const h = await makeHarness({ "a.md": "a" }, track);

    await runWikiIngest(optionsFor(h));

    const messages: string[] = [];
    const options = {
      ...optionsFor(h, { onProgress: (m: string) => messages.push(m) }),
    };

    await runWikiIngest(options);

    expect(messages.some((m) => m.includes("ignoring dashboard.html"))).toBe(
      false,
    );
  });
});
