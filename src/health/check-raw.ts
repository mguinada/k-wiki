import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { terminalColors as colors, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import {
  assertDirectory,
  isPlainObject,
  listFiles,
  pluralized,
  readTextIfExists,
  repoRoot,
  sha256,
} from "../cli/shared.ts";
import { runGit } from "../data/git.ts";
import { parseManifest, type VaultNotes } from "../sync/manifest.ts";
import { listNamespaceDirs } from "../sync/projection.ts";

/**
 * raw/ health check: a read-only, vault-free coherence check of the
 * committed `raw/` projection. It compares `raw/` with itself only —
 * every file under `raw/notes/<vault>/` must match its `manifest.json`
 * hash, with no orphan files and no missing entries. Files outside any
 * vault namespace (such as `notes/.gitkeep`) are ignored.
 */

export interface HealthReport {
  readonly healthy: boolean;
  /** One line per problem, repo-relative paths only. */
  readonly problems: readonly string[];
  /** The single healthy summary line; empty when unhealthy. */
  readonly summary: string;
  /** Non-fatal warnings (issue #74): a repo-stamped projection whose
   *  recorded source commit is behind the source repo's HEAD. */
  readonly warnings: readonly string[];
  /** True when the projection is stale (drove a warning). */
  readonly stale: boolean;
}

/**
 * The display path for an absolute path: repo-relative when it lies
 * inside the repository, otherwise relative to the raw directory.
 */
export function displayPath(
  absPath: string,
  rawDir: string,
  root: string = repoRoot,
): string {
  const repoRelative = relative(root, absPath);

  return repoRelative.startsWith("..")
    ? relative(rawDir, absPath)
    : repoRelative;
}

/**
 * Scan one namespace directory for every file, markdown or not — the
 * projection must hold exactly the manifest's notes, so any file
 * without a manifest entry is an orphan. Undefined when the directory
 * does not exist (every manifest entry is then missing).
 */
async function scanNamespace(
  namespaceRoot: string,
): Promise<string[] | undefined> {
  try {
    return (await listFiles(namespaceRoot)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/** The freshness verdict of a repo-stamped manifest (issue #74):
 *  sync-repo records `source_commit` and `source_root` beside the
 *  per-file hashes; a projection whose commit no longer matches the
 *  source repo's HEAD announces itself. Untouched when the manifest
 *  carries no stamp (ordinary vault projections). */
async function checkFreshness(
  manifestText: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ warning: string | undefined; stale: boolean }> {
  if (manifestText === undefined) {
    return { warning: undefined, stale: false };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return { warning: undefined, stale: false };
  }

  if (!isPlainObject(parsed)) {
    return { warning: undefined, stale: false };
  }

  const commit = parsed.source_commit;
  const root = parsed.source_root;

  if (typeof commit !== "string" || typeof root !== "string") {
    return { warning: undefined, stale: false };
  }

  let head: string;

  try {
    const { stdout } = await runGit(root, ["rev-parse", "HEAD"], env);

    head = stdout.trim();
  } catch (cause) {
    const reason = errorMessage(cause);

    return {
      warning: `cannot verify freshness of source repo ${root}: ${reason}`,
      stale: false,
    };
  }

  if (head === commit) {
    return { warning: undefined, stale: false };
  }

  return {
    warning: `stale projection: recorded commit ${commit.slice(0, 8)} is behind source HEAD ${head.slice(0, 8)} — re-run sync-repo`,
    stale: true,
  };
}

/** Parse the manifest's vault entries; a manifest that fails to
 *  parse yields no entries and reports its message as a problem. */
async function loadVaultEntries(
  manifestText: string | undefined,
  manifestPath: string,
  rawDir: string,
  problems: string[],
): Promise<Record<string, VaultNotes>> {
  if (manifestText === undefined) {
    return {};
  }

  try {
    return parseManifest(manifestText, displayPath(manifestPath, rawDir))
      .vaults;
  } catch (cause) {
    problems.push(errorMessage(cause));

    return {};
  }
}

/** Check one projected note against its manifest entry; returns
 *  whether the file hash matched. */
async function checkNoteFile(
  notesRoot: string,
  rawDir: string,
  vault: string,
  relPath: string,
  entry: VaultNotes[string] | undefined,
  fileSet: ReadonlySet<string>,
  problems: string[],
): Promise<boolean> {
  const abs = join(notesRoot, vault, ...relPath.split("/"));

  if (entry === undefined) {
    problems.push(`${displayPath(abs, rawDir)}: orphan (no manifest entry)`);

    return false;
  }

  if (!fileSet.has(relPath)) {
    problems.push(
      `${displayPath(abs, rawDir)}: missing (manifest entry without file)`,
    );

    return false;
  }

  if (sha256(await readFile(abs)) !== entry.hash) {
    problems.push(
      `${displayPath(abs, rawDir)}: hash mismatch (file differs from manifest)`,
    );

    return false;
  }

  return true;
}

/** Compare one vault namespace against its manifest entries. */
async function compareVault(
  notesRoot: string,
  rawDir: string,
  vault: string,
  entries: VaultNotes,
  problems: string[],
): Promise<{ matched: number; active: boolean }> {
  const files = (await scanNamespace(join(notesRoot, vault))) ?? [];
  const paths = [...new Set([...Object.keys(entries), ...files])].sort();
  const fileSet = new Set(files);
  let matched = 0;

  for (const relPath of paths) {
    if (
      await checkNoteFile(
        notesRoot,
        rawDir,
        vault,
        relPath,
        entries[relPath],
        fileSet,
        problems,
      )
    ) {
      matched++;
    }
  }

  return {
    matched,
    active: Object.keys(entries).length > 0 || files.length > 0,
  };
}

/** Compare every vault namespace against the manifest, across both
 *  the manifest's vaults and the namespaces present on disk. */
async function compareVaultProjections(
  notesRoot: string,
  rawDir: string,
  entriesByVault: Record<string, VaultNotes>,
  problems: string[],
): Promise<{ matched: number; activeVaults: number }> {
  const namespaces = [
    ...new Set([
      ...Object.keys(entriesByVault),
      ...(await listNamespaceDirs(notesRoot)),
    ]),
  ].sort();
  let matched = 0;
  let activeVaults = 0;

  for (const vault of namespaces) {
    const result = await compareVault(
      notesRoot,
      rawDir,
      vault,
      entriesByVault[vault] ?? {},
      problems,
    );

    matched += result.matched;

    if (result.active) {
      activeVaults++;
    }
  }

  return { matched, activeVaults };
}

/**
 * Check the coherence of the projection at `rawDirInput`. Throws when
 * the raw directory itself is missing or not a directory; a projection
 * with no manifest entries and no projected notes is healthy-empty.
 */
export async function checkRaw(
  rawDirInput: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HealthReport> {
  const rawDir = resolve(rawDirInput);

  await assertDirectory("raw directory", rawDir, rawDirInput);

  const notesRoot = join(rawDir, "notes");
  const manifestPath = join(rawDir, "manifest.json");
  const manifestText = await readTextIfExists(manifestPath);
  const problems: string[] = [];
  const entriesByVault = await loadVaultEntries(
    manifestText,
    manifestPath,
    rawDir,
    problems,
  );
  const { matched, activeVaults } = await compareVaultProjections(
    notesRoot,
    rawDir,
    entriesByVault,
    problems,
  );

  const freshness = await checkFreshness(
    manifestText,
    options.env ?? process.env,
  );
  const warnings = freshness.warning === undefined ? [] : [freshness.warning];

  if (problems.length > 0) {
    return {
      healthy: false,
      problems,
      summary: "",
      warnings,
      stale: freshness.stale,
    };
  }

  if (matched === 0) {
    return {
      healthy: true,
      problems: [],
      summary:
        "healthy: empty projection (no manifest entries, no projected notes)",
      warnings,
      stale: freshness.stale,
    };
  }

  return {
    healthy: true,
    problems: [],
    summary: `healthy: manifest and projection agree (${pluralized(matched, "note")}, ${pluralized(activeVaults, "vault")})`,
    warnings,
    stale: freshness.stale,
  };
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-raw [-h | --help] [--fail-on-stale] [<raw-dir>]

Check a raw/ projection for coherence: every raw/notes/<vault>/ file
matches its manifest.json sha-256, with no orphan files and no missing
entries. Read-only; never touches the source vault.

When the manifest records a source repo commit and root (a
repo-as-source projection, sync-repo), the source repo's HEAD is
compared against the recorded commit: a projection left behind is
reported as a warning.

  -h, --help      Print this help and exit; no side effects.
  --fail-on-stale Exit 1 when the projection is stale (the warning
                  becomes blocking); freshness problems that cannot be
                  verified never fail the run.
  <raw-dir>       The raw/ directory to check.
                  Default: the repo's own raw/.

Exit status: 0 = coherent (healthy-empty counts; a stale warning
alone stays exit 0), 1 = one line per problem.`;

/** Print a check-raw report: warnings first, then the healthy summary
 *  or one red line per problem; sets the exit code accordingly. */
function printReport(report: HealthReport, failOnStale: boolean): void {
  for (const warning of report.warnings) {
    console.error(colors().yellow(`check-raw: ${warning}`));
  }

  if (report.healthy) {
    console.log(colors().green(report.summary));

    if (failOnStale && report.stale) {
      process.exitCode = 1;
    }

    return;
  }

  for (const line of report.problems) {
    console.error(colors().red(line));
  }

  process.exitCode = 1;
}

/** check-raw entry point: `check-raw [-h | --help] [--fail-on-stale] [<raw-dir>]` (default: repo raw/). */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const failOnStale = args.includes("--fail-on-stale");
  const positional = args.filter((arg) => arg !== "--fail-on-stale");
  const unknown = positional.find((arg) => arg.startsWith("-"));

  if (unknown !== undefined) {
    console.error(
      colors().red(`check-raw: unknown option ${JSON.stringify(unknown)}`),
    );
    process.exitCode = 1;

    return;
  }

  const rawDir = positional[0] ?? join(repoRoot, "raw");

  try {
    printReport(await checkRaw(rawDir), failOnStale);
  } catch (error) {
    console.error(colors().red(`check-raw: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/health/check-raw.ts` runs */
refuseDirectExecution(import.meta.url, "check-raw");
