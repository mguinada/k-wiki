import type { Stats } from "node:fs";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createColors } from "picocolors";
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
  serializeManifest,
  type VaultNotes,
  writeManifest,
} from "./manifest.ts";
import { scanVault } from "./scan.ts";

/**
 * sync-vault: the deterministic, LLM-free projection of selected source
 * notes into `raw/notes/` (guide §8). For every vault in `sync.json`, it
 * scans markdown files, selects `wiki: true` notes, hashes them, copies
 * new or changed notes, removes projections whose source disappeared or
 * lost its flag, and records state in `raw/manifest.json`. The run is
 * idempotent: a second run with no source changes copies, removes, and
 * writes nothing.
 */

export interface SyncOptions {
  /** Path to `sync.json`. */
  readonly configPath: string;
  /** The `raw/` directory that receives `notes/` and `manifest.json`. */
  readonly rawDir: string;
  /** Home directory for `~` expansion; defaults to the real home. */
  readonly home?: string;
  /** Clock for `last_synced`; defaults to the wall clock. */
  readonly now?: () => Date;
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

interface SelectedNote {
  readonly relPath: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
}

/** Read the manifest text if it exists; undefined when it does not. */
async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
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

/** Heartbeat interval for the read loop: one line per files read. */
export const PROGRESS_EVERY = 500;

async function syncVault(
  vault: SyncVaultConfig,
  rawDir: string,
  now: () => Date,
  previous: VaultNotes,
  onProgress: (message: string) => void,
): Promise<{ notes: VaultNotes; report: VaultSyncReport }> {
  await assertDirectory(vault);

  const namespaceRoot = join(rawDir, "notes", vault.name);

  onProgress(`vault "${vault.name}": scanning ${vault.root}`);

  const candidates = await scanVault(vault.root);

  onProgress(`vault "${vault.name}": ${candidates.length} candidates`);

  const selected: SelectedNote[] = [];
  const decoder = new TextDecoder();

  for (const [index, relPath] of candidates.entries()) {
    const bytes = await readSourceNote(vault, relPath);

    if (isSelectedNote(decoder.decode(bytes), vault.select)) {
      selected.push({ relPath, bytes, hash: sha256(bytes) });
    }

    if ((index + 1) % PROGRESS_EVERY === 0) {
      onProgress(
        `vault "${vault.name}": ${index + 1}/${candidates.length} read, ${selected.length} selected`,
      );
    }
  }

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

/** Run one full sync pass and return the per-vault reports. */
export async function runSync(
  options: SyncOptions,
): Promise<readonly VaultSyncReport[]> {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});

  onProgress(`sync-vault: raw dir ${options.rawDir}`);

  const config = await loadSyncConfig(options.configPath, home);
  const manifestPath = join(options.rawDir, "manifest.json");
  const previousText = await readTextIfExists(manifestPath);
  const manifest =
    previousText === undefined
      ? emptyManifest()
      : parseManifest(previousText, manifestPath);
  const reports: VaultSyncReport[] = [];
  const nextManifest: Manifest = { vaults: { ...manifest.vaults } };

  for (const vault of config.vaults) {
    const { notes, report } = await syncVault(
      vault,
      options.rawDir,
      now,
      manifest.vaults[vault.name] ?? {},
      onProgress,
    );

    nextManifest.vaults[vault.name] = notes;
    reports.push(report);
  }

  if (serializeManifest(nextManifest) !== previousText) {
    await mkdir(options.rawDir, { recursive: true });
    await writeManifest(manifestPath, nextManifest);
  }

  return reports;
}

/** Render the run summary; `+` marks copies and `-` marks removals. */
export function formatReport(reports: readonly VaultSyncReport[]): string {
  const lines: string[] = [];

  for (const report of reports) {
    const counts = `vault "${report.vault}": ${report.selected} selected, ${report.copied.length} copied, ${report.unchanged.length} unchanged, ${report.removed.length} removed`;
    const hint =
      report.selected === 0 && report.candidates > 0
        ? ` (${report.candidates} candidates, none matched the selection rule)`
        : "";

    lines.push(counts + hint);

    for (const relPath of report.copied) {
      lines.push(`  + ${relPath}`);
    }

    for (const relPath of report.removed) {
      lines.push(`  - ${relPath}`);
    }
  }

  const copied = reports.reduce(
    (total, report) => total + report.copied.length,
    0,
  );
  const removed = reports.reduce(
    (total, report) => total + report.removed.length,
    0,
  );
  const summary =
    copied === 0 && removed === 0
      ? "sync complete: no changes"
      : `sync complete: ${copied} copied, ${removed} removed`;

  lines.push(summary);

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

/** Apply the color scheme to one report line at the render boundary. */
export function colorizeReportLine(line: string): string {
  if (line.startsWith("  + ")) {
    return `  + ${colors().green(line.slice(4))}`;
  }

  if (line.startsWith("  - ")) {
    return `  - ${colors().red(line.slice(4))}`;
  }

  const vaulted = colorizeProgress(line);

  if (vaulted !== line) {
    return vaulted;
  }

  if (line === "sync complete: no changes") {
    return colors().dim(line);
  }

  if (line.startsWith("sync complete: ")) {
    const removed = Number(/[0-9]+(?= removed)/.exec(line)?.[0] ?? 0);

    return removed > 0 ? colors().red(line) : colors().green(line);
  }

  return line;
}

/** Color an error line red at the render boundary. */
export function colorizeError(message: string): string {
  return colors().red(message);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** sync-vault entry point: `sync-vault [config] [raw-dir]`. */
export async function main(): Promise<void> {
  const [configArg, rawArg] = process.argv.slice(2);
  const configPath = configArg ?? join(repoRoot, "sync.json");

  try {
    const config = await loadSyncConfig(configPath);
    const rawDir = rawArg ?? resolveRawDir(config.dataRoot, repoRoot);
    const reports = await runSync({
      configPath,
      rawDir,
      onProgress: (message) => console.error(colorizeProgress(message)),
    });

    console.log(
      formatReport(reports).split("\n").map(colorizeReportLine).join("\n"),
    );
  } catch (error) {
    console.error(
      colorizeError(
        `sync-vault: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: import guard — distinguishes direct execution from
   import; not exercisable in-process by construction */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

/* v8 ignore next: covered only under `node src/sync/sync-vault.ts` */
if (isMain) {
  await main();
}
