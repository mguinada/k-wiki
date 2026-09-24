/**
 * The snapshot domain of one ingest run (issue #258, extracted from
 * wiki-ingest.ts): the last-ingested manifest snapshot — reading it
 * with its instance-stamp guard, adopting a pre-#112 legacy copy,
 * advancing it after a successful run (ordinary and scoped --sources
 * merges) — plus the data repo's per-instance ignore hygiene for the
 * ingest snapshot, the dashboard, and the cycle lint stage's window
 * snapshot (gitignore and .git/info/exclude through one shared append
 * helper, issue #359), and the tracked-but-ignored pre-flight warning
 * (issue #146). Orchestration and prompt composition live in the
 * sibling modules.
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
 *
 * The committed-head anchor (issue #390): snapshots written in
 * shared-writer mode (and every new snapshot since) record the data
 * repo commit their manifest state was captured at. A snapshot whose
 * anchor is not an ancestor of the current HEAD is foreign history —
 * the exact incident shape where a reset-away snapshot made a
 * re-added raw source look already-ingested — and is ignored like a
 * foreign stamp. An unresolvable anchor fails the same way: the
 * never-use-it direction is the safe one.
 */
export async function readSnapshot(
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
  scoped: boolean,
  env: NodeJS.ProcessEnv = process.env,
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

  if (
    !(await snapshotBelongsToRun(
      parsed,
      snapshotPath,
      dataRoot,
      onProgress,
      scoped,
      env,
    ))
  ) {
    return undefined;
  }

  return parseManifest(text, snapshotPath);
}

/** The instance-stamp and committed-head-anchor guards: both foreign
 *  states ignore the snapshot, so a run never diffs against history
 *  it does not own. False means the snapshot must be ignored. */
async function snapshotBelongsToRun(
  parsed: unknown,
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
  scoped: boolean,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (
    !(await stampedForThisInstance(
      parsed,
      snapshotPath,
      dataRoot,
      onProgress,
      scoped,
    ))
  ) {
    return false;
  }

  return await anchoredInThisHistory(
    parsed,
    snapshotPath,
    dataRoot,
    onProgress,
    scoped,
    env,
  );
}

/** The instance-stamp guard (issue #95): a snapshot stamped for
 *  another instance — or unstamped — is foreign state. */
async function stampedForThisInstance(
  parsed: unknown,
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
  scoped: boolean,
): Promise<boolean> {
  const snapshotFor =
    isPlainObject(parsed) && typeof parsed.snapshotFor === "string"
      ? parsed.snapshotFor
      : undefined;

  if (snapshotFor === dataRoot) {
    return true;
  }

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

  return false;
}

/** The committed-head-anchor guard (issue #390): a snapshot whose
 *  anchor left the checkout's history is foreign history — the
 *  incident invariant. Unanchored (legacy) snapshots pass. */
async function anchoredInThisHistory(
  parsed: unknown,
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
  scoped: boolean,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const anchor =
    isPlainObject(parsed) && typeof parsed.committedHead === "string"
      ? parsed.committedHead
      : undefined;

  if (anchor === undefined || (await anchorInHistory(dataRoot, anchor, env))) {
    return true;
  }

  const fallback = scoped
    ? ""
    : "; the next successful run rewrites it — this warning will not repeat";

  onProgress(
    `wiki-ingest: WARNING — snapshot ${snapshotPath} is anchored to ${anchor.slice(0, 8)}, which is not in this checkout's history; ignoring it${fallback}`,
  );

  return false;
}

/** True when the anchor commit is an ancestor of (or equal to) the
 *  current HEAD. A git failure (unresolvable object after a reset,
 *  no commits yet) counts as not-in-history — fail closed. */
async function anchorInHistory(
  dataRoot: string,
  anchor: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const stdout = await tryGit(
    dataRoot,
    ["merge-base", "--is-ancestor", anchor, "HEAD"],
    env,
  );

  return stdout !== undefined;
}

export const SNAPSHOT_FILENAME = "last-ingested-manifest.json";

/** Keep the lint-window snapshot out of the data repo's history
 *  (issue #359): the snapshot is per-instance state — a commit or
 *  clean must never take it. The entries live in .git/info/exclude:
 *  untracked, never committed, re-applied by every run so fresh
 *  clones self-heal. */
export async function ensureLintWindowIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const entries = ["outputs/lint-window.json", "outputs/lint-window.json.tmp"];

  if (
    await appendIgnoreEntries(
      join(dataRoot, ".git", "info", "exclude"),
      "# lint window snapshot: per-instance state, never committed (issue #359)",
      entries.map((entry) => [entry, [entry]] as const),
    )
  ) {
    onProgress(
      `wiki-sync: excluding the lint window (${entries[0]}) via ${join(dataRoot, ".git", "info", "exclude")} so no commit or clean can take it`,
    );
  }
}

/** Keep the scheduled cycle's heartbeat state out of the data
 *  repo's history (issue #362): the cycle stamp is per-instance
 *  state written by every completed cycle, the watchdog's install
 *  anchor by setup-schedule — a commit or clean must never take
 *  either. Same home as the lint window (.git/info/exclude),
 *  re-applied on every write so fresh clones self-heal. */
export async function ensureHeartbeatIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const entries = [
    "outputs/last-cycle.json",
    "outputs/last-cycle.json.tmp",
    "outputs/watchdog-since.txt",
    "outputs/watchdog-since.txt.tmp",
  ];

  if (
    await appendIgnoreEntries(
      join(dataRoot, ".git", "info", "exclude"),
      "# cycle heartbeat: per-instance state, never committed (issue #362)",
      entries.map((entry) => [entry, [entry]] as const),
    )
  ) {
    onProgress(
      `excluding the heartbeat state (${entries[0]}, ${entries[2]}) via ${join(dataRoot, ".git", "info", "exclude")} so no commit or clean can take it`,
    );
  }
}

/** Append the absent entries under `comment` to the ignore file at
 *  `path`, creating the parent directory; false when every entry is
 *  already present. An entry is present when some line trim-matches
 *  one of its accepted forms. The one append helper for the data
 *  repo's per-instance ignore files — .gitignore and
 *  .git/info/exclude — so their append semantics cannot drift.
 *  Exported for the shared-writer receipt's per-machine ignore entry
 *  (issue #390): same file, same semantics, one implementation. */
export async function appendIgnoreEntries(
  path: string,
  comment: string,
  entries: readonly (readonly [string, readonly string[]])[],
): Promise<boolean> {
  const existing = (await readTextIfExists(path)) ?? "";
  const lines = existing.split("\n").map((line) => line.trim());
  const absent = entries
    .filter(([, accepted]) => !lines.some((line) => accepted.includes(line)))
    .map(([line]) => line);

  if (absent.length === 0) {
    return false;
  }

  await mkdir(dirname(path), { recursive: true });

  const body =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;

  await writeFile(path, `${body}${comment}\n${absent.join("\n")}\n`, "utf8");

  return true;
}

/** The data repo's .gitignore path. */
function gitignorePath(dataRoot: string): string {
  return join(dataRoot, ".gitignore");
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
    await appendIgnoreEntries(
      gitignorePath(dataRoot),
      "# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)",
      [[entry, [entry]]],
    )
  ) {
    onProgress(
      `wiki-ingest: ignoring ${entry} in the data repo (${gitignorePath(dataRoot)}) so no commit or clean can take the snapshot`,
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
    await appendIgnoreEntries(
      join(dataRoot, ".git", "info", "exclude"),
      "# static dashboard: regenerated per checkout, never committed (issue #73; per-machine exclude — issue #390's shared-writer cycles refuse a dirty tracked .gitignore)",
      [[entry, [entry, `/${entry}`]]],
    )
  ) {
    onProgress(
      `wiki-ingest: ignoring ${entry} in the data repo (${join(dataRoot, ".git", "info", "exclude")})`,
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
 *  progress line when any are skipped.
 *
 *  Every snapshot is anchored to the data repo's current head
 *  (issue #390's committed-head anchor): the reader refuses any
 *  snapshot whose anchor left the checkout's history — the incident
 *  invariant that a reset-away snapshot can never make a re-added
 *  source look already-ingested. */
export async function writeSnapshotIfNeeded(
  run: RunContext,
  explicitDiff: ManifestDiff | undefined,
  previous: Manifest | undefined,
  snapshotPath: string,
  current: Manifest,
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true });

  const head = await tryGit(run.dataRoot, ["rev-parse", "HEAD"], run.env);
  const extra: Record<string, string> =
    head === undefined
      ? { snapshotFor: run.dataRoot }
      : { snapshotFor: run.dataRoot, committedHead: head.trim() };

  if (explicitDiff === undefined) {
    await writeManifest(snapshotPath, current, extra);

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
    extra,
  );
}
