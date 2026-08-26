import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../data/git.ts";
import { listWikiPages, parsePageFields } from "../wiki/pages.ts";
import { extractWikilinks, listFiles } from "../wiki-links.ts";
import type {
  AdditionFact,
  CommitFact,
  DashboardInput,
  PageSnapshot,
} from "./kpis.ts";

/**
 * Dashboard collection (issue #73): the thin I/O layer that reads the
 * data repo's existing artifacts — wiki pages and wikilinks, the raw
 * manifest, the ingest snapshot, git history, last-query.md — and
 * returns the pure DashboardInput the KPI functions compute from.
 * Reads only; the generator's single write is dashboard.html.
 */

/** Read a file's text, or undefined when it does not exist. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/** The scalar value of a top-level frontmatter key; null when absent. */
function scalarField(text: string, key: string): string | null {
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    return null;
  }

  const closing = lines.indexOf("---", 1);

  for (const line of lines.slice(1, closing === -1 ? undefined : closing)) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line);

    if (match !== null) {
      const value = match[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

      return value === "" ? null : value;
    }
  }

  return null;
}

/** Every wiki page as a PageSnapshot; empty when wiki/ is missing. */
async function collectPages(wikiRoot: string): Promise<PageSnapshot[]> {
  let files: string[];

  try {
    files = await listWikiPages(wikiRoot);
  } catch {
    return [];
  }

  const pages: PageSnapshot[] = [];

  for (const file of files) {
    const text = (await readText(join(wikiRoot, file))) ?? "";
    const fields = parsePageFields(text);

    pages.push({
      path: file,
      title:
        fields.title ?? file.split("/").pop()?.replace(/\.md$/, "") ?? file,
      type: fields.type ?? "unset",
      updated: scalarField(text, "updated"),
      status: scalarField(text, "status"),
      sourcesCount: fields.sources.length,
      outbound: extractWikilinks(text).map((link) => link.target),
    });
  }

  return pages;
}

/** `<vault>/<vault-relative path>` of every raw note file. */
async function collectRawNoteKeys(dataRoot: string): Promise<string[]> {
  const notesRoot = join(dataRoot, "raw", "notes");
  let namespaces: readonly Dirent[];

  try {
    namespaces = await readdir(notesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const keys: string[] = [];

  for (const namespace of namespaces) {
    // Files at the notes root (notes/.gitkeep) are not vault dirs.
    if (!namespace.isDirectory()) {
      continue;
    }

    for (const rel of await listFiles(join(notesRoot, namespace.name))) {
      if (rel.endsWith(".md")) {
        keys.push(`${namespace.name}/${rel}`);
      }
    }
  }

  return keys.sort();
}

/** Snapshot keys of ingested sources; null when no snapshot exists. */
async function collectIngestedKeys(dataRoot: string): Promise<string[] | null> {
  const text = await readText(
    join(dataRoot, "outputs", "last-ingested-manifest.json"),
  );

  if (text === undefined) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const vaults =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { vaults?: unknown }).vaults
      : undefined;

  if (typeof vaults !== "object" || vaults === null) {
    return null;
  }

  const keys: string[] = [];

  for (const [vault, notes] of Object.entries(
    vaults as Record<string, unknown>,
  )) {
    if (typeof notes !== "object" || notes === null) {
      continue;
    }

    for (const rel of Object.keys(notes)) {
      keys.push(`${vault}/${rel}`);
    }
  }

  return keys;
}

/** The newest last_synced of the raw manifest; null when absent. */
async function collectLastSync(dataRoot: string): Promise<string | null> {
  const text = await readText(join(dataRoot, "raw", "manifest.json"));

  if (text === undefined) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const vaults =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { vaults?: unknown }).vaults
      : undefined;

  if (typeof vaults !== "object" || vaults === null) {
    return null;
  }

  let newest: string | null = null;

  for (const notes of Object.values(vaults as Record<string, unknown>)) {
    if (typeof notes !== "object" || notes === null) {
      continue;
    }

    for (const entry of Object.values(notes as Record<string, unknown>)) {
      const stamp =
        typeof entry === "object" && entry !== null
          ? (entry as { last_synced?: unknown }).last_synced
          : undefined;

      if (typeof stamp === "string" && (newest === null || stamp > newest)) {
        newest = stamp;
      }
    }
  }

  return newest;
}

/** The timestamp recorded in outputs/last-query.md; null when absent. */
async function collectLastQuery(dataRoot: string): Promise<string | null> {
  const text = await readText(join(dataRoot, "outputs", "last-query.md"));

  if (text === undefined) {
    return null;
  }

  return /^timestamp: "(.+)"$/m.exec(text)?.[1] ?? null;
}

/** A git command's stdout, or undefined when git fails. */
async function tryGit(
  dataRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    return (await runGit(dataRoot, args, env)).stdout;
  } catch {
    return undefined;
  }
}

/** Commit facts (date + subject) from the git log, newest first. */
async function collectCommits(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<CommitFact[]> {
  const log = await tryGit(
    dataRoot,
    ["log", "-n", "2000", "--format=%as %s"],
    env,
  );

  if (log === undefined) {
    return [];
  }

  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => ({
      date: line.slice(0, 10),
      subject: line.slice(11),
    }));
}

/** First-add facts for wiki pages, from git history. */
async function collectFirstAdded(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<AdditionFact[]> {
  const log = await tryGit(
    dataRoot,
    [
      "log",
      "--diff-filter=A",
      "--no-renames",
      "--format=A%as",
      "--name-only",
      "--",
      "wiki",
    ],
    env,
  );

  if (log === undefined) {
    return [];
  }

  const additions: AdditionFact[] = [];
  let date: string | undefined;

  for (const line of log.split("\n")) {
    if (line.startsWith("A")) {
      date = line.slice(1);

      continue;
    }

    if (line !== "" && date !== undefined && line.endsWith(".md")) {
      additions.push({ path: line, date });
    }
  }

  return additions;
}

/** Read every artifact the dashboard consumes into one pure input. */
export async function collectData(
  dataRoot: string,
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    now?: (() => Date) | undefined;
  } = {},
): Promise<DashboardInput> {
  const env = options.env ?? process.env;

  return {
    now: options.now?.() ?? new Date(),
    head:
      (await tryGit(dataRoot, ["rev-parse", "--short", "HEAD"], env))?.trim() ??
      "",
    pages: await collectPages(join(dataRoot, "wiki")),
    rawNoteKeys: await collectRawNoteKeys(dataRoot),
    ingestedKeys: await collectIngestedKeys(dataRoot),
    lastSync: await collectLastSync(dataRoot),
    commits: await collectCommits(dataRoot, env),
    firstAdded: await collectFirstAdded(dataRoot, env),
    lastQuery: await collectLastQuery(dataRoot),
  };
}
