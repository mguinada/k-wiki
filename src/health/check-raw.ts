import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "../sync/hash.ts";
import { parseManifest, type VaultNotes } from "../sync/manifest.ts";

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
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

/** Read the file text if it exists; undefined when it does not. */
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
export async function checkRaw(rawDirInput: string): Promise<HealthReport> {
  const rawDir = resolve(rawDirInput);

  await assertRawDir(rawDir, rawDirInput);

  const notesRoot = join(rawDir, "notes");
  const manifestPath = join(rawDir, "manifest.json");
  const manifestText = await readTextIfExists(manifestPath);
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

    for (const relPath of paths) {
      const abs = join(notesRoot, vault, ...relPath.split("/"));
      const entry = entries[relPath];

      if (entry === undefined) {
        problems.push(
          `${displayPath(abs, rawDir)}: orphan (no manifest entry)`,
        );

        continue;
      }

      if (!files.includes(relPath)) {
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
    return { healthy: false, problems, summary: "" };
  }

  if (matched === 0) {
    return {
      healthy: true,
      problems: [],
      summary:
        "healthy: empty projection (no manifest entries, no projected notes)",
    };
  }

  return {
    healthy: true,
    problems: [],
    summary: `healthy: manifest and projection agree (${matched} ${matched === 1 ? "note" : "notes"}, ${activeVaults} ${activeVaults === 1 ? "vault" : "vaults"})`,
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
const HELP = `Usage: check-raw [-h | --help] [<raw-dir>]

Check a raw/ projection for coherence: every raw/notes/<vault>/ file
matches its manifest.json sha-256, with no orphan files and no missing
entries. Read-only; never touches the source vault.

  -h, --help    Print this help and exit; no side effects.
  <raw-dir>     The raw/ directory to check.
                Default: the repo's own raw/.

Exit status: 0 = coherent (healthy-empty counts), 1 = one line per
problem.`;

/** check-raw entry point: `check-raw [-h | --help] [<raw-dir>]` (default: repo raw/). */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const rawDir = args[0] ?? join(repoRoot, "raw");

  try {
    const report = await checkRaw(rawDir);

    if (report.healthy) {
      console.log(report.summary);
      return;
    }

    for (const line of report.problems) {
      console.error(line);
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(
      `check-raw: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: import guard — distinguishes direct execution from
   import; not exercisable in-process by construction */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

/* v8 ignore next: covered only under `node src/health/check-raw.ts` */
if (isMain) {
  await main();
}
