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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
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
