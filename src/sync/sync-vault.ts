import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canAnimate, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { formatDuration } from "../cli/progress.ts";
import { readTextIfExists } from "../cli/shared.ts";
import {
  loadSyncConfig,
  resolveRawDir,
  type SourceConfig,
  type VaultSourceConfig,
} from "./config.ts";
import { readFileTolerant } from "./eagain.ts";
import { isSelectedNote } from "./frontmatter.ts";
import { sha256 } from "./hash.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  serializeManifest,
  type VaultNotes,
  writeManifest,
} from "./manifest.ts";
import {
  assertSourceDirectory,
  colorizeError,
  colorizeProgress,
  createSyncProgressSink,
  type DriverOptions,
  formatDryRunReport,
  formatReport,
  listNamespaceDirs,
  type ProjectedNote,
  projectNotes,
  pruneNamespaces,
  reportColors,
  type SyncProgress,
  type SyncReport,
  toAbsolute,
  type VaultDryRunReport,
  type VaultSyncReport,
} from "./projection.ts";
import { scanVault } from "./scan.ts";

/**
 * sync-vault: the vault-source adapter (guide §8) — the deterministic,
 * LLM-free projection driver for vault sources. For every vault in
 * `sync.json`, it scans markdown files, ingests every note not blocked
 * by the vault's exclusion rule (`wiki: false` in its frontmatter),
 * hashes them, copies new or changed notes, removes projections whose
 * source disappeared or was blocked, prunes namespaces that left the
 * config, and records state in `raw/manifest.json` — all through the
 * shared projection loop of `projection.ts`. The run is idempotent: a
 * second run with no source changes copies, removes, and writes
 * nothing.
 */

/** Heartbeat interval for the read loop: one line per files read. */
export const PROGRESS_EVERY = 500;

async function assertDirectory(vault: VaultSourceConfig): Promise<void> {
  await assertSourceDirectory("vault", vault.name, vault.root);
}

async function readSourceNote(
  vault: VaultSourceConfig,
  relPath: string,
): Promise<Uint8Array> {
  try {
    return await readFileTolerant(toAbsolute(vault.root, relPath));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    throw new Error(
      `failed to read note "${relPath}" in vault "${vault.name}": ${reason}`,
      { cause },
    );
  }
}

/** Heartbeat interval for the directory walk: one line per dirs. */
export const SCAN_HEARTBEAT_EVERY = 1000;

/** Read and select the candidates of one vault, hashing every match. */
async function selectNotes(
  vault: VaultSourceConfig,
  candidates: readonly string[],
  progressEvery: number,
  onProgress: (message: SyncProgress) => void,
): Promise<ProjectedNote[]> {
  const selected: ProjectedNote[] = [];
  const decoder = new TextDecoder();

  for (const [index, relPath] of candidates.entries()) {
    const bytes = await readSourceNote(vault, relPath);

    if (isSelectedNote(decoder.decode(bytes), vault.exclude)) {
      selected.push({ relPath, bytes, hash: sha256(bytes) });
    }

    if ((index + 1) % progressEvery === 0) {
      onProgress({
        kind: "heartbeat",
        text: `vault "${vault.name}": ${index + 1}/${candidates.length} read, ${selected.length} selected`,
      });
    }
  }

  return selected;
}

/** Verify the vault root, scan it, and select its notes. */
async function scanAndSelect(
  vault: VaultSourceConfig,
  progressEvery: number,
  onProgress: (message: SyncProgress) => void,
): Promise<{
  candidates: readonly string[];
  selected: readonly ProjectedNote[];
}> {
  await assertDirectory(vault);

  onProgress({
    kind: "event",
    text: `vault "${vault.name}": scanning ${vault.root}`,
  });

  const walkStartedAt = Date.now();
  const candidates = await scanVault(vault.root, (visited) => {
    if (visited % SCAN_HEARTBEAT_EVERY === 0) {
      const elapsed = formatDuration(Date.now() - walkStartedAt);

      onProgress({
        kind: "heartbeat",
        text: `vault "${vault.name}": scanning (${elapsed}, ${visited} dirs)`,
      });
    }
  });

  onProgress({
    kind: "event",
    text: `vault "${vault.name}": ${candidates.length} candidates`,
  });

  const selected = await selectNotes(
    vault,
    candidates,
    progressEvery,
    onProgress,
  );

  return { candidates, selected };
}

async function syncVault(
  vault: VaultSourceConfig,
  rawDir: string,
  now: () => Date,
  previous: VaultNotes,
  progressEvery: number,
  onProgress: (message: SyncProgress) => void,
): Promise<{ notes: VaultNotes; report: VaultSyncReport }> {
  const { candidates, selected } = await scanAndSelect(
    vault,
    progressEvery,
    onProgress,
  );

  const namespaceRoot = join(rawDir, "notes", vault.name);
  const { notes, copied, unchanged, removed } = await projectNotes(
    selected,
    namespaceRoot,
    previous,
    now,
  );

  return {
    notes,
    report: {
      kind: "vault",
      name: vault.name,
      candidates: candidates.length,
      selected: selected.length,
      copied,
      unchanged,
      removed,
    },
  };
}

/** Wrong-pairing guard (issue #74): sync-vault syncs vault sources
 *  only; a repo source in the config fails loudly, pointing at
 *  sync-repo, instead of silently skipping or mis-projecting it. */
function vaultSourcesOnly(
  sources: readonly SourceConfig[],
): readonly VaultSourceConfig[] {
  const vaults: VaultSourceConfig[] = [];

  for (const source of sources) {
    if (source.kind === "repo") {
      throw new Error(
        `source "${source.name}" is a repo source; this config belongs to sync-repo`,
      );
    }

    vaults.push(source);
  }

  return vaults;
}

/** Run one full vault sync pass and return the run report. */
export async function runVaultSync(
  options: DriverOptions,
): Promise<SyncReport> {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});

  onProgress({
    kind: "event",
    text: `sync-vault: raw dir ${options.rawDir}`,
  });

  const config = await loadSyncConfig(options.configPath, home);
  const vaults = vaultSourcesOnly(config.vaults);
  const manifestPath = join(options.rawDir, "manifest.json");
  const previousText = await readTextIfExists(manifestPath);
  const manifest =
    previousText === undefined
      ? emptyManifest()
      : parseManifest(previousText, manifestPath);
  const reports: VaultSyncReport[] = [];
  const nextManifest: Manifest = { vaults: { ...manifest.vaults } };
  const notesRoot = join(options.rawDir, "notes");
  const configuredNames = new Set(vaults.map((vault) => vault.name));
  const staleNames =
    vaults.length > 0
      ? [
          ...new Set([
            ...Object.keys(manifest.vaults),
            ...(await listNamespaceDirs(notesRoot)),
          ]),
        ].filter((name) => !configuredNames.has(name))
      : [];
  const prunedNamespaces = await pruneNamespaces(
    staleNames,
    nextManifest,
    notesRoot,
    "vault",
    (text) => onProgress({ kind: "event", text }),
  );

  for (const vault of vaults) {
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

  return { sources: reports, prunedNamespaces };
}

/**
 * List what each vault's exclusion rule would ingest; write nothing
 * (issue #32). The owner reviews this list and blocks private notes
 * before the first real inverted sync.
 */
export async function runDryRun(
  options: DriverOptions,
): Promise<readonly VaultDryRunReport[]> {
  const home = options.home ?? homedir();
  const onProgress = options.onProgress ?? (() => {});

  onProgress({
    kind: "event",
    text: "sync-vault: dry run, nothing will be written",
  });

  const config = await loadSyncConfig(options.configPath, home);
  const reports: VaultDryRunReport[] = [];

  for (const vault of vaultSourcesOnly(config.vaults)) {
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

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const dryRun = args.includes("--dry-run");
  const [configArg, rawArg] = args.filter((arg) => arg !== "--dry-run");
  const configPath = configArg ?? join(repoRoot, "sync.json");
  const animated = canAnimate(process.stderr.isTTY === true, process.env);
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
    const report = await runVaultSync({
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
    console.error(colorizeError(`sync-vault: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/sync/sync-vault.ts` runs */
refuseDirectExecution(import.meta.url, "sync-vault");
