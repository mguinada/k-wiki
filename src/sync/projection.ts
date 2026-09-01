import type { Stats } from "node:fs";
import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createColors } from "picocolors";
import { terminalColors as colors } from "../cli/colors.ts";
import {
  createProgressRenderer,
  formatDuration,
  isWarning,
} from "../cli/progress.ts";
import type { Manifest, ManifestEntry, VaultNotes } from "./manifest.ts";

/**
 * projection: the shared sync library (issue #250) — the pieces every
 * source adapter funnels through, kept source-neutral so no adapter
 * doubles as another's library. Three groups live here: the projection
 * loop of guide §8 (copy changed files, carry unchanged entries
 * forward, remove disappeared projections, prune namespaces), the
 * include pattern language compiled by both the repo adapter's
 * allowlist and the publish stage (guide §25, §26), and the
 * report/progress presentation the sync CLIs render. The adapters
 * themselves — sync-vault for vault sources, sync-repo for repo
 * sources — stay in their own modules and drive these pieces.
 */

/** One selected source file: its path relative to the source root,
 *  its bytes, and its content hash. */
export interface ProjectedNote {
  readonly relPath: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
}

export function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split("/"));
}

/** Verify a configured source root (vault or repo) is an accessible
 *  directory; `kind` names it in the error. */
export async function assertSourceDirectory(
  kind: string,
  name: string,
  root: string,
): Promise<void> {
  let info: Stats;

  try {
    info = await stat(root);
  } catch (cause) {
    throw new Error(`${kind} root for "${name}" is not accessible: ${root}`, {
      cause,
    });
  }

  if (!info.isDirectory()) {
    throw new Error(`${kind} root for "${name}" is not a directory: ${root}`);
  }
}

/** Namespace directories under the notes root; empty when it is absent. */
export async function listNamespaceDirs(notesRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(notesRoot, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

/** Remove now-empty parent directories of a deleted projection. */
async function pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let current = dir;

  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      await rmdir(current);
    } catch (cause) {
      if (isPruneStop(cause)) {
        return;
      }

      throw new Error(`failed to prune directory ${current}`, { cause });
    }

    current = dirname(current);
  }
}

/** Pruning stops when the directory has entries or no longer exists. */
function isPruneStop(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;

  return code === "ENOTEMPTY" || code === "ENOENT";
}

/** What one projection pass did to a namespace: the manifest entries
 *  after the pass, and the per-file change lists the reports print. */
export interface ProjectionResult {
  readonly notes: VaultNotes;
  readonly copied: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

/**
 * The shared projection loop (guide §8), the one invariant every
 * source adapter funnels into: copy each selected file whose hash
 * changed into the namespace, carry unchanged files' manifest entries
 * forward (their `last_synced` survives), remove projections whose
 * source disappeared, and prune now-empty parent directories.
 */
export async function projectNotes(
  selected: readonly ProjectedNote[],
  namespaceRoot: string,
  previous: VaultNotes,
  now: () => Date,
): Promise<ProjectionResult> {
  const copied: string[] = [];
  const unchanged: string[] = [];
  const notes: VaultNotes = {};

  for (const note of selected) {
    const known = previous[note.relPath];

    if (known !== undefined && known.hash === note.hash) {
      unchanged.push(note.relPath);
      notes[note.relPath] = known;

      continue;
    }

    const destination = toAbsolute(namespaceRoot, note.relPath);

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, note.bytes);

    const entry: ManifestEntry = {
      hash: note.hash,
      last_synced: now().toISOString(),
    };

    notes[note.relPath] = entry;
    copied.push(note.relPath);
  }

  const removed: string[] = [];

  for (const relPath of Object.keys(previous).sort()) {
    if (Object.hasOwn(notes, relPath)) {
      continue;
    }

    const destination = toAbsolute(namespaceRoot, relPath);

    await rm(destination, { force: true });
    await pruneEmptyDirs(dirname(destination), namespaceRoot);
    removed.push(relPath);
  }

  return { notes, copied, unchanged, removed };
}

/** Remove stale namespaces from the manifest and disk, reporting
 *  each. The caller owns the staleness computation and the
 *  empty-config safety (a misconfigured empty list must compute no
 *  stale names, never "everything"). Shared by the vault and repo
 *  adapters. */
export async function pruneNamespaces(
  staleNames: readonly string[],
  nextManifest: Manifest,
  notesRoot: string,
  noun: "vault" | "repo",
  onProgress: (message: string) => void,
): Promise<string[]> {
  const prunedNamespaces: string[] = [];

  for (const name of staleNames) {
    delete nextManifest.vaults[name];
    await rm(join(notesRoot, name), { recursive: true, force: true });
    onProgress(`${noun} "${name}": removed stale namespace (not configured)`);
    prunedNamespaces.push(name);
  }

  return prunedNamespaces;
}

/** Compile one include pattern — the shared pattern language of the
 *  repo adapter's allowlist and the publish stage's include list:
 *  `*` matches within a path segment, `**` matches across segments
 *  (gitignore-style — a double-star segment also matches zero
 *  directories, so `src` + double-star + `*.ts` matches `src/a.ts`
 *  as well as `src/x/a.ts`); every other character is literal. */
export function compileIncludePattern(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "^";
  let skipSlash = false;

  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      if (index === segments.length - 1) {
        source += index === 0 ? ".*" : "/.*";
      } else {
        source += index === 0 ? "(?:.*/)?" : "/(?:.*/)?";

        skipSlash = true;
      }

      continue;
    }

    if (index > 0 && !skipSlash) {
      source += "/";
    }

    skipSlash = false;

    source += segment
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
  }

  return new RegExp(`${source}$`);
}

/** One vault source's row in a sync run report: the counts the
 *  report prints for a vault the vault driver synced. */
export interface VaultSyncReport {
  /** The noun the report prints for this row. */
  readonly kind: "vault";
  /** The vault's configured name. */
  readonly name: string;
  /** Markdown files considered, selected or not. */
  readonly candidates: number;
  readonly selected: number;
  readonly copied: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

/** One repo source's row: the vault counts plus the source repo
 *  HEAD commit the projection was stamped with. */
export interface RepoSyncReport {
  /** The noun the report prints for this row. */
  readonly kind: "repo";
  /** The repo source's configured name. */
  readonly name: string;
  /** The source repo HEAD commit the projection grounds on. */
  readonly commit: string;
  /** Files examined while walking the allowlisted subtrees. */
  readonly candidates: number;
  readonly selected: number;
  readonly copied: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

/** One source's row in a sync run report (issue #250): `name` is the
 *  vault or repo source name, `kind` picks the noun the report
 *  prints — a repo source never renders as a vault. */
export type SourceSyncReport = VaultSyncReport | RepoSyncReport;

export interface SyncReport {
  /** One row per configured source the run synced. */
  readonly sources: readonly SourceSyncReport[];
  /** Namespaces removed because they are absent from the config. */
  readonly prunedNamespaces: readonly string[];
  /** Elapsed wall time for the entire run, in milliseconds. */
  readonly elapsedMs?: number;
}

/** Options every sync driver accepts — the row signature of the
 *  driver table. Both drivers take the full shape; each ignores the
 *  fields it does not use (the vault driver ignores `env`, the repo
 *  driver ignores `progressEvery`). */
export interface DriverOptions {
  /** Path to the sync config (e.g. `sync.json`, `sync-meta.json`). */
  readonly configPath: string;
  /** The `raw/` directory that receives `notes/` and `manifest.json`. */
  readonly rawDir: string;
  /** Home directory for `~` expansion; defaults to the real home. */
  readonly home?: string;
  /** Clock for `last_synced`; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Environment for git child processes; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Read-loop heartbeat cadence in files read; default: every 500. */
  readonly progressEvery?: number | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: SyncProgress) => void;
}

/** One vault's would-ingest listing; produced by a dry run. */
export interface VaultDryRunReport {
  readonly vault: string;
  readonly candidates: number;
  readonly wouldIngest: readonly string[];
}

/** Color functions a report renderer applies; identity when plain. */
export interface ReportColors {
  readonly bold: (text: string) => string;
  readonly green: (text: string) => string;
  readonly red: (text: string) => string;
  readonly dim: (text: string) => string;
}

const PLAIN_COLORS: ReportColors = {
  bold: (text) => text,
  green: (text) => text,
  red: (text) => text,
  dim: (text) => text,
};

/** Report colors from the environment (NO_COLOR disables them). */
export function reportColors(): ReportColors {
  const colors = createColors(!process.env.NO_COLOR);

  return {
    bold: colors.bold,
    green: colors.green,
    red: colors.red,
    dim: colors.dim,
  };
}

/** The `(1m05s)` summary suffix; empty when the run was unmeasured. */
function durationClause(elapsedMs: number | undefined): string {
  return elapsedMs === undefined ? "" : ` (${formatDuration(elapsedMs)})`;
}

/** The trailing `sync complete:` summary line for the run totals. */
function summaryLine(
  copied: number,
  removed: number,
  pruned: number,
  duration: string,
  colors: ReportColors,
): string {
  if (copied === 0 && removed === 0 && pruned === 0) {
    return colors.dim(`sync complete: no changes${duration}`);
  }

  const prunedClause =
    pruned === 0
      ? ""
      : `, ${pruned} namespace${pruned === 1 ? "" : "s"} pruned`;

  return colors[removed > 0 || pruned > 0 ? "red" : "green"](
    `sync complete: ${copied} copied, ${removed} removed${prunedClause}${duration}`,
  );
}

/** Render the run summary; `+` marks copies and `-` marks removals.
 *  Each row prints under its own kind's noun — vault or repo — so a
 *  repo source never renders as a vault (issue #250, B-7). */
export function formatReport(
  report: SyncReport,
  colors: ReportColors = PLAIN_COLORS,
): string {
  const lines: string[] = [];

  for (const source of report.sources) {
    const counts = `${source.kind} ${colors.bold(`"${source.name}"`)}: ${source.selected} selected, ${source.copied.length} copied, ${source.unchanged.length} unchanged, ${source.removed.length} removed`;
    const hint =
      source.selected === 0 && source.candidates > 0
        ? ` (${source.candidates} candidates, all blocked)`
        : "";

    lines.push(counts + hint);

    for (const relPath of source.copied) {
      lines.push(`  + ${colors.green(relPath)}`);
    }

    for (const relPath of source.removed) {
      lines.push(`  - ${colors.red(relPath)}`);
    }
  }

  for (const name of report.prunedNamespaces) {
    lines.push(
      `  - ${colors.red(`${name}/ (stale namespace, not configured)`)}`,
    );
  }

  const copied = report.sources.reduce(
    (total, source) => total + source.copied.length,
    0,
  );
  const removed = report.sources.reduce(
    (total, source) => total + source.removed.length,
    0,
  );

  lines.push(
    summaryLine(
      copied,
      removed,
      report.prunedNamespaces.length,
      durationClause(report.elapsedMs),
      colors,
    ),
  );

  return lines.join("\n");
}

/** Render the dry-run would-ingest listing; nothing is written. */
export function formatDryRunReport(
  reports: readonly VaultDryRunReport[],
  colors: ReportColors = PLAIN_COLORS,
  elapsedMs?: number,
): string {
  const lines: string[] = [];

  for (const report of reports) {
    lines.push(
      `vault ${colors.bold(`"${report.vault}"`)}: ${report.wouldIngest.length} of ${report.candidates} candidates would be ingested`,
    );

    for (const relPath of report.wouldIngest) {
      lines.push(`  + ${colors.green(relPath)}`);
    }
  }

  lines.push(`dry-run complete: nothing written${durationClause(elapsedMs)}`);

  return lines.join("\n");
}

/** Color a progress line at the render boundary: WARNING severity
 *  renders yellow, the `noun`-labelled source name renders bold
 *  ("vault" for vault sync, "repo" for repo sync). */
export function colorizeProgress(message: string, noun = "vault"): string {
  if (isWarning(message)) {
    return colors().yellow(message);
  }

  const name = new RegExp(`^${noun} "([^"]*)":`).exec(message)?.[1];

  if (name === undefined) {
    return message;
  }

  return message.replace(
    `${noun} "${name}":`,
    () => `${noun} ${colors().bold(`"${name}"`)}:`,
  );
}

/** Color an error line red at the render boundary. */
export function colorizeError(message: string): string {
  return colors().red(message);
}

/** One progress message from a sync pass: an `event` scrolls as its own
 *  line, a `heartbeat` rewrites the animated status line in place. The
 *  emitter constructs the kind, so classification never depends on
 *  message wording and vault names may contain `:` (issue #246 C-9). */
export type SyncProgress =
  | { readonly kind: "event"; readonly text: string }
  | { readonly kind: "heartbeat"; readonly text: string };

/** A stderr progress surface: plain lines, or one animated line. */
export interface ProgressSink {
  render(message: SyncProgress): void;
  end(): void;
}

/**
 * The stderr presentation for one sync run: heartbeat messages keep
 * one animated line (spinner + sentence) on a TTY; event messages
 * scroll. Non-animated runs append plain lines only.
 */
export function createSyncProgressSink(
  write: (text: string) => void,
  writeLine: (text: string) => void,
  animated: boolean,
  colorize: (text: string) => string,
): ProgressSink {
  if (!animated) {
    return {
      render: (message) => writeLine(colorize(message.text)),
      end: () => {},
    };
  }

  const renderer = createProgressRenderer(write);

  return {
    render: (message) => {
      if (message.kind === "heartbeat") {
        renderer.live(colorize(message.text));
      } else {
        renderer.event(colorize(message.text));
      }
    },
    end: () => renderer.end(),
  };
}
