import type { Stats } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { runGit } from "../data/git.ts";
import {
  loadSyncConfig,
  type RepoSourceConfig,
  resolveRawDir,
} from "./config.ts";
import { sha256 } from "./hash.ts";
import {
  type Manifest,
  parseManifest,
  readManifestText,
  serializeManifest,
  type VaultNotes,
  writeManifest,
} from "./manifest.ts";
import {
  formatReport,
  listNamespaceDirs,
  type ProjectedNote,
  projectNotes,
  reportColors,
} from "./sync-vault.ts";

/**
 * sync-repo: the repo-as-source sync adapter (issue #74). Projects the
 * allowlisted files of a committed source-repository checkout verbatim
 * into `raw/notes/<name>/` — code is truth, so no wrapping and no
 * transformation — and grounds the projection in the source repo's HEAD
 * commit: the manifest records the SHA and the source root beside the
 * per-file hashes. Selection is an allowlist declared in the config:
 * anything not listed is excluded by construction (unlisted subtrees
 * are never even walked), so a stray data-repo checkout inside the
 * source cannot leak in and the projection can never ingest itself.
 * Everything downstream (health, ingest, guardrails) is reused
 * unchanged — topology is decided at the sync layer (guide §2, §25).
 */

export interface RepoSyncOptions {
  /** Path to the repo-source sync config (e.g. `sync-meta.json`). */
  readonly configPath: string;
  /** The `raw/` directory that receives `notes/` and `manifest.json`. */
  readonly rawDir: string;
  /** Home directory for `~` expansion; defaults to the real home. */
  readonly home?: string;
  /** Clock for `last_synced`; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Environment for git child processes; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

export interface RepoSyncReport {
  readonly source: string;
  /** The source repo HEAD commit the projection was made from. */
  readonly commit: string;
  /** Files examined while walking the allowlisted subtrees. */
  readonly candidates: number;
  readonly selected: number;
  readonly copied: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  /** Namespaces removed because they are absent from the config. */
  readonly prunedNamespaces: readonly string[];
}

/** Compile one allowlist pattern: `*` matches within a path segment,
 *  `**` matches across segments (gitignore-style — a double-star
 *  segment also matches zero directories, so `src` + double-star +
 *  `*.ts` matches `src/a.ts` as well as `src/x/a.ts`); every other
 *  character is literal. */
export function compileAllowlistPattern(pattern: string): RegExp {
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

/** The literal leading directory segments of a pattern, before the
 *  first wildcard segment; the walk never leaves these subtrees. */
function literalPrefix(pattern: string): string[] {
  const prefix: string[] = [];

  for (const segment of pattern.split("/")) {
    if (segment === "**" || segment.includes("*")) {
      break;
    }

    prefix.push(segment);
  }

  return prefix;
}

/** Directories never walked at the root of a walk, whatever the
 *  allowlist says: `.git` and `node_modules`. */
const SKIPPED_ROOT_DIRS = new Set([".git", "node_modules"]);

/** Whether the path exists and is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function walkFiles(
  dir: string,
  prefix: string,
  atRoot: boolean,
  files: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      if (atRoot && SKIPPED_ROOT_DIRS.has(entry.name)) {
        continue;
      }

      await walkFiles(join(dir, entry.name), rel, false, files);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
}

/** Split the patterns into fully-literal exact files and the
 *  directory roots the walk must cover. */
function classifyPatterns(patterns: readonly string[]): {
  exactFiles: Set<string>;
  walkRoots: Set<string>;
} {
  const walkRoots = new Set<string>();
  const exactFiles = new Set<string>();

  for (const pattern of patterns) {
    const segments = pattern.split("/");
    const prefix = literalPrefix(pattern);

    if (prefix.length === segments.length) {
      exactFiles.add(pattern);
    } else {
      walkRoots.add(prefix.join("/"));
    }
  }

  return { exactFiles, walkRoots };
}

/**
 * Select the files of a source repo that match the allowlist. Only the
 * literal directory prefixes of the patterns are walked (excluded by
 * construction); fully literal patterns are checked as exact files.
 */
export async function selectRepoFiles(
  root: string,
  patterns: readonly string[],
): Promise<{ candidates: number; selected: readonly string[] }> {
  const matchers = patterns.map(compileAllowlistPattern);
  const matches = (relPath: string) => matchers.some((m) => m.test(relPath));
  const { exactFiles, walkRoots } = classifyPatterns(patterns);

  const selected = new Set<string>();
  let candidates = 0;

  for (const relPath of exactFiles) {
    candidates++;

    if (await isFile(join(root, ...relPath.split("/")))) {
      selected.add(relPath);
    }
  }

  for (const walkRoot of walkRoots) {
    const files: string[] = [];

    try {
      await walkFiles(
        walkRoot === "" ? root : join(root, walkRoot),
        walkRoot,
        walkRoot === "",
        files,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    for (const relPath of files) {
      candidates++;

      if (matches(relPath)) {
        selected.add(relPath);
      }
    }
  }

  return { candidates, selected: [...selected].sort() };
}

/** The source repo's HEAD commit SHA. */
async function repoHead(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await runGit(root, ["rev-parse", "HEAD"], env);

    return stdout.trim();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    throw new Error(`cannot read HEAD of source repo ${root}: ${reason}`, {
      cause,
    });
  }
}

/** SHA grounding requires a committed tree: the recorded commit must
 *  describe the projected content exactly. */
async function assertCommittedTree(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { stdout } = await runGit(root, ["status", "--porcelain"], env);

  if (stdout.trim() !== "") {
    throw new Error(
      `source repo ${root} has uncommitted changes; commit before projecting`,
    );
  }
}

/** The single repo source of the config (issue #74: one source repo per
 *  pipeline instance; more than one needs per-source SHA stamps, a
 *  deliberate schema change if ever wanted). */
// ponytail: exactly one repo source per config; extend the manifest
// extras per source before allowing a second one.
async function theRepoSource(
  configPath: string,
  home: string,
): Promise<RepoSourceConfig> {
  const config = await loadSyncConfig(configPath, home);

  for (const source of config.vaults) {
    if (source.kind === "vault") {
      throw new Error(
        `source "${source.name}" is a vault source; this config belongs to sync-vault`,
      );
    }
  }

  const repos = config.vaults.filter(
    (source): source is RepoSourceConfig => source.kind === "repo",
  );
  const [repo] = repos;

  if (repo === undefined) {
    throw new Error(`no repo source in ${configPath}; nothing to project`);
  }

  if (repos.length > 1) {
    throw new Error(
      `expected exactly one repo source in ${configPath}, got ${repos.length}`,
    );
  }

  return repo;
}

/** Read, hash, and project one repo namespace through the shared
 *  projection loop; only the allowlist selection is repo-specific. */
async function projectRepo(
  source: RepoSourceConfig,
  rawDir: string,
  now: () => Date,
  previous: VaultNotes,
  commit: string,
  onProgress: (message: string) => void,
): Promise<{
  notes: VaultNotes;
  report: Omit<RepoSyncReport, "prunedNamespaces">;
}> {
  const { candidates, selected } = await selectRepoFiles(
    source.root,
    source.include,
  );

  onProgress(
    `repo "${source.name}": ${selected.length} of ${candidates} examined files selected at commit ${commit.slice(0, 8)}`,
  );

  const selectedNotes: ProjectedNote[] = [];

  for (const relPath of selected) {
    const bytes = await readFile(join(source.root, ...relPath.split("/")));

    selectedNotes.push({ relPath, bytes, hash: sha256(bytes) });
  }

  const namespaceRoot = join(rawDir, "notes", source.name);
  const { notes, copied, unchanged, removed } = await projectNotes(
    selectedNotes,
    namespaceRoot,
    previous,
    now,
  );

  return {
    notes,
    report: {
      source: source.name,
      commit,
      candidates,
      selected: selected.length,
      copied,
      unchanged,
      removed,
    },
  };
}

/** Verify the source repo root is an accessible directory. */
async function assertRepoDirectory(source: RepoSourceConfig): Promise<void> {
  let info: Stats;

  try {
    info = await stat(source.root);
  } catch (cause) {
    throw new Error(
      `source root for "${source.name}" is not accessible: ${source.root}`,
      { cause },
    );
  }

  if (!info.isDirectory()) {
    throw new Error(
      `source root for "${source.name}" is not a directory: ${source.root}`,
    );
  }
}

/** Run one repo projection pass and return the run report. */
export async function runRepoSync(
  options: RepoSyncOptions,
): Promise<RepoSyncReport> {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? (() => {});

  onProgress(`sync-repo: raw dir ${options.rawDir}`);

  const source = await theRepoSource(options.configPath, home);

  await assertRepoDirectory(source);

  await assertCommittedTree(source.root, env);

  const commit = await repoHead(source.root, env);
  const manifestPath = join(options.rawDir, "manifest.json");
  const previousText = await readManifestText(manifestPath);
  const manifest: Manifest =
    previousText === undefined
      ? { vaults: {} }
      : parseManifest(previousText, manifestPath);
  const notesRoot = join(options.rawDir, "notes");
  const staleNames = [
    ...new Set([
      ...Object.keys(manifest.vaults),
      ...(await listNamespaceDirs(notesRoot)),
    ]),
  ].filter((name) => name !== source.name);
  const nextManifest: Manifest = { vaults: { ...manifest.vaults } };
  const prunedNamespaces: string[] = [];

  for (const name of staleNames) {
    delete nextManifest.vaults[name];

    await rm(join(notesRoot, name), { recursive: true, force: true });
    onProgress(`repo "${name}": removed stale namespace (not configured)`);
    prunedNamespaces.push(name);
  }

  const { notes, report } = await projectRepo(
    source,
    options.rawDir,
    now,
    manifest.vaults[source.name] ?? {},
    commit,
    onProgress,
  );

  nextManifest.vaults[source.name] = notes;

  const extras = { source_commit: commit, source_root: source.root };

  if (serializeManifest(nextManifest, extras) !== previousText) {
    await mkdir(options.rawDir, { recursive: true });
    await writeManifest(manifestPath, nextManifest, extras);
  }

  return { ...report, prunedNamespaces };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: sync-repo [-h | --help] [<config>] [<raw-dir>]

Project the allowlisted files of a committed source repository into
raw/notes/<name>/ verbatim, grounding the projection in the source
repo's HEAD commit (issue #74). The config's single repo source names
the namespace, the checkout root, and the include allowlist; anything
not listed is excluded by construction. The manifest records the per-
file hashes plus the source commit and root, which the health check
uses for the freshness warning.

  -h, --help    Print this help and exit; no side effects.
  <config>      Path to the repo-source sync config.
                Default: the repo's own sync-meta.json.
  <raw-dir>     Destination for notes/ and manifest.json. Default:
                <dataRoot>/raw when the config sets dataRoot, otherwise
                the repo's own raw/.

What it writes: raw/notes/<name>/ files, raw/manifest.json. The source
repository is only read. Exits 1 with an error when the source tree is
dirty (commit first — the recorded SHA must describe the projected
content), when the config holds no repo source or a vault source, or
when the source root is not a git repository.`;

/** sync-repo entry point: `sync-repo [-h | --help] [<config>] [<raw-dir>]` (defaults: sync-meta.json). */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const configPath = args[0] ?? join(repoRoot, "sync-meta.json");
  const colors = createColors(!process.env.NO_COLOR);

  try {
    const config = await loadSyncConfig(configPath);
    const rawDir = args[1] ?? resolveRawDir(config.dataRoot, repoRoot);
    const report = await runRepoSync({
      configPath,
      rawDir,
      onProgress: (message) =>
        console.error(colorizeProgressRepo(message, colors)),
    });

    console.log(
      [
        `source repo at commit ${report.commit}`,
        formatReport(
          {
            vaults: [
              {
                vault: report.source,
                candidates: report.candidates,
                selected: report.selected,
                copied: report.copied,
                unchanged: report.unchanged,
                removed: report.removed,
              },
            ],
            prunedNamespaces: report.prunedNamespaces,
          },
          reportColors(),
        ),
      ].join("\n"),
    );
  } catch (error) {
    console.error(
      colors.red(
        `sync-repo: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/** Bold the repo name of a progress message, mirroring
 *  sync-vault's colorizeProgress for vaults. */
function colorizeProgressRepo(
  message: string,
  colors: ReturnType<typeof createColors>,
): string {
  const name = /^repo "([^"]*)":/.exec(message)?.[1];

  return name === undefined
    ? message
    : message.replace(
        `repo "${name}":`,
        () => `repo ${colors.bold(`"${name}"`)}:`,
      );
}

/* v8 ignore next: covered only under direct `node src/sync/sync-repo.ts` runs */
refuseDirectExecution(import.meta.url, "sync-repo");
