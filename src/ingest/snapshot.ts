/**
 * The snapshot domain of one ingest run (issue #258, extracted from
 * wiki-ingest.ts): the last-ingested manifest snapshot — reading it
 * with its instance-stamp guard, adopting a pre-#112 legacy copy,
 * advancing it after a successful run (ordinary and scoped --sources
 * merges) — plus the data repo's gitignore hygiene and the
 * tracked-but-ignored pre-flight warning (issue #146). Orchestration
 * and prompt composition live in the sibling modules.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunContext } from "../cli/run-context.ts";
import { isPlainObject, readTextIfExists } from "../cli/shared.ts";
import { tryGit } from "../data/git.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  type VaultNotes,
  writeManifest,
} from "../sync/manifest.ts";
import { diffManifests, type ManifestDiff } from "./manifest-diff.ts";

/**
 * Read the last-ingested snapshot when it belongs to this data repo.
 * The snapshot is stamped with its data root at write time (issue #95):
 * a stamp that names another instance — or an unstamped legacy
 * snapshot, whose origin is unknowable — is foreign state. Diffing
 * against it would silently mis-shape the change set (worst case a
 * spurious expunge), so warn loudly and return undefined; the caller
 * falls back to the full mode. Missing file: first run, no warning.
 * A scoped `--sources` run (`scoped`) never gets that fallback — the
 * caller rejects instead — so the warning must not promise it
 * (issue #151).
 */
export async function readSnapshot(
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
  scoped: boolean,
): Promise<Manifest | undefined> {
  const text = await readTextIfExists(snapshotPath);

  if (text === undefined) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid manifest at ${snapshotPath}: not valid JSON`, {
      cause,
    });
  }

  const snapshotFor =
    isPlainObject(parsed) && typeof parsed.snapshotFor === "string"
      ? parsed.snapshotFor
      : undefined;

  if (snapshotFor !== dataRoot) {
    const origin =
      snapshotFor === undefined
        ? "has no instance stamp"
        : `is stamped for ${snapshotFor}`;

    const fallback = scoped
      ? ""
      : " and falling back to a full run; the next successful ingest rewrites the snapshot, so this warning will not repeat";

    onProgress(
      `wiki-ingest: WARNING — snapshot ${snapshotPath} ${origin}, not this instance (${dataRoot}); ignoring it${fallback}`,
    );

    return undefined;
  }

  return parseManifest(text, snapshotPath);
}

export const SNAPSHOT_FILENAME = "last-ingested-manifest.json";

/** Append `entry` under `comment` to the data repo's .gitignore;
 *  false when an accepted form of the entry is already present.
 *  Shared by the snapshot and dashboard ignore guards. */
async function appendGitignoreEntry(
  dataRoot: string,
  entry: string,
  accepted: readonly string[],
  comment: string,
): Promise<boolean> {
  const ignorePath = join(dataRoot, ".gitignore");
  const existing = (await readTextIfExists(ignorePath)) ?? "";

  if (existing.split("\n").some((line) => accepted.includes(line.trim()))) {
    return false;
  }

  const body =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;

  await writeFile(ignorePath, `${body}${comment}\n${entry}\n`, "utf8");

  return true;
}

/**
 * Keep the manifest snapshot out of the data repo's history (issue
 * #112): the snapshot is per-instance state, and a commit or clean
 * must never take it. Appends the ignore entry when the data repo's
 * .gitignore lacks it.
 */
export async function ensureSnapshotIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const entry = `outputs/${SNAPSHOT_FILENAME}`;

  if (
    await appendGitignoreEntry(
      dataRoot,
      entry,
      [entry],
      "# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)",
    )
  ) {
    onProgress(
      `wiki-ingest: ignoring ${entry} in the data repo (${join(dataRoot, ".gitignore")}) so no commit or clean can take the snapshot`,
    );
  }
}

/**
 * Keep the regenerated dashboard out of the data repo's history
 * (issue #73): dashboard.html is per-checkout derived output, and a
 * bare `git add .` must never commit it. Appends the ignore entry
 * when the data repo's .gitignore lacks it.
 */
export async function ensureDashboardIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const entry = "dashboard.html";

  if (
    await appendGitignoreEntry(
      dataRoot,
      entry,
      [entry, `/${entry}`],
      "# static dashboard: regenerated per checkout, never committed (issue #73)",
    )
  ) {
    onProgress(
      `wiki-ingest: ignoring ${entry} in the data repo (${join(dataRoot, ".gitignore")})`,
    );
  }
}

/**
 * Adopt a pre-#112 snapshot into the data repo: the snapshot is
 * per-instance state and now lives in the data repo's outputs/ —
 * the code repo's outputs/ is gitignored, shared by every worktree,
 * and cleanable. The copy is byte-for-byte, so the snapshotFor
 * stamp check still guards wrong-root snapshots, foreign or
 * unstamped alike. A data-repo snapshot always wins; the legacy
 * file is left in place, harmless where it is.
 */
export async function adoptLegacySnapshot(
  legacyPath: string,
  snapshotPath: string,
  onProgress: (message: string) => void,
): Promise<void> {
  if ((await readTextIfExists(snapshotPath)) !== undefined) {
    return;
  }

  if ((await readTextIfExists(legacyPath)) === undefined) {
    return;
  }

  await mkdir(dirname(snapshotPath), { recursive: true });
  await copyFile(legacyPath, snapshotPath);
  onProgress(
    `wiki-ingest: adopting legacy snapshot from ${legacyPath} into the data repo (${snapshotPath})`,
  );
}

/**
 * Pre-flight signal (issue #146): a tracked file that matches an
 * ignore rule is the external-writer guardrail-1 hazard — gitignore
 * does not apply to tracked files, so the rule covers nothing and an
 * outside writer (the operator's open Obsidian) trips the
 * immutability check and reverts runs. One warning per file, each
 * naming its fix; a signal, not a gate. Runs after
 * ensureSnapshotIgnored so a tracked snapshot is flagged too.
 */
export async function warnTrackedIgnored(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  onProgress: (message: string) => void,
): Promise<void> {
  const stdout = await tryGit(
    dataRoot,
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--ignored",
      "--exclude-standard",
      "--cached",
    ],
    env,
  );

  if (stdout === undefined) {
    return;
  }

  for (const path of stdout.split("\n").filter(Boolean)) {
    onProgress(
      `wiki-ingest: WARNING — ${path} is tracked but ignored; the rule covers nothing, and an external writer changing it will trip guardrail 1 — untrack it: git rm --cached ${path}`,
    );
  }
}

/** The snapshot a successful scoped `--sources` run writes (issue
 *  #150): the previous snapshot with every explicit path's current
 *  entry merged in — the scoped run's processing is recorded, while
 *  pending changes outside the explicit set survive for the next
 *  ordinary run. Rewriting the full current manifest instead would
 *  mark those changes processed without the agent ever seeing them. */
function mergedSnapshot(
  previous: Manifest,
  current: Manifest,
  explicitDiff: ManifestDiff,
): Manifest {
  const vaults: Record<string, VaultNotes> = {};

  for (const [vault, notes] of Object.entries(previous.vaults)) {
    vaults[vault] = { ...notes };
  }

  for (const change of explicitDiff.vaults) {
    const currentNotes = current.vaults[change.vault] ?? {};
    const merged = vaults[change.vault] ?? {};

    for (const path of change.changed) {
      const entry = currentNotes[path];

      if (entry !== undefined) {
        merged[path] = entry;
      }
    }

    vaults[change.vault] = merged;
  }

  return { vaults };
}

/** The held-back progress line of a successful scoped run (issue
 *  #150), or undefined when nothing outside `--sources` is pending:
 *  the snapshot-vs-current change counts the merged snapshot leaves
 *  for the next ordinary run. */
function heldBackMessage(
  previous: Manifest,
  current: Manifest,
  explicitDiff: ManifestDiff,
): string | undefined {
  const explicit = new Set(
    explicitDiff.vaults.flatMap((change) =>
      change.changed.map((path) => `${change.vault}/${path}`),
    ),
  );
  const pending = diffManifests(previous, current);
  const counts = { added: 0, changed: 0, renamed: 0, removed: 0 };

  for (const vault of pending.vaults) {
    counts.added += vault.added.filter(
      (path) => !explicit.has(`${vault.vault}/${path}`),
    ).length;
    counts.changed += vault.changed.filter(
      (path) => !explicit.has(`${vault.vault}/${path}`),
    ).length;
    const covered = vault.renamed.filter((rename) =>
      explicit.has(`${vault.vault}/${rename.to}`),
    );

    counts.renamed += vault.renamed.length - covered.length;
    counts.removed += vault.removed.length + covered.length;
  }

  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);

  if (parts.length === 0) {
    return undefined;
  }

  return `wiki-ingest: scoped run held back pending changes outside --sources (${parts.join(", ")}) — the merged snapshot leaves them for the next ordinary run`;
}

/** Advance the manifest snapshot after a successful run (issue
 *  #150): an ordinary run records the full current manifest; a
 *  scoped `--sources` run writes a merged snapshot — the previous
 *  snapshot plus the explicit paths' current entries — so its
 *  processing is recorded while pending changes outside the list
 *  survive for the next ordinary run, announced with a held-back
 *  progress line when any are skipped. */
export async function writeSnapshotIfNeeded(
  run: RunContext,
  explicitDiff: ManifestDiff | undefined,
  previous: Manifest | undefined,
  snapshotPath: string,
  current: Manifest,
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true });

  if (explicitDiff === undefined) {
    await writeManifest(snapshotPath, current, { snapshotFor: run.dataRoot });

    return;
  }

  const base = previous ?? emptyManifest();
  const message = heldBackMessage(base, current, explicitDiff);

  if (message !== undefined) {
    run.onProgress(message);
  }

  await writeManifest(
    snapshotPath,
    mergedSnapshot(base, current, explicitDiff),
    { snapshotFor: run.dataRoot },
  );
}
