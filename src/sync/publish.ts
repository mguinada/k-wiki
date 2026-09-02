import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { listFiles } from "../cli/shared.ts";
import { copyFileTolerant } from "./eagain.ts";
import { compileIncludePattern } from "./projection.ts";

/**
 * The publish stage (guide §26, issue #15): copy the data repo's
 * include-matched files into the mirror vault — an
 * iCloud-served disposable reading copy that iPhone and iPad open in
 * Obsidian. With `root` configured (issue #203) each target path is
 * re-based by stripping that top-level segment; without it the copy
 * is verbatim. The mirror reflects the selected tree exactly: deletions
 * included, drifted bytes rewritten, the mirror's own `.obsidian/`
 * device state never touched. The stage is idempotent — a second run
 * over an intact mirror copies and removes nothing — and heuristic-
 * free: everything it does is a byte comparison plus a copy.
 */

/** What one publish run did to the mirror. */
export interface PublishResult {
  /** Files written (new or byte-different). */
  readonly copied: number;
  /** Mirror files deleted because the source no longer has them. */
  readonly removed: number;
}

export interface PublishOptions {
  /** Source root; the include patterns are relative to it. */
  readonly dataRoot: string;
  /** Mirror vault root; created when missing. */
  readonly mirror: string;
  /** Allowlist patterns (`*` within, `**` across path segments). */
  readonly include: readonly string[];
  /** Top-level source segment stripped from every selected file's
   *  mirror target path (issue #203): `wiki/index.md` publishes as
   *  `index.md`, so the mirror vault shows the wiki tree at root.
   *  Undefined = verbatim copy (the issue #15 behavior). */
  readonly root?: string | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

/** Directories never walked on either side of the copy: repository
 *  plumbing and Obsidian state (device-side in the mirror, an
 *  external writer on the source side). */
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);

/** Files never published and never treated as mirror content. */
const SKIP_FILES = new Set([".DS_Store"]);

/** Collect every publishable file under `root` as
 *  `<relative path> -> <absolute path>`. Both walked roots exist by
 *  the time this runs: the mirror is created first, the data repo is
 *  the raw dir's parent. */
async function walkFiles(
  root: string,
  files: Map<string, string>,
): Promise<void> {
  for (const relPath of await listFiles(root, "", {
    skipDirs: SKIP_DIRS,
    skipFiles: SKIP_FILES,
  })) {
    files.set(relPath, join(root, relPath));
  }
}

/** Whether both paths exist and hold identical bytes. */
async function sameBytes(source: string, target: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([readFile(source), readFile(target)]);

    return a.equals(b);
  } catch {
    return false;
  }
}

/** Delete one mirror file and prune the directories its removal left
 *  empty, up to (not including) the mirror root. */
async function removeAndPrune(mirror: string, absPath: string): Promise<void> {
  await rm(absPath);

  let dir = dirname(absPath);

  while (dir !== mirror) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }

    dir = dirname(dir);
  }
}

/** Delete every mirror file the selected source set no longer has. */
async function removeStale(
  mirror: string,
  selected: ReadonlyMap<string, unknown>,
): Promise<number> {
  const mirrorFiles = new Map<string, string>();

  await walkFiles(mirror, mirrorFiles);

  let removed = 0;

  for (const [relPath, absPath] of mirrorFiles) {
    if (!selected.has(relPath)) {
      await removeAndPrune(mirror, absPath);
      removed += 1;
    }
  }

  return removed;
}

/** The mirror-target path for one selected source file: the source
 *  path with the configured root segment stripped (issue #203); files
 *  without the prefix pass through unchanged. */
function rebase(relPath: string, root: string | undefined): string {
  if (root === undefined || !relPath.startsWith(`${root}/`)) {
    return relPath;
  }

  return relPath.slice(root.length + 1);
}

/** Copy every selected source file into the mirror — but only those
 *  missing there or holding different bytes. */
async function copySelected(
  selected: ReadonlyMap<string, string>,
  mirror: string,
): Promise<number> {
  let copied = 0;

  for (const [relPath, absPath] of selected) {
    const target = join(mirror, relPath);

    if (await sameBytes(absPath, target)) {
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFileTolerant(absPath, target);
    copied += 1;
  }

  return copied;
}

/**
 * One publish run: select the data repo's files by the include
 * patterns, delete the mirror's stale files (device state excepted),
 * and copy the rest verbatim — only files whose bytes differ.
 */
export async function runPublishStage(
  options: PublishOptions,
): Promise<PublishResult> {
  const onProgress = options.onProgress ?? (() => {});
  const mirror = resolve(options.mirror);
  const matchers = options.include.map(compileIncludePattern);
  const all = new Map<string, string>();

  await walkFiles(options.dataRoot, all);

  const selected = new Map(
    [...all]
      .filter(([relPath]) => matchers.some((matcher) => matcher.test(relPath)))
      .map(([relPath, absPath]) => [rebase(relPath, options.root), absPath]),
  );

  onProgress(
    `wiki-sync: publish — ${selected.size} files selected for ${mirror}`,
  );

  await mkdir(mirror, { recursive: true });
  const removed = await removeStale(mirror, selected);
  const copied = await copySelected(selected, mirror);

  onProgress(`wiki-sync: publish — ${copied} copied, ${removed} removed`);

  return { copied, removed };
}
