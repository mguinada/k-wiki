import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildWorkspace,
  cleanupWorkspaces,
  INGEST_SCRIPT,
  runCli,
  SYNC_SCRIPT,
} from "./helpers.ts";

/**
 * wiki-ingest e2e: the real CLI as a child process, driving a stub
 * agent through the full lifecycle — first run (full prompt), changed
 * source (incremental prompt), no change (skip). The stub receives the
 * exact argv the real agent would (pi flags from settings.yml), writes
 * wiki pages like the real agent, and records the composed prompt so
 * the tests can assert what the agent actually saw. A real LLM run
 * stays a human check (issue #11 acceptance): it costs money and is
 * not deterministic.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all([
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    cleanupWorkspaces(),
  ]);
});

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The stub agent: an executable script (shebang) so settings.yml can
 * name it as the command — it receives the exact argv the real agent
 * would (pi flags from settings.yml). It records the --print payload
 * under outputs/ (the wrapper's whitelist) and updates the wiki like
 * the real agent would, §9 frontmatter included, so the post-run
 * guardrails pass. On an expunge prompt it deletes the seeded wiki
 * pages for the removed note. Exits 3 when the payload is missing —
 * the wrapper must pass the prompt.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await mkdir(join(process.cwd(), "outputs"), { recursive: true });
await writeFile(join(process.cwd(), "outputs", "stub-prompt.txt"), prompt);
await writeFile(
  join(process.cwd(), "outputs", "stub-argv.txt"),
  process.argv.slice(2).join("\\n"),
);
await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await writeFile(
  join(process.cwd(), "wiki", "concepts", "stub.md"),
  [
    "---",
    'title: "Stub"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[index]]"',
    "---",
    "",
    "stub body",
    "",
  ].join("\\n"),
);

if (prompt.includes("deleted from the vault")) {
  await rm(join(process.cwd(), "wiki", "sources", "temp-research.md"));
  await rm(join(process.cwd(), "wiki", "concepts", "cites.md"));
  await writeFile(
    join(process.cwd(), "wiki", "index.md"),
    [
      "---",
      'title: "Index"',
      "type: topic",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "sources:",
      '  - "[[index]]"',
      "---",
      "",
      "# Index v3",
      "",
    ].join("\\n"),
  );
  console.log("stub agent: expunge run; claims removed; 2 pages deleted; 0 contradictions dissolved; 0 queries expunged; threshold: surgical pass");
} else {
  await writeFile(
    join(process.cwd(), "wiki", "index.md"),
    [
      "---",
      'title: "Index"',
      "type: topic",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "sources:",
      '  - "[[index]]"',
      "---",
      "",
      "# Index v2",
      "",
    ].join("\\n"),
  );
  console.log("stub agent: sources processed; no contradictions; no unresolved questions");
}
`;

interface Repo {
  readonly dataRoot: string;
  readonly outputsDir: string;
  readonly settingsPath: string;
}
/** A temp data repo: git-tracked wiki/, raw/manifest.json, stub agent.
 *  The wrapper's outputs dir is a separate temp dir (issue #112), so
 *  the snapshot landing in <dataRoot>/outputs/ proves it follows the
 *  data repo, not --outputs. */
async function makeRepo(notes: Record<string, string>): Promise<Repo> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-ingest-e2e-"));
  const outputsDir = await mkdtemp(
    join(tmpdir(), "k-wiki-ingest-e2e-outputs-"),
  );

  tempDirs.push(dataRoot, outputsDir);

  const manifest = {
    vaults: {
      Engineering: Object.fromEntries(
        Object.entries(notes).map(([path, content]) => [
          path,
          { hash: hashOf(content), last_synced: "2026-08-20T00:00:00.000Z" },
        ]),
      ),
    },
  };

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

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

  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { dataRoot, outputsDir, settingsPath };
}

function ingest(repo: Repo) {
  return runCli(INGEST_SCRIPT, [
    "--settings",
    repo.settingsPath,
    "--outputs",
    repo.outputsDir,
    join(repo.dataRoot, "raw"),
  ]);
}

/** The snapshot's home since #112: the data repo's outputs/, never
 *  the --outputs dir. */
const snapshotAt = (dataRoot: string) =>
  join(dataRoot, "outputs", "last-ingested-manifest.json");

async function setNotes(repo: Repo, notes: Record<string, string>) {
  const manifest = {
    vaults: {
      Engineering: Object.fromEntries(
        Object.entries(notes).map(([path, content]) => [
          path,
          { hash: hashOf(content), last_synced: "2026-08-20T01:00:00.000Z" },
        ]),
      ),
    },
  };

  await writeFile(
    join(repo.dataRoot, "raw", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

describe("wiki-ingest e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(INGEST_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: wiki-ingest/);
  });

  it("runs the agent headless on a first ingest and digests it", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });
    const result = await ingest(repo);

    expect(`${result.code}|${result.out}${result.err}`).toMatch(
      /0\|[\s\S]*Wiki ingest digest/,
    );
    expect(result.out).toContain("stub-agent.mjs");
    expect(result.out).toContain("`E2E-MODEL`");
    expect(result.out).toContain("`low`");
    expect(result.out).toContain("**Mode:** full");

    const prompt = await readFile(
      join(repo.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("You are maintaining a structured knowledge wiki");
    expect(prompt).not.toContain(
      "Changed sources since the previous ingestion",
    );
  });

  it("passes the pi isolation flags on the child argv", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    await ingest(repo);

    const argv = (
      await readFile(join(repo.dataRoot, "outputs", "stub-argv.txt"), "utf8")
    ).split("\n");

    expect(argv.slice(0, 3)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
    ]);
  });

  it("persists the digest and the manifest snapshot", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });
    const result = await ingest(repo);
    const runsDir = join(repo.outputsDir, "runs");
    const { readdir } = await import("node:fs/promises");
    const digests = (await readdir(runsDir)).filter((name) =>
      name.endsWith(".md"),
    );
    const [digestName] = digests;

    expect(digests).toHaveLength(1);

    if (digestName === undefined) {
      throw new Error("no digest written");
    }

    expect(digestName).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+Z\.md$/,
    );
    expect(result.out.trimEnd()).toBe(
      (await readFile(join(runsDir, digestName), "utf8")).trimEnd(),
    );

    const snapshot = await readFile(snapshotAt(repo.dataRoot), "utf8");

    expect(snapshot).toContain(hashOf("rag"));

    // Post-ingest hook (issue #73): the dashboard regenerates after a
    // successful run, stamped with the data repo HEAD.
    const dashboard = await readFile(
      join(repo.dataRoot, "dashboard.html"),
      "utf8",
    );

    expect(dashboard.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(dashboard).toContain(
      (
        await run("git", ["-C", repo.dataRoot, "rev-parse", "--short", "HEAD"])
      ).stdout.trim(),
    );
  });

  it("derives the wiki page counts from the data repo git status", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });
    const result = await ingest(repo);

    expect(result.out).toContain(
      "**Wiki pages:** 1 created, 1 updated, 0 deleted",
    );
    expect(result.out).toContain("- wiki/concepts/stub.md");
    expect(result.out).toContain("- wiki/index.md");
  });

  it("switches to the incremental prompt and names the changed source", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    await ingest(repo);
    await setNotes(repo, { "AI/RAG.md": "rag v2" });

    const result = await ingest(repo);

    expect(result.out).toContain("**Mode:** incremental");
    expect(result.out).toContain("~ Engineering/AI/RAG.md");

    const prompt = await readFile(
      join(repo.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Changed sources since the previous ingestion:");
    expect(prompt).toContain("~ Engineering/AI/RAG.md");
  });

  it("skips the agent when nothing changed since the snapshot", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    await ingest(repo);
    await rm(join(repo.dataRoot, "outputs", "stub-prompt.txt"));

    const result = await ingest(repo);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|wiki-ingest: no changed sources/,
    );

    await expect(
      readFile(join(repo.dataRoot, "outputs", "stub-prompt.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exits 1 and keeps the snapshot when the agent fails", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nprocess.exit(4);\n",
      {
        mode: 0o755,
      },
    );

    const result = await ingest(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("code 4");

    await expect(
      readFile(snapshotAt(repo.dataRoot), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills a stuck agent at --timeout and fails the run", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 120000);\n",
      {
        mode: 0o755,
      },
    );

    const result = await runCli(INGEST_SCRIPT, [
      "--settings",
      repo.settingsPath,
      "--outputs",
      repo.outputsDir,
      "--timeout",
      "5",
      join(repo.dataRoot, "raw"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("timed out after 5 seconds");

    await expect(
      readFile(snapshotAt(repo.dataRoot), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-reverts a run whose changed page has broken frontmatter", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    // A stale dashboard must survive a reverted run untouched (issue
    // #73): the dashboard reflects the last good state.
    await writeFile(join(repo.dataRoot, "dashboard.html"), "STALE\n");

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      [
        "#!/usr/bin/env node",
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });',
        'await writeFile(join(process.cwd(), "wiki", "concepts", "broken.md"), "no frontmatter\\n");',
        'console.log("rogue report");',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await ingest(repo);
    const runsDir = join(repo.outputsDir, "runs");
    const { readdir } = await import("node:fs/promises");
    const digests = (await readdir(runsDir)).filter((name) =>
      name.endsWith(".md"),
    );
    const digest =
      digests.length === 1
        ? await readFile(join(runsDir, digests[0] ?? ""), "utf8")
        : undefined;

    expect(result.code).toBe(1);
    expect(result.err).toContain("guardrail check 2 (frontmatter)");
    expect(digest ?? "").toContain("Check 2 (frontmatter)");
    expect(digest ?? "").toContain("wiki/concepts/broken.md");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "broken.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      readFile(snapshotAt(repo.dataRoot), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(await readFile(join(repo.dataRoot, "dashboard.html"), "utf8")).toBe(
      "STALE\n",
    );
  });

  it("auto-reverts a run that writes into raw/", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      [
        "#!/usr/bin/env node",
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'await mkdir(join(process.cwd(), "raw", "notes"), { recursive: true });',
        'await writeFile(join(process.cwd(), "raw", "notes", "rogue.md"), "tampered\\n");',
        'console.log("rogue report");',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await ingest(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("guardrail check 1 (immutability)");

    await expect(
      readFile(join(repo.dataRoot, "raw", "notes", "rogue.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("wiki-ingest --sources e2e", () => {
  function ingestSources(repo: Repo, ...sources: readonly string[]) {
    const flags = sources.flatMap((source) => ["--sources", source]);

    return runCli(INGEST_SCRIPT, [
      "--settings",
      repo.settingsPath,
      "--outputs",
      repo.outputsDir,
      ...flags,
      join(repo.dataRoot, "raw"),
    ]);
  }

  it("re-ingests explicit sources over an unchanged manifest", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag", "Notes/DSC.md": "dsc" });
    const first = await ingest(repo);

    expect(first.code).toBe(0);

    const snapshotAfterFirst = await readFile(
      snapshotAt(repo.dataRoot),
      "utf8",
    );

    const result = await ingestSources(
      repo,
      "Engineering/Notes/DSC.md",
      "Engineering/AI/RAG.md",
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("**Mode:** incremental");
    expect(result.out).toContain("sources selected explicitly");
    expect(result.out).toContain("~ Engineering/AI/RAG.md");

    const prompt = await readFile(
      join(repo.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Changed sources since the previous ingestion:");
    expect(prompt.split("~ Engineering/AI/RAG.md").length - 1).toBe(1);
    expect(prompt.split("~ Engineering/Notes/DSC.md").length - 1).toBe(1);
    expect(prompt.indexOf("~ Engineering/AI/RAG.md")).toBeLessThan(
      prompt.indexOf("~ Engineering/Notes/DSC.md"),
    );

    const snapshotAfterScoped = await readFile(
      snapshotAt(repo.dataRoot),
      "utf8",
    );

    expect(snapshotAfterScoped).toBe(snapshotAfterFirst);
  });

  it("exits 1 on an unknown --sources path and writes nothing", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });
    const first = await ingest(repo);

    expect(first.code).toBe(0);

    const snapshotAfterFirst = await readFile(
      snapshotAt(repo.dataRoot),
      "utf8",
    );
    const { readdir } = await import("node:fs/promises");
    const runsDir = join(repo.outputsDir, "runs");

    await rm(join(repo.dataRoot, "outputs", "stub-prompt.txt"));

    const result = await ingestSources(repo, "Engineering/Nope.md");

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "unknown --sources path(s): Engineering/Nope.md",
    );

    await expect(
      readFile(join(repo.dataRoot, "outputs", "stub-prompt.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const digests = (await readdir(runsDir)).filter((name) =>
      name.endsWith(".md"),
    );

    expect(digests).toHaveLength(1);
    expect(await readFile(snapshotAt(repo.dataRoot), "utf8")).toBe(
      snapshotAfterFirst,
    );
  });

  it("exits 1 on --sources with no snapshot and writes nothing", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });

    const result = await ingestSources(repo, "Engineering/AI/RAG.md");

    expect(result.code).toBe(1);
    expect(result.err).toContain("run a full ingest first");

    await expect(
      readFile(snapshotAt(repo.dataRoot), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-reverts a scoped run whose changed page has broken frontmatter", async () => {
    const repo = await makeRepo({ "AI/RAG.md": "rag" });
    const first = await ingest(repo);

    expect(first.code).toBe(0);

    const snapshotAfterFirst = await readFile(
      snapshotAt(repo.dataRoot),
      "utf8",
    );

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      [
        "#!/usr/bin/env node",
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });',
        'await writeFile(join(process.cwd(), "wiki", "concepts", "broken.md"), "no frontmatter\\n");',
        'console.log("rogue report");',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await ingestSources(repo, "Engineering/AI/RAG.md");

    expect(result.code).toBe(1);
    expect(result.err).toContain("guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "broken.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(snapshotAt(repo.dataRoot), "utf8")).toBe(
      snapshotAfterFirst,
    );
  });
});

/** The seeded wiki state a previous agent run would have left behind. */
const SEEDED_SOURCE_PAGE = `---
title: Temp research
type: source
origin: raw/notes/Documents/Scratch/temp-research.md
sources:
  - "notes/Documents/Scratch/temp-research.md"
---

Ephemeral scratch note ([[cites]] its findings).
`;

const SEEDED_CONCEPT_PAGE = `---
title: Cites
type: concept
sources:
  - "notes/Documents/Scratch/temp-research.md"
---

Findings from the temp research note.
`;

async function git(dir: string, ...args: string[]): Promise<void> {
  await run("git", [
    "-C",
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    ...args,
  ]);
}

/**
 * A sync-driven data repo: the real fixture vault and sync CLI, a stub
 * agent, and a committed wiki state that cites Scratch/temp-research.md
 * — so the expunge scenario exercises sync → removal detection →
 * ingest routing end to end.
 */
async function makeSyncedRepo(): Promise<{
  readonly dataRoot: string;
  readonly configPath: string;
  readonly rawDir: string;
  readonly settingsPath: string;
}> {
  const ws = await buildWorkspace();
  const dataRoot = ws.dir;

  await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "overview.md"), "# Overview\n");
  await writeFile(
    join(dataRoot, "wiki", "sources", "temp-research.md"),
    SEEDED_SOURCE_PAGE,
  );
  await writeFile(
    join(dataRoot, "wiki", "concepts", "cites.md"),
    SEEDED_CONCEPT_PAGE,
  );
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );
  await git(dataRoot, "init", "--quiet");
  await git(dataRoot, "add", "-A");
  await git(dataRoot, "commit", "--quiet", "-m", "sync + seeded wiki");

  return {
    dataRoot,
    configPath: ws.configPath,
    rawDir: ws.rawDir,
    settingsPath,
  };
}

function ingestSynced(repo: Awaited<ReturnType<typeof makeSyncedRepo>>) {
  return runCli(INGEST_SCRIPT, [
    "--settings",
    repo.settingsPath,
    "--outputs",
    join(repo.dataRoot, "outputs"),
    repo.rawDir,
  ]);
}

describe("wiki-ingest expunge e2e (sync-driven)", () => {
  it("labels the run expunge, digests the direct set and deleted pages, and writes the snapshot", async () => {
    const repo = await makeSyncedRepo();
    const first = await ingestSynced(repo);

    expect(first.code).toBe(0);
    await git(repo.dataRoot, "add", "-A");
    await git(repo.dataRoot, "commit", "--quiet", "-m", "after first ingest");

    await rm(join(repo.dataRoot, "Documents", "Scratch", "temp-research.md"));
    const sync = await runCli(SYNC_SCRIPT, [repo.configPath, repo.rawDir]);

    expect(sync.code).toBe(0);

    const result = await ingestSynced(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("# Wiki ingest digest (expunge)");
    expect(result.out).toContain("**Mode:** expunge");
    expect(result.out).toContain("## Expunge direct set");
    expect(result.out).toContain("- wiki/concepts/cites.md");
    expect(result.out).toContain("- wiki/sources/temp-research.md");
    expect(result.out).toContain("- wiki/index.md");
    expect(result.out).toContain("Deleted:");
    expect(result.out).toContain("- wiki/concepts/cites.md");
    expect(result.err).toContain("wiki-ingest: expunge — 1 removed source");

    const prompt = await readFile(
      join(repo.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("deleted from the vault");
    expect(prompt).toContain(
      "### Documents/Scratch/temp-research.md (raw/notes/Documents/Scratch/temp-research.md)",
    );
    expect(prompt).toContain("Ephemeral note");
    expect(prompt).toContain("- wiki/sources/temp-research.md");

    const snapshot = await readFile(snapshotAt(repo.dataRoot), "utf8");

    expect(snapshot).not.toContain("Scratch/temp-research.md");
  });

  it("treats a same-content rename as a change, not an expunge", async () => {
    const repo = await makeSyncedRepo();
    const first = await ingestSynced(repo);

    expect(first.code).toBe(0);
    await git(repo.dataRoot, "add", "-A");
    await git(repo.dataRoot, "commit", "--quiet", "-m", "after first ingest");

    const note = await readFile(
      join(repo.dataRoot, "Documents", "AI", "RAG.md"),
      "utf8",
    );

    await rm(join(repo.dataRoot, "Documents", "AI", "RAG.md"));
    await writeFile(
      join(
        repo.dataRoot,
        "Documents",
        "AI",
        "retrieval-augmented-generation.md",
      ),
      note,
    );

    const sync = await runCli(SYNC_SCRIPT, [repo.configPath, repo.rawDir]);

    expect(sync.code).toBe(0);

    const result = await ingestSynced(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("**Mode:** incremental");
    expect(result.out).not.toContain("**Mode:** expunge");
    expect(result.out).toContain(
      "→ Documents/AI/RAG.md → Documents/AI/retrieval-augmented-generation.md",
    );

    const prompt = await readFile(
      join(repo.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).not.toContain("deleted from the vault");
    expect(prompt).toContain(
      "→ Documents/AI/RAG.md → Documents/AI/retrieval-augmented-generation.md",
    );
  });
});
