import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../cli/is-main.ts";
import { runGit } from "../data/init-data-repo.ts";
import { isPlainObject } from "../sync/config.ts";
import { sha256 } from "../sync/hash.ts";
import {
  parseManifest,
  readManifestText,
  type VaultNotes,
} from "../sync/manifest.ts";

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Colors at the render boundary: green = healthy, red = problems;
 *  NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
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

/** Vault namespaces under the notes root, following directory symlinks. */
async function listNamespaceDirs(notesRoot: string): Promise<string[]> {
  try {
    const names = await readdir(notesRoot);
    const namespaces: string[] = [];

    for (const name of names) {
      if (await resolvesToDirectory(join(notesRoot, name))) {
        namespaces.push(name);
      }
    }

    return namespaces;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

/** Whether the path exists and resolves to a directory. */
async function resolvesToDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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
  const files: string[] = [];

  try {
    await walkFiles(namespaceRoot, "", files);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  files.sort();

  return files;
}

async function walkFiles(
  dir: string,
  prefix: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await walkFiles(join(dir, entry.name), rel, files);
    } else {
      files.push(rel);
    }
  }
}

/**
 * Check the coherence of the projection at `rawDirInput`. Throws when
 * the raw directory itself is missing or not a directory; a projection
 * with no manifest entries and no projected notes is healthy-empty.
 */
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
    const reason = cause instanceof Error ? cause.message : String(cause);

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

export async function checkRaw(
  rawDirInput: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HealthReport> {
  const rawDir = resolve(rawDirInput);

  await assertRawDir(rawDir, rawDirInput);

  const notesRoot = join(rawDir, "notes");
  const manifestPath = join(rawDir, "manifest.json");
  const manifestText = await readManifestText(manifestPath);
  const problems: string[] = [];
  let entriesByVault: Record<string, VaultNotes> = {};

  if (manifestText !== undefined) {
    try {
      entriesByVault = parseManifest(
        manifestText,
        displayPath(manifestPath, rawDir),
      ).vaults;
    } catch (cause) {
      problems.push((cause as Error).message);
    }
  }

  const namespaces = [
    ...new Set([
      ...Object.keys(entriesByVault),
      ...(await listNamespaceDirs(notesRoot)),
    ]),
  ].sort();
  let matched = 0;
  let activeVaults = 0;

  for (const vault of namespaces) {
    const entries = entriesByVault[vault] ?? {};
    const files = (await scanNamespace(join(notesRoot, vault))) ?? [];

    if (Object.keys(entries).length > 0 || files.length > 0) {
      activeVaults++;
    }

    const paths = [...new Set([...Object.keys(entries), ...files])].sort();
    const fileSet = new Set(files);

    for (const relPath of paths) {
      const abs = join(notesRoot, vault, ...relPath.split("/"));
      const entry = entries[relPath];

      if (entry === undefined) {
        problems.push(
          `${displayPath(abs, rawDir)}: orphan (no manifest entry)`,
        );

        continue;
      }

      if (!fileSet.has(relPath)) {
        problems.push(
          `${displayPath(abs, rawDir)}: missing (manifest entry without file)`,
        );

        continue;
      }

      if (sha256(await readFile(abs)) === entry.hash) {
        matched++;

        continue;
      }

      problems.push(
        `${displayPath(abs, rawDir)}: hash mismatch (file differs from manifest)`,
      );
    }
  }

  if (problems.length > 0) {
    const freshness = await checkFreshness(
      manifestText,
      options.env ?? process.env,
    );

    return {
      healthy: false,
      problems,
      summary: "",
      warnings: freshness.warning === undefined ? [] : [freshness.warning],
      stale: freshness.stale,
    };
  }

  if (matched === 0) {
    const freshness = await checkFreshness(
      manifestText,
      options.env ?? process.env,
    );

    return {
      healthy: true,
      problems: [],
      summary:
        "healthy: empty projection (no manifest entries, no projected notes)",
      warnings: freshness.warning === undefined ? [] : [freshness.warning],
      stale: freshness.stale,
    };
  }

  const freshness = await checkFreshness(
    manifestText,
    options.env ?? process.env,
  );

  return {
    healthy: true,
    problems: [],
    summary: `healthy: manifest and projection agree (${matched} ${matched === 1 ? "note" : "notes"}, ${activeVaults} ${activeVaults === 1 ? "vault" : "vaults"})`,
    warnings: freshness.warning === undefined ? [] : [freshness.warning],
    stale: freshness.stale,
  };
}

async function assertRawDir(
  rawDir: string,
  rawDirInput: string,
): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(rawDir)).isDirectory();
  } catch {
    throw new Error(`raw directory does not exist: ${rawDirInput}`);
  }

  if (!isDirectory) {
    throw new Error(`raw directory is not a directory: ${rawDirInput}`);
  }
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

/** check-raw entry point: `check-raw [-h | --help] [--fail-on-stale] [<raw-dir>]` (default: repo raw/). */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const failOnStale = args.includes("--fail-on-stale");
  const positional = args.filter((arg) => arg !== "--fail-on-stale");
  const rawDir = positional[0] ?? join(repoRoot, "raw");

  try {
    const report = await checkRaw(rawDir);

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
  } catch (error) {
    console.error(
      colors().red(
        `check-raw: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url);

/* v8 ignore next: covered only under `node src/health/check-raw.ts` */
if (isMain) {
  await main();
}
