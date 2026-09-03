/**
 * The manifest-diff domain of one ingest run (issue #258, extracted
 * from wiki-ingest.ts): what changed between the last-ingested
 * snapshot and the current raw manifest — per-vault added, changed,
 * removed, and renamed source sets — plus the wiki-page accounting
 * that buckets the run's git status into created, updated, and
 * deleted pages. Pure logic over manifests and status entries; git
 * archaeology, prompts, and orchestration live in the sibling
 * modules.
 */
import { join } from "node:path";
import { sha256 } from "../cli/shared.ts";
import { isPreExisting, type StatusEntry } from "../data/git.ts";
import type { Manifest, VaultNotes } from "../sync/manifest.ts";
import { bodyAfterFrontmatter, readPageFields } from "../wiki/pages.ts";
import { type PreRunState, vanishedUntrackedPaths } from "./guardrails.ts";

/** One vault's source changes between two manifests. */
export interface VaultSourceChange {
  readonly vault: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  /** Remove+add pairs with identical content hash: moves, not deletions. */
  readonly renamed: readonly NoteRename[];
}

/** A note that moved within one vault without changing its content. */
export interface NoteRename {
  readonly from: string;
  readonly to: string;
}

export interface ManifestDiff {
  /** Only vaults with at least one change, sorted by vault name. */
  readonly vaults: readonly VaultSourceChange[];
  readonly empty: boolean;
}

/**
 * Pair remove+add notes with equal hashes as renames (a move in the
 * same vault, issue #65): each added path pairs with the first
 * unmatched removed path of equal hash, in sorted order, so the
 * pairing is deterministic even between equal-content notes.
 */
function extractRenames(
  before: VaultNotes,
  after: VaultNotes,
  added: readonly string[],
  removed: readonly string[],
): { renamed: NoteRename[]; added: string[]; removed: string[] } {
  const renamed: NoteRename[] = [];
  const taken = new Set<string>();

  for (const to of added) {
    const hash = after[to]?.hash;
    const from = removed.find(
      (path) => !taken.has(path) && before[path]?.hash === hash,
    );

    if (from !== undefined) {
      taken.add(from);
      renamed.push({ from, to });
    }
  }

  return {
    renamed,
    added: added.filter((path) => !renamed.some((r) => r.to === path)),
    removed: removed.filter((path) => !taken.has(path)),
  };
}

/** SHA-256 of a note's text after the frontmatter fence
 *  (`bodyAfterFrontmatter`, exported by wiki/pages.ts beside
 *  `closingFence` so the rename pairing and the fidelity core share
 *  one fence rule). */
function bodyHash(content: string): string {
  return sha256(Buffer.from(bodyAfterFrontmatter(content), "utf8"));
}

/** Pair one vault's leftover removed+added notes whose body hashes
 *  match as renames (issue #143's per-vault step). */
async function pairVaultBodyRenames(
  vault: VaultSourceChange,
  readRemoved: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
  readAdded: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
): Promise<VaultSourceChange> {
  if (vault.removed.length === 0 || vault.added.length === 0) {
    return vault;
  }

  const removedHashes = new Map<string, string>();
  const taken = new Set<string>();
  const renamed = [...vault.renamed];

  for (const path of vault.removed) {
    const content = await readRemoved(vault.vault, path);

    if (content !== undefined) {
      removedHashes.set(path, bodyHash(content));
    }
  }

  const added: string[] = [];

  for (const to of vault.added) {
    const content = await readAdded(vault.vault, to);
    const hash = content === undefined ? undefined : bodyHash(content);
    const from =
      hash === undefined
        ? undefined
        : vault.removed.find(
            (path) => !taken.has(path) && removedHashes.get(path) === hash,
          );

    if (from === undefined) {
      added.push(to);

      continue;
    }

    taken.add(from);
    renamed.push({ from, to });
  }

  return {
    ...vault,
    added,
    renamed,
    removed: vault.removed.filter((path) => !taken.has(path)),
  };
}

/**
 * Reclassify leftover removed+added pairs whose bodies (text after
 * the frontmatter fence) hash equal as renames (issue #143): a move
 * plus a same-day frontmatter edit is mechanically a rename and
 * never routes to expunge. Equal full-file hashes are the primary
 * path, already paired by `diffManifests`; this pass pairs only the
 * leftovers, so a note whose body also changed stays
 * removed + added — that ambiguity stays with the agent. Content a
 * reader cannot supply (no git history, unreadable file) leaves the
 * pair unpaired: the pre-#143 behavior.
 */
export async function pairBodyIdenticalRenames(
  diff: ManifestDiff,
  readRemoved: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
  readAdded: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
): Promise<ManifestDiff> {
  const vaults = await Promise.all(
    diff.vaults.map((vault) =>
      pairVaultBodyRenames(vault, readRemoved, readAdded),
    ),
  );

  return { vaults, empty: vaults.length === 0 };
}

/** Diff two manifests by note path and hash; vaults sort by name. */
export function diffManifests(
  previous: Manifest,
  current: Manifest,
): ManifestDiff {
  const names = [
    ...new Set([
      ...Object.keys(previous.vaults),
      ...Object.keys(current.vaults),
    ]),
  ].sort();
  const vaults = names
    .map((name) => {
      const before: VaultNotes = previous.vaults[name] ?? {};
      const after: VaultNotes = current.vaults[name] ?? {};

      const addedRaw = Object.keys(after)
        .filter((path) => before[path] === undefined)
        .sort();
      const changed = Object.keys(after)
        .filter((path) => {
          const prior = before[path];
          const next = after[path];

          return prior !== undefined && next !== undefined
            ? prior.hash !== next.hash
            : false;
        })
        .sort();
      const removedRaw = Object.keys(before)
        .filter((path) => after[path] === undefined)
        .sort();
      const { renamed, added, removed } = extractRenames(
        before,
        after,
        addedRaw,
        removedRaw,
      );

      return { vault: name, added, changed, removed, renamed };
    })
    .filter(
      (vault) =>
        vault.added.length +
          vault.changed.length +
          vault.removed.length +
          vault.renamed.length >
        0,
    );

  return { vaults, empty: vaults.length === 0 };
}

/** The most specific decomposition of one `--sources` path: the
 *  manifest entry whose vault name is the longest matching
 *  prefix. */
function longestVaultMatch(
  manifest: Manifest,
  source: string,
): { vault: string; path: string } | undefined {
  let match: { vault: string; path: string } | undefined;

  for (const [vault, notes] of Object.entries(manifest.vaults)) {
    const prefix = `${vault}/`;

    if (!source.startsWith(prefix)) {
      continue;
    }

    const path = source.slice(prefix.length);

    if (
      notes[path] !== undefined &&
      (match === undefined || vault.length > match.vault.length)
    ) {
      match = { vault, path };
    }
  }

  return match;
}

/** The synthetic changed-source set of an explicit `--sources` run
 *  (issue #133): every listed path must name one manifest entry and
 *  renders as a `~` (changed) line, so the composed prompt and the
 *  digest read exactly like an incremental run over those sources.
 *  Paths are exact manifest paths — no globbing, no substring
 *  matching: a path naming no entry is an error listing every
 *  offender, never a guess. A path that decomposes two ways (vault
 *  "A" holding "B/c.md" and vault "A/B" holding "c.md") resolves to
 *  the longest vault name — the most specific decomposition. */
export function explicitSourceDiff(
  manifest: Manifest,
  sources: readonly string[],
): ManifestDiff {
  const pathsByVault = new Map<string, string[]>();
  const unknown: string[] = [];

  for (const source of sources) {
    const match = longestVaultMatch(manifest, source);

    if (match === undefined) {
      unknown.push(source);

      continue;
    }

    const paths = pathsByVault.get(match.vault) ?? [];

    paths.push(match.path);
    pathsByVault.set(match.vault, paths);
  }

  if (unknown.length > 0) {
    throw new Error(
      `unknown --sources path(s): ${unknown.join(", ")} — paths are exact manifest paths (<vault name>/<vault-relative path>); no globbing, no substring matching`,
    );
  }

  const vaults = [...pathsByVault.entries()]
    .map(([vault, paths]) => ({
      vault,
      added: [] as string[],
      changed: [...new Set(paths)].sort(),
      removed: [] as string[],
      renamed: [] as NoteRename[],
    }))
    .sort((a, b) => (a.vault < b.vault ? -1 : a.vault > b.vault ? 1 : 0));

  return { vaults, empty: vaults.length === 0 };
}

/** The changed-source entry lines of one vault: one line per note,
 *  sign first — `+` added, `~` changed, `→` renamed, `-` removed.
 *  The one per-vault rule (D-19) the prompt list and the digest
 *  listing both render; one minus sign (ASCII) in both. */
export function vaultEntryLines(vault: VaultSourceChange): string[] {
  const lines: string[] = [];

  for (const path of vault.added) {
    lines.push(`+ ${vault.vault}/${path}`);
  }

  for (const path of vault.changed) {
    lines.push(`~ ${vault.vault}/${path}`);
  }

  for (const rename of vault.renamed) {
    lines.push(`→ ${vault.vault}/${rename.from} → ${vault.vault}/${rename.to}`);
  }

  for (const path of vault.removed) {
    lines.push(`- ${vault.vault}/${path}`);
  }

  return lines;
}

/**
 * Read the frontmatter of created and updated wiki pages and return
 * those with exactly one sources entry — the mechanical unverified
 * frontier (issue #79).
 */
export async function readUnverifiedFrontier(
  dataRoot: string,
  pages: WikiPages,
): Promise<UnverifiedFrontierPage[]> {
  const result: UnverifiedFrontierPage[] = [];

  for (const path of [...pages.created, ...pages.updated]) {
    const fields = await readPageFields(join(dataRoot, path));

    if (fields.sources.length === 1) {
      result.push({ path, sources: fields.sources });
    }
  }

  return result;
}

/** Wiki page changes, read from the data repo's git status. */
export interface WikiPages {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  /** Pages the run deleted — an expunge run's most important action. */
  readonly deleted: readonly string[];
  /** Set when git could not report; the run itself still succeeded. */
  readonly unavailable: string | undefined;
}

/** A created or updated page citing exactly one source — the
 *  mechanical unverified frontier (issue #79). */
export interface UnverifiedFrontierPage {
  readonly path: string;
  readonly sources: readonly string[];
}

/** Total note count of one kind (added, changed, or removed) across
 *  every vault of a diff. */
export function sourceCount(
  diff: ManifestDiff,
  key: "added" | "changed" | "removed" | "renamed",
): number {
  return diff.vaults.reduce((total, vault) => total + vault[key].length, 0);
}

/** A rename entry this run introduced: absent, code and origin
 *  alike, from the pre-run snapshot — a rename staged before the
 *  run is not the run's doing. */
function isFreshRename(
  entry: StatusEntry,
  before: ReadonlyMap<string, StatusEntry>,
): boolean {
  return (
    entry.code.includes("R") && !isPreExisting(before.get(entry.path), entry)
  );
}

/** Bucket an entry's own path by its status code. */
function bucketOwnPath(
  entry: StatusEntry,
  before: ReadonlyMap<string, StatusEntry>,
  buckets: { created: string[]; updated: string[]; deleted: string[] },
): void {
  const { code, path } = entry;

  if (
    code.includes("A") ||
    code.includes("?") ||
    isFreshRename(entry, before)
  ) {
    buckets.created.push(path);
  } else if (code.includes("M")) {
    buckets.updated.push(path);
  } else if (code.includes("D") && !before.get(path)?.code.includes("D")) {
    buckets.deleted.push(path);
  }
}

/** Bucket the post-run status entries, each path scoped to the
 *  wiki tree: created (added, untracked, or a rename this run
 *  introduced — the rename's target), updated (modified), deleted
 *  (deleted now but not already deleted pre-run; likewise a fresh
 *  rename's origin). */
function currentEntryBuckets(
  entries: readonly StatusEntry[],
  before: ReadonlyMap<string, StatusEntry>,
): { created: string[]; updated: string[]; deleted: string[] } {
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];

  for (const entry of entries) {
    if (underWikiTree(entry.path)) {
      bucketOwnPath(entry, before, { created, updated, deleted });
    }

    if (
      entry.origin !== undefined &&
      underWikiTree(entry.origin) &&
      isFreshRename(entry, before)
    ) {
      deleted.push(entry.origin);
    }
  }

  return { created, updated, deleted };
}

/** Pre-run untracked wiki pages whose file vanished during the
 *  run: the disk witness — the guardrails' rule — decides (D-1), so
 *  a page that only became gitignored mid-run does not count as
 *  deleted. */
async function vanishedUntrackedPages(
  dataRoot: string,
  pre: PreRunState | undefined,
): Promise<string[]> {
  if (pre === undefined) {
    return [];
  }

  return await vanishedUntrackedPaths(
    dataRoot,
    pre.status,
    (path) => underWikiTree(path) && path.endsWith(".md"),
  );
}

/** Whether a status path sits under the wiki tree: the scope a
 *  `git status -- wiki` pathspec would have produced, narrowed
 *  from the guardrails' full-repo snapshot. */
function underWikiTree(path: string): boolean {
  return path.startsWith("wiki/");
}

/**
 * Wiki pages created, updated, and deleted by the run, bucketed from
 * the post-run status entries the guardrails already produced (R-2:
 * no second full `git status` spawn): untracked or added paths count
 * as created, modified paths as updated, deleted paths (staged or
 * not) as deleted; a rename this run introduced counts its target as
 * created and its origin as deleted, while a rename already staged
 * before the run counts nowhere (the pre-run attribution gate).
 * Deleting a page that was still untracked leaves no status entry at
 * all, so with the pre-run state those pages count as deleted when
 * their file is gone (the disk witness); a deletion that predates
 * the run (already `D` pre-run) is not the run's doing.
 */
export async function wikiPages(
  dataRoot: string,
  entries: readonly StatusEntry[],
  pre?: PreRunState,
): Promise<WikiPages> {
  const before = new Map(
    (pre?.status ?? []).map((entry) => [entry.path, entry] as const),
  );
  const { created, updated, deleted } = currentEntryBuckets(entries, before);

  return {
    created: created.sort(),
    updated: updated.sort(),
    deleted: [
      ...deleted,
      ...(await vanishedUntrackedPages(dataRoot, pre)),
    ].sort(),
    unavailable: undefined,
  };
}
