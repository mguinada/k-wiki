import type { Stats } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../cli/is-main.ts";
import { createProgressRenderer, formatDuration } from "../cli/progress.ts";
import {
  loadSyncConfig,
  resolveRawDir,
  type SyncVaultConfig,
} from "./config.ts";
import { isSelectedNote } from "./frontmatter.ts";
import { sha256 } from "./hash.ts";
import {
  emptyManifest,
  type Manifest,
  type ManifestEntry,
  parseManifest,
  readManifestText,
  serializeManifest,
  type VaultNotes,
  writeManifest,
} from "./manifest.ts";
import { scanVault } from "./scan.ts";

/**
 * sync-vault: the deterministic, LLM-free projection of source notes
 * into `raw/notes/` (guide §8). For every vault in `sync.json`, it
 * scans markdown files, ingests every note not blocked by the vault's
 * exclusion rule (`wiki: false` in its frontmatter), hashes them, copies
 * new or changed notes, removes projections whose source disappeared or
 * was blocked, prunes namespaces that left the config, and records
 * state in `raw/manifest.json`. The run is
 * idempotent: a second run with no source changes copies, removes, and
 * writes nothing.
 */

export interface SyncOptions {
  /** Path to `sync.json`. */
  readonly configPath: string;
  /** The `raw/` directory that receives `notes/` and `manifest.json`;
   *  a dry run neither reads nor writes it. */
  readonly rawDir: string;
  /** Home directory for `~` expansion; defaults to the real home. */
  readonly home?: string;
  /** Clock for `last_synced`; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Read-loop heartbeat cadence in files read; default: every 500. */
  readonly progressEvery?: number | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

export interface VaultSyncReport {
  readonly vault: string;
  /** Markdown files considered, selected or not. */
  readonly candidates: number;
  readonly selected: number;
  readonly copied: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

export interface SyncReport {
  /** Per-vault results for the configured vaults. */
  readonly vaults: readonly VaultSyncReport[];
  /** Namespaces removed because they are absent from the config. */
  readonly prunedNamespaces: readonly string[];
  /** Elapsed wall time for the entire run, in milliseconds. */
  readonly elapsedMs?: number;
}

interface SelectedNote {
  readonly relPath: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
}

async function assertDirectory(vault: SyncVaultConfig): Promise<void> {
  let info: Stats;

  try {
    info = await stat(vault.root);
  } catch (cause) {
    throw new Error(
      `vault root for "${vault.name}" is not accessible: ${vault.root}`,
      { cause },
    );
  }

  if (!info.isDirectory()) {
    throw new Error(
      `vault root for "${vault.name}" is not a directory: ${vault.root}`,
    );
  }
}

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split("/"));
}

async function readSourceNote(
  vault: SyncVaultConfig,
  relPath: string,
): Promise<Uint8Array> {
  try {
    return await readFile(toAbsolute(vault.root, relPath));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    throw new Error(
      `failed to read note "${relPath}" in vault "${vault.name}": ${reason}`,
      { cause },
    );
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

/** Namespace directories under the notes root; empty when it is absent. */
async function listNamespaceDirs(notesRoot: string): Promise<string[]> {
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

/** Heartbeat interval for the read loop: one line per files read. */
export const PROGRESS_EVERY = 500;

/** Heartbeat interval for the directory walk: one line per dirs. */
export const SCAN_HEARTBEAT_EVERY = 1000;

/** Read and select the candidates of one vault, hashing every match. */
async function selectNotes(
  vault: SyncVaultConfig,
  candidates: readonly string[],
  progressEvery: number,
  onProgress: (message: string) => void,
): Promise<SelectedNote[]> {
  const selected: SelectedNote[] = [];
  const decoder = new TextDecoder();

  for (const [index, relPath] of candidates.entries()) {
    const bytes = await readSourceNote(vault, relPath);

    if (isSelectedNote(decoder.decode(bytes), vault.exclude)) {
      selected.push({ relPath, bytes, hash: sha256(bytes) });
    }

    if ((index + 1) % progressEvery === 0) {
      onProgress(
        `vault "${vault.name}": ${index + 1}/${candidates.length} read, ${selected.length} selected`,
      );
    }
  }

  return selected;
}

/** Verify the vault root, scan it, and select its notes. */
async function scanAndSelect(
  vault: SyncVaultConfig,
  progressEvery: number,
  onProgress: (message: string) => void,
): Promise<{
  candidates: readonly string[];
  selected: readonly SelectedNote[];
}> {
  await assertDirectory(vault);

  onProgress(`vault "${vault.name}": scanning ${vault.root}`);

  const walkStartedAt = Date.now();
  const candidates = await scanVault(vault.root, (visited) => {
    if (visited % SCAN_HEARTBEAT_EVERY === 0) {
      const elapsed = formatDuration(Date.now() - walkStartedAt);

      onProgress(
        `vault "${vault.name}": scanning (${elapsed}, ${visited} dirs)`,
      );
    }
  });

  onProgress(`vault "${vault.name}": ${candidates.length} candidates`);

  const selected = await selectNotes(
    vault,
    candidates,
    progressEvery,
    onProgress,
  );

  return { candidates, selected };
}

async function syncVault(
  vault: SyncVaultConfig,
  rawDir: string,
  now: () => Date,
  previous: VaultNotes,
  progressEvery: number,
  onProgress: (message: string) => void,
): Promise<{ notes: VaultNotes; report: VaultSyncReport }> {
  const { candidates, selected } = await scanAndSelect(
    vault,
    progressEvery,
    onProgress,
  );

  const namespaceRoot = join(rawDir, "notes", vault.name);

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

  return {
    notes,
    report: {
      vault: vault.name,
      candidates: candidates.length,
      selected: selected.length,
      copied,
      unchanged,
      removed,
    },
  };
}

/** One vault's would-ingest listing; produced by a dry run. */
export interface VaultDryRunReport {
  readonly vault: string;
  readonly candidates: number;
  readonly wouldIngest: readonly string[];
}

/** Run one full sync pass and return the run report. */
export async function runSync(options: SyncOptions): Promise<SyncReport> {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});

  onProgress(`sync-vault: raw dir ${options.rawDir}`);

  const config = await loadSyncConfig(options.configPath, home);
  const manifestPath = join(options.rawDir, "manifest.json");
  const previousText = await readManifestText(manifestPath);
  const manifest =
    previousText === undefined
      ? emptyManifest()
      : parseManifest(previousText, manifestPath);
  const reports: VaultSyncReport[] = [];
  const nextManifest: Manifest = { vaults: { ...manifest.vaults } };
  const notesRoot = join(options.rawDir, "notes");
  const configuredNames = new Set(config.vaults.map((vault) => vault.name));
  const staleNames = [
    ...new Set([
      ...Object.keys(manifest.vaults),
      ...(await listNamespaceDirs(notesRoot)),
    ]),
  ].filter((name) => !configuredNames.has(name));

  const prunedNamespaces: string[] = [];

  // An empty vault list is a misconfigured run (truncated sync.json);
  // it must never be read as "prune everything".
  if (config.vaults.length > 0) {
    for (const name of staleNames) {
      delete nextManifest.vaults[name];
      await rm(join(notesRoot, name), { recursive: true, force: true });
      onProgress(`vault "${name}": removed stale namespace (not configured)`);
      prunedNamespaces.push(name);
    }
  }

  for (const vault of config.vaults) {
    const { notes, report } = await syncVault(
      vault,
      options.rawDir,
      now,
      manifest.vaults[vault.name] ?? {},
      options.progressEvery ?? PROGRESS_EVERY,
      onProgress,
    );

    nextManifest.vaults[vault.name] = notes;
    reports.push(report);
  }

  if (serializeManifest(nextManifest) !== previousText) {
    await mkdir(options.rawDir, { recursive: true });
    await writeManifest(manifestPath, nextManifest);
  }

  return { vaults: reports, prunedNamespaces };
}

/**
 * List what each vault's exclusion rule would ingest; write nothing
 * (issue #32). The owner reviews this list and blocks private notes
 * before the first real inverted sync.
 */
export async function runDryRun(
  options: SyncOptions,
): Promise<readonly VaultDryRunReport[]> {
  const home = options.home ?? homedir();
  const onProgress = options.onProgress ?? (() => {});

  onProgress("sync-vault: dry run, nothing will be written");

  const config = await loadSyncConfig(options.configPath, home);
  const reports: VaultDryRunReport[] = [];

  for (const vault of config.vaults) {
    const { candidates, selected } = await scanAndSelect(
      vault,
      options.progressEvery ?? PROGRESS_EVERY,
      onProgress,
    );

    reports.push({
      vault: vault.name,
      candidates: candidates.length,
      wouldIngest: selected.map((note) => note.relPath),
    });
  }

  return reports;
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

/** Render the run summary; `+` marks copies and `-` marks removals. */
export function formatReport(
  report: SyncReport,
  colors: ReportColors = PLAIN_COLORS,
): string {
  const lines: string[] = [];

  for (const vault of report.vaults) {
    const counts = `vault ${colors.bold(`"${vault.vault}"`)}: ${vault.selected} selected, ${vault.copied.length} copied, ${vault.unchanged.length} unchanged, ${vault.removed.length} removed`;
    const hint =
      vault.selected === 0 && vault.candidates > 0
        ? ` (${vault.candidates} candidates, all blocked)`
        : "";

    lines.push(counts + hint);

    for (const relPath of vault.copied) {
      lines.push(`  + ${colors.green(relPath)}`);
    }

    for (const relPath of vault.removed) {
      lines.push(`  - ${colors.red(relPath)}`);
    }
  }

  for (const name of report.prunedNamespaces) {
    lines.push(
      `  - ${colors.red(`${name}/ (stale namespace, not configured)`)}`,
    );
  }

  const copied = report.vaults.reduce(
    (total, vault) => total + vault.copied.length,
    0,
  );
  const removed = report.vaults.reduce(
    (total, vault) => total + vault.removed.length,
    0,
  );
  const pruned = report.prunedNamespaces.length;
  const duration = durationClause(report.elapsedMs);

  if (copied === 0 && removed === 0 && pruned === 0) {
    lines.push(colors.dim(`sync complete: no changes${duration}`));

    return lines.join("\n");
  }

  const prunedClause =
    pruned === 0
      ? ""
      : `, ${pruned} namespace${pruned === 1 ? "" : "s"} pruned`;

  lines.push(
    colors[removed > 0 || pruned > 0 ? "red" : "green"](
      `sync complete: ${copied} copied, ${removed} removed${prunedClause}${duration}`,
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

/** Colors on by default (piped included); NO_COLOR disables them. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** Bold the vault name of a progress message at the render boundary. */
export function colorizeProgress(message: string): string {
  const name = /^vault "([^"]*)":/.exec(message)?.[1];

  if (name === undefined) {
    return message;
  }

  return message.replace(
    `vault "${name}":`,
    () => `vault ${colors().bold(`"${name}"`)}:`,
  );
}

/** Color an error line red at the render boundary. */
export function colorizeError(message: string): string {
  return colors().red(message);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: sync-vault [--dry-run] [-h | --help] [<config>] [<raw-dir>]

Ingest every vault note not blocked by its exclusion rule (wiki: false
in frontmatter) into raw/notes/<vault>/, or only list what would be
ingested.

  --dry-run      List the notes each vault would ingest; write nothing
                 (no raw/ files, no manifest read or write).
  -h, --help     Print this help and exit; no side effects.
  <config>       Path to sync.json. Default: the repo's own sync.json.
  <raw-dir>      Destination for notes/ and manifest.json. Default:
                 <dataRoot>/raw when the config sets dataRoot, otherwise
                 the repo's own raw/.

Live progress goes to stderr, the report to stdout. On a terminal
(TTY, color enabled) the scan and read heartbeats share one animated
status line - a braille spinner plus the sentence - rewritten in
place; piped, redirected, CI, or NO_COLOR runs get plain appended
lines instead (read heartbeat every 500 files by default).`;

/** Live status patterns: the read heartbeat and the scan-walk heartbeat. */
export const LIVE_PROGRESS =
  /^[^:]+: (\d+\/\d+ read, \d+ selected|scanning \([^)]* dirs\))$/;

/** A stderr progress surface: plain lines, or one animated line. */
export interface ProgressSink {
  render(message: string): void;
  end(): void;
}

/**
 * The stderr presentation for one sync run: read and scan heartbeats
 * keep one animated line (spinner + sentence) on a TTY; every other
 * message scrolls. Non-animated runs append plain lines only.
 */
export function createSyncProgressSink(
  write: (text: string) => void,
  writeLine: (text: string) => void,
  animated: boolean,
  colorize: (message: string) => string,
): ProgressSink {
  if (!animated) {
    return {
      render: (message) => writeLine(colorize(message)),
      end: () => {},
    };
  }

  const renderer = createProgressRenderer(write);

  return {
    render: (message) => {
      if (LIVE_PROGRESS.test(message)) {
        renderer.live(colorize(message));
      } else {
        renderer.event(colorize(message));
      }
    },
    end: () => renderer.end(),
  };
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const dryRun = args.includes("--dry-run");
  const [configArg, rawArg] = args.filter((arg) => arg !== "--dry-run");
  const configPath = configArg ?? join(repoRoot, "sync.json");
  const animated = process.stderr.isTTY === true && !process.env.NO_COLOR;
  const sink = createSyncProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    colorizeProgress,
  );
  const progressEvery = animated ? 1 : undefined;

  try {
    const config = await loadSyncConfig(configPath);
    const rawDir = rawArg ?? resolveRawDir(config.dataRoot, repoRoot);
    const colors = reportColors();

    if (dryRun) {
      const startedAt = Date.now();
      const reports = await runDryRun({
        configPath,
        rawDir,
        progressEvery,
        onProgress: sink.render,
      });
      const elapsedMs = Date.now() - startedAt;

      sink.end();
      console.log(formatDryRunReport(reports, colors, elapsedMs));

      return;
    }

    const startedAt = Date.now();
    const report = await runSync({
      configPath,
      rawDir,
      progressEvery,
      onProgress: sink.render,
    });
    const elapsedMs = Date.now() - startedAt;

    sink.end();
    console.log(formatReport({ ...report, elapsedMs }, colors));
  } catch (error) {
    sink.end();
    console.error(
      colorizeError(
        `sync-vault: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url);

/* v8 ignore next: covered only under `node src/sync/sync-vault.ts` */
if (isMain) {
  await main();
}
