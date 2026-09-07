/**
 * sync-repo: the repo-as-source sync adapter (issue #74). Projects the
 * allowlisted files of a committed source-repository checkout verbatim
 * into `raw/notes/<name>/` — code is truth, so no wrapping and no
 * transformation — and grounds the projection in the source repo's HEAD
 * commit: the manifest records the SHA and the source root beside the
 * per-file hashes. Selection is an allowlist over the repo's tracked
 * files: anything not listed is excluded by construction (unlisted
 * subtrees are never even walked), so a stray data-repo checkout inside
 * the source cannot leak in and the projection can never ingest itself;
 * and a gitignored file matching the allowlist is skipped too (issue
 * #324) — `git status` never reports an ignored file, so without the
 * tracked-file filter it would enter the projection behind a recorded
 * commit that does not describe it. Everything downstream (health,
 * ingest, guardrails) is reused unchanged — topology is decided at the
 * sync layer (guide §2, §25).
 */

import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createColors } from "picocolors";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import {
  listFiles,
  readTextIfExists,
  repoRoot,
  sha256,
  statIfExists,
} from "../cli/shared.ts";
import { runGit } from "../data/git.ts";
import { assertNoBlockingChanges } from "./committed-tree.ts";
import {
  loadSyncConfig,
  type RepoSourceConfig,
  resolveRawDir,
  type SyncConfig,
} from "./config.ts";
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
  colorizeProgress,
  compileIncludePattern,
  type DriverOptions,
  formatReport,
  listNamespaceDirs,
  literalPrefix,
  type ProjectedNote,
  projectNotes,
  pruneNamespaces,
  type RepoSyncReport,
  reportColors,
  resolveDriverConfig,
  SKIPPED_ROOT_DIRS,
  type SyncProgress,
  type SyncReport,
  toAbsolute,
} from "./projection.ts";

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
 * construction); fully literal patterns are checked as exact files;
 * and only tracked files are selected (issue #324) — the walk still
 * counts unversioned entries as examined, but an unversioned file is
 * not ground truth, so it never enters the projection: the recorded
 * commit does not describe it. Candidates are counted by path — overlapping walk roots (src/** plus
 * src/x/**) and an exact file a walk root also covers each count once,
 * keeping the "N of M examined" report honest (issue #246 C-7).
 */
export async function selectRepoFiles(
  root: string,
  patterns: readonly string[],
  tracked: ReadonlySet<string>,
): Promise<{ candidates: number; selected: readonly string[] }> {
  const matchers = patterns.map(compileIncludePattern);
  const matches = (relPath: string) => matchers.some((m) => m.test(relPath));
  const { exactFiles, walkRoots } = classifyPatterns(patterns);

  const examined = new Set<string>(exactFiles);
  const selected = await selectTrackedExactFiles(root, exactFiles, tracked);

  for (const walkRoot of walkRoots) {
    for (const relPath of await listWalkRootFiles(root, walkRoot)) {
      examined.add(relPath);

      if (matches(relPath) && tracked.has(relPath)) {
        selected.add(relPath);
      }
    }
  }

  return { candidates: examined.size, selected: [...selected].sort() };
}

/** The tracked exact-file patterns that exist as regular files on
 *  disk — an untracked or vanished entry is never selected. */
async function selectTrackedExactFiles(
  root: string,
  exactFiles: ReadonlySet<string>,
  tracked: ReadonlySet<string>,
): Promise<Set<string>> {
  const selected = new Set<string>();

  for (const relPath of exactFiles) {
    if (
      tracked.has(relPath) &&
      (await statIfExists(toAbsolute(root, relPath)))?.isFile() === true
    ) {
      selected.add(relPath);
    }
  }

  return selected;
}

/** The files of one allowlist walk root, as the walker reports them;
 *  an absent walk root contributes none — its absence is tolerance,
 *  not an error (ENOENT only; anything else rethrows). */
async function listWalkRootFiles(
  root: string,
  walkRoot: string,
): Promise<string[]> {
  try {
    return await listFiles(
      walkRoot === "" ? root : join(root, walkRoot),
      walkRoot,
      {
        skipRootDirs: SKIPPED_ROOT_DIRS,
        regularFilesOnly: true,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return [];
  }
}

/** The source repo's HEAD commit SHA. */
async function repoHead(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await runGit(root, ["rev-parse", "HEAD"], env);

    return stdout.trim();
  } catch (cause) {
    const reason = errorMessage(cause);

    throw new Error(`cannot read HEAD of source repo ${root}: ${reason}`, {
      cause,
    });
  }
}

/** The repo's tracked files — the versioned set selection draws from
 *  (issue #324): `git status` never reports an ignored file, so an
 *  ignored-but-allowlisted entry would otherwise be projected behind a
 *  recorded commit that does not describe it. `-z` keeps paths raw,
 *  never C-quoted. */
async function trackedFiles(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<ReadonlySet<string>> {
  const { stdout } = await runGit(root, ["ls-files", "-z"], env);

  return new Set(stdout.split("\0").filter((path) => path !== ""));
}

/** SHA grounding requires a committed tree: the recorded commit must
 *  describe the projected content exactly. Tracked modifications
 *  always block; untracked entries block only when the include
 *  allowlist could select them (issue #312). */
async function assertCommittedTree(
  root: string,
  env: NodeJS.ProcessEnv,
  include: readonly string[],
): Promise<void> {
  const { stdout } = await runGit(
    root,
    ["-c", "status.showUntrackedFiles=normal", "status", "--porcelain"],
    env,
  );

  assertNoBlockingChanges(stdout, root, include);
}

/** The single repo source of the config (issue #74: one source repo per
 *  pipeline instance; more than one needs per-source SHA stamps, a
 *  deliberate schema change if ever wanted). */
// ponytail: exactly one repo source per config; extend the manifest
// extras per source before allowing a second one.
async function theRepoSource(
  config: SyncConfig,
  configPath: string,
): Promise<RepoSourceConfig> {
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
  tracked: ReadonlySet<string>,
  onProgress: (message: SyncProgress) => void,
): Promise<{
  notes: VaultNotes;
  report: RepoSyncReport;
}> {
  const { candidates, selected } = await selectRepoFiles(
    source.root,
    source.include,
    tracked,
  );

  onProgress({
    kind: "event",
    text: `repo "${source.name}": ${selected.length} of ${candidates} examined files selected at commit ${commit.slice(0, 8)}`,
  });

  const selectedNotes: ProjectedNote[] = [];

  for (const relPath of selected) {
    const bytes = await readFile(toAbsolute(source.root, relPath));

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
      kind: "repo",
      name: source.name,
      commit,
      candidates,
      selected: selected.length,
      copied,
      unchanged,
      removed,
    },
  };
}

/** Run one repo projection pass and return the run report — the
 *  source-neutral `SyncReport`, whose single row is the repo
 *  source. */
export async function runRepoSync(options: DriverOptions): Promise<SyncReport> {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? (() => {});

  onProgress({ kind: "event", text: `sync-repo: raw dir ${options.rawDir}` });

  const config = await resolveDriverConfig(options, home);
  const source = await theRepoSource(config, options.configPath);

  await assertSourceDirectory("source", source.name, source.root);

  await assertCommittedTree(source.root, env, source.include);

  const commit = await repoHead(source.root, env);
  const tracked = await trackedFiles(source.root, env);
  const manifestPath = join(options.rawDir, "manifest.json");
  const previousText = await readTextIfExists(manifestPath);
  const manifest: Manifest =
    previousText === undefined
      ? emptyManifest()
      : parseManifest(previousText, manifestPath);
  const notesRoot = join(options.rawDir, "notes");
  const staleNames = [
    ...new Set([
      ...Object.keys(manifest.vaults),
      ...(await listNamespaceDirs(notesRoot)),
    ]),
  ].filter((name) => name !== source.name);
  const nextManifest: Manifest = { vaults: { ...manifest.vaults } };
  const prunedNamespaces = await pruneNamespaces(
    staleNames,
    nextManifest,
    notesRoot,
    "repo",
    (text) => onProgress({ kind: "event", text }),
  );

  const { notes, report } = await projectRepo(
    source,
    options.rawDir,
    now,
    manifest.vaults[source.name] ?? {},
    commit,
    tracked,
    onProgress,
  );

  nextManifest.vaults[source.name] = notes;

  const extras = { source_commit: commit, source_root: source.root };

  if (serializeManifest(nextManifest, extras) !== previousText) {
    await mkdir(options.rawDir, { recursive: true });
    await writeManifest(manifestPath, nextManifest, extras);
  }

  return { sources: [report], prunedNamespaces };
}

/** The run's single repo row — the commit line's source; the driver
 *  produces exactly one repo row, so its absence is a bug, not a
 *  state to render. Exported for the report-shape contract tests. */
export function repoRowOf(report: SyncReport): RepoSyncReport {
  const row = report.sources.find(
    (row): row is RepoSyncReport => row.kind === "repo",
  );

  if (row === undefined) {
    throw new Error("repo sync report carries no repo source row");
  }

  return row;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: sync-repo [-h | --help] [<config>] [<raw-dir>]

Project the allowlisted files of a committed source repository into
raw/notes/<name>/ verbatim, grounding the projection in the source
repo's HEAD commit. The config's single repo source names
the namespace, the checkout root, and the include allowlist; anything
not listed is excluded by construction. Only tracked files are
selected: a gitignored file matching the allowlist is skipped, since
the recorded commit does not describe it. The manifest records the
per-file hashes plus the source commit and root, which the health
check uses for the freshness warning.

  -h, --help    Print this help and exit; no side effects.
  <config>      Path to the repo-source sync config.
                Default: the repo's own sync-meta.json.
  <raw-dir>     Destination for notes/ and manifest.json. Default:
                <dataRoot>/raw when the config sets dataRoot, otherwise
                the repo's own raw/.

What it writes: raw/notes/<name>/ files, raw/manifest.json. The source
repository is only read. Exits 1 with an error when tracked files are
modified or staged anywhere in the source, or when an untracked file or
directory could match the include allowlist (commit, ignore, or move
it — the recorded SHA must describe the projected content; untracked
scratch no pattern can select does not block), when the config holds
no repo source or a vault source, or when the source root is not a git
repository.`;

/** sync-repo entry point: `sync-repo [-h | --help] [<config>] [<raw-dir>]` (defaults: sync-meta.json). */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {

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
      config,
      rawDir,
      onProgress: (message) =>
        console.error(colorizeProgress(message.text, "repo")),
    });

    console.log(
      [
        `source repo at commit ${repoRowOf(report).commit}`,
        formatReport(report, reportColors()),
      ].join("\n"),
    );
  } catch (error) {
    console.error(colors.red(`sync-repo: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/sync/sync-repo.ts` runs */
refuseDirectExecution(import.meta.url, "sync-repo");
