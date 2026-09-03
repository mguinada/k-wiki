/**
 * Shared unit-test fixtures for the ingest domain (issue #258's
 * split of wiki-ingest.test.ts): the pure manifest builders and the
 * git-backed data-repo factory every split suite needs. Temp dirs
 * are tracked through the caller's `track` callback — each test file
 * owns its tempDirs array and its afterAll cleanup, so suites stay
 * independent however the pool schedules them.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type RunContextInput, runContext } from "../../src/cli/run-context.ts";
import type { AgentRunner } from "../../src/ingest/agent-run.ts";
import {
  type Manifest,
  serializeManifest,
  type VaultNotes,
} from "../../src/sync/manifest.ts";

export const run = promisify(execFile);

export type Track = (dir: string) => void;

export function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function manifestWith(vault: string, notes: VaultNotes): Manifest {
  return { vaults: { [vault]: notes } };
}

export function entry(content: string) {
  return { hash: hashOf(content), last_synced: "2026-08-20T00:00:00.000Z" };
}

/** A data repo: raw/ with a manifest and note files, wiki/ with pages, committed to git. */
export async function makeDataRepo(
  notes: Record<string, string>,
  track: Track,
): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-ingest-"));

  track(dataRoot);

  const manifest = manifestWith(
    "Engineering",
    Object.fromEntries(
      Object.entries(notes).map(([path, content]) => [path, entry(content)]),
    ),
  );

  await mkdir(join(dataRoot, "raw", "notes", "Engineering"), {
    recursive: true,
  });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });

  for (const [path, content] of Object.entries(notes)) {
    await writeFile(
      join(dataRoot, "raw", "notes", "Engineering", path),
      content,
    );
  }

  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    serializeManifest(manifest),
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(
    join(dataRoot, "wiki", "sources", "src.md"),
    "---\ntitle: Src\ntype: source\ncreated: 2026-08-20\nupdated: 2026-08-20\ntags:\n  - source\norigin: raw/notes/Engineering/a.md\n---\nHub.\n",
  );
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

/** Commit every change in a data repo, as a sync cycle would. */
export async function commitAll(
  dataRoot: string,
  message: string,
): Promise<void> {
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
    message,
  ]);
}

/** A wiki tree with an origin page, citing pages, and noise. */
export async function makeExpungeWiki(track: Track): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-seed-"));

  track(root);

  const wikiRoot = join(root, "wiki");
  const files: Record<string, string> = {
    "sources/Temp research.md":
      "---\ntitle: Temp research\ntype: source\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
    "sources/prefixless.md":
      "---\ntitle: Prefixless\ntype: source\norigin: notes/V/Other/note.md\n---\nbody",
    "sources/tricky.md":
      "---\ntitle: Tricky\ntype: source\norigin: notes/V/raw/a.md\n---\nbody",
    "concepts/cites.md":
      '---\ntitle: Cites\nsources:\n  - "notes/V/Scratch/temp.md"\n---\nbody',
    "concepts/other.md":
      '---\ntitle: Other\nsources:\n  - "notes/V/AI/rag.md"\n---\nbody',
    "concepts/ignore-wikilink.md":
      '---\ntitle: Ignores\nsources:\n  - "[[Prefixless]]"\n---\nbody',
    "queries/q.md":
      '---\ntitle: Q\ntype: query\nsources:\n  - "[[Temp research]]"\n---\nbody',
    "index.md": "# Index",
    "overview.md": "# Overview",
  };

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(wikiRoot, dirname(file)), { recursive: true });
    await writeFile(join(wikiRoot, file), content);
  }

  return wikiRoot;
}

export const SETTINGS_YML = `# Agent configuration (issue #11).
command: pi
model: GLM-5.2 # trailing comment
reasoning: "high"
`;

/** A wiki page body with valid §9 frontmatter (guardrail 2 must pass). */
export function wikiPage(body: string): string {
  return [
    "---",
    'title: "Page"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[src]]"',
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** The guardrail-2 saboteur: writes frontmatter-free pages, reports success. */
export function frontmatterSaboteur(...pages: string[]): AgentRunner {
  return async (_command, _args, options) => {
    for (const page of pages) {
      await writeFile(join(options.cwd, "wiki", page), "no frontmatter\n");
    }

    return { stdout: "rogue report", stderr: "" };
  };
}

export interface Harness {
  readonly dataRoot: string;
  readonly outputsDir: string;
  /** The snapshot's home since #112: the data repo's outputs/. */
  readonly snapshotPath: string;
  /** The pre-#112 snapshot location (the wrapper's outputs dir). */
  readonly legacySnapshotPath: string;
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
export async function makeHarness(
  notes: Record<string, string>,
  track: Track,
): Promise<Harness> {
  const dataRoot = await makeDataRepo(notes, track);
  // The wrapper's outputs dir is NOT the data repo's (issue #112): a
  // separate temp dir proves the snapshot follows the data repo while
  // digests stay with the wrapper.
  const outputsDir = await mkdtemp(join(tmpdir(), "k-wiki-ingest-outputs-"));

  track(outputsDir);

  const promptsDir = join(dataRoot, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "ingest.md"), "FULL PROMPT");
  await writeFile(join(promptsDir, "incremental.md"), "INCREMENTAL PROMPT");
  await writeFile(join(promptsDir, "expunge.md"), "EXPUNGE PROMPT");

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(settingsPath, SETTINGS_YML);

  const invocations: Harness["invocations"] = [];
  const runAgent: AgentRunner = async (command, args, options) => {
    invocations.push({ command, args, cwd: options.cwd });
    await mkdir(join(options.cwd, "wiki", "concepts"), { recursive: true });
    await writeFile(
      join(options.cwd, "wiki", "concepts", "new.md"),
      wikiPage("New"),
      { flag: "wx" },
    ).catch(() => {});
    await writeFile(
      join(options.cwd, "wiki", "index.md"),
      wikiPage("# Index v2"),
    );
    await writeFile(
      join(options.cwd, "wiki", "A-page.md"),
      wikiPage("# A page v2"),
    );
    await rm(join(options.cwd, "wiki", "gone.md")).catch(() => {});

    return { stdout: "agent final report", stderr: "" };
  };

  return {
    dataRoot,
    outputsDir,
    snapshotPath: join(dataRoot, "outputs", "last-ingested-manifest.json"),
    legacySnapshotPath: join(outputsDir, "last-ingested-manifest.json"),
    promptsDir,
    settingsPath,
    invocations,
    runAgent,
  };
}

/** The ingest options for `h`, with optional run-context overrides
 *  (a recording sink, a controllable clock) folded into the run. */
export function optionsFor(h: Harness, run: Partial<RunContextInput> = {}) {
  return {
    settingsPath: h.settingsPath,
    run: runContext({
      rawDir: join(h.dataRoot, "raw"),
      now: () => new Date("2026-08-20T18:00:00.000Z"),
      ...run,
    }),
    outputsDir: h.outputsDir,
    promptsDir: h.promptsDir,
    runAgent: h.runAgent,
  };
}

/** The file names currently under `dir`, or [] when it does not exist. */
export async function runFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** Undo a test's forced `process.stderr.isTTY`. */
export function restoreStderrTty(prior: PropertyDescriptor | undefined): void {
  if (prior === undefined) {
    delete (process.stderr as { isTTY?: boolean }).isTTY;

    return;
  }

  Object.defineProperty(process.stderr, "isTTY", prior);
}

/** Undo a test's NO_COLOR override. */
export function restoreNoColor(prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env.NO_COLOR;

    return;
  }

  process.env.NO_COLOR = prior;
}

/** The recorded invocation at `index`; fails loudly when absent. */
export function invocation(h: Harness, index: number) {
  const recorded = h.invocations[index];

  if (recorded === undefined) {
    throw new Error(`agent was not invoked (call ${index})`);
  }

  return recorded;
}
