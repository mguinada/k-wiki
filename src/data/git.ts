import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createColors } from "picocolors";
import { sha256 } from "../cli/shared.ts";

const run = promisify(execFile);

/**
 * Run git against one directory, with repository discovery confined to
 * that directory: `GIT_CEILING_DIRECTORIES` at the parent makes git fail
 * loudly ("not a git repository") when the target owns no `.git`, instead
 * of discovering an enclosing repository — under Stryker's sandbox that
 * escape made a rogue commit in the code repo (issue #52). The working
 * directory itself is exempt from the ceiling, so a target that owns its
 * `.git` is discovered normally; the realpath keeps the ceiling entry
 * comparable with git's canonicalized paths (macOS `/var` symlink).
 */
export function runGit(
  dir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return run("git", ["-C", dir, ...args], {
    env: { ...env, GIT_CEILING_DIRECTORIES: realpathSync(dirname(dir)) },
  });
}

export interface StatusEntry {
  /** The two-letter porcelain code, e.g. ` M`, `??`, `R `. */
  readonly code: string;
  /** Repository-relative path; for renames, the target path. */
  readonly path: string;
  /** For renames, the repository-relative origin path. */
  readonly origin: string | undefined;
}

/** Undo git's C-string quoting of one porcelain path: git quotes
 *  every path containing whitespace, quotes, or control bytes, and
 *  escapes `"`, `\\`, and control bytes inside the quotes.
 *  Non-ASCII bytes arrive octal-escaped (or raw, under
 *  core.quotePath=false), so the unescaped bytes are the path's raw
 *  UTF-8 — decoding them byte-per-codepoint would mojibake every
 *  multi-byte path (issue #248, C-2). Literal runs buffer through
 *  one encode so UTF-16 surrogate pairs (astral-plane characters)
 *  stay paired instead of collapsing to U+FFFD halves. */
function decodeGitQuotedPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }

  const inner = path.slice(1, -1);
  const C_ESCAPES: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    "\\": 0x5c,
    '"': 0x22,
  };
  const utf8 = new TextEncoder();
  const bytes: number[] = [];
  let pending = "";
  let i = 0;

  const flushPending = (): void => {
    bytes.push(...utf8.encode(pending));

    pending = "";
  };

  while (i < inner.length) {
    const char = inner[i];

    i += 1;

    if (char !== "\\" || i === inner.length) {
      pending += char;

      continue;
    }

    flushPending();

    const escaped = inner[i] ?? "";

    i += 1;

    const octal = /^[0-7]{1,3}/.exec(inner.slice(i - 1));

    if (C_ESCAPES[escaped] !== undefined) {
      bytes.push(C_ESCAPES[escaped]);
    } else if (octal !== null) {
      i += octal[0].length - 1;

      bytes.push(Number.parseInt(octal[0], 8));
    } else {
      bytes.push(...utf8.encode(escaped));
    }
  }

  flushPending();

  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Uint8Array.from(bytes),
  );
}

/** The ` -> ` separating a rename's two paths: a quoted origin may
 *  itself contain ` -> `, so the separator is only searched for
 *  after the origin's closing quote. */
function findRenameSeparator(rest: string): number {
  if (!rest.startsWith('"')) {
    return rest.indexOf(" -> ");
  }

  for (let i = 1; i < rest.length; i += 1) {
    if (rest[i] === "\\") {
      i += 1;

      continue;
    }

    if (rest[i] === '"' && rest.startsWith(" -> ", i + 1)) {
      return i + 1;
    }
  }

  return -1;
}

/**
 * Parse `git status --porcelain -uall` output. Rename lines
 * (`R  old -> new`) report both paths: `path` is the target,
 * `origin` the source; only rename codes carry the ` -> `
 * separator. Both status calls must use `core.quotePath=false` so
 * pre-run and post-run paths compare equal.
 */
export function parseStatus(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }

    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const separator = code.includes("R") ? findRenameSeparator(rest) : -1;

    entries.push({
      code,
      path:
        separator === -1
          ? decodeGitQuotedPath(rest)
          : decodeGitQuotedPath(rest.slice(separator + 4)),
      origin:
        separator === -1
          ? undefined
          : decodeGitQuotedPath(rest.slice(0, separator)),
    });
  }

  return entries;
}

/** The full `git status --porcelain -uall` snapshot, parsed. Shared
 *  by the guardrails (capturePreRunState, runGuardrails) and
 *  statusSince; core.quotePath=false so pre-run and post-run paths
 *  compare equal. */
export async function porcelainStatus(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<StatusEntry[]> {
  const { stdout } = await runGit(
    dataRoot,
    ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"],
    env,
  );

  return parseStatus(stdout);
}

/** HEAD's full commit hash in the data repo. */
export async function headCommit(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await runGit(dataRoot, ["rev-parse", "HEAD"], env);

  return stdout.trim();
}

/** SHA-256 of a file's bytes; "absent" when the file is gone. */
async function hashPath(path: string): Promise<string> {
  try {
    return sha256(await readFile(path));
  } catch {
    return "absent";
  }
}

/** Whether the file's current content hash still equals the
 *  expected snapshot value. */
export async function hashMatches(
  dataRoot: string,
  path: string,
  expected: string | undefined,
): Promise<boolean> {
  return (await hashPath(join(dataRoot, path))) === expected;
}

/** Index one status snapshot by path, for entry-to-entry comparison. */
export function statusIndex(
  status: readonly StatusEntry[],
): Map<string, StatusEntry> {
  return new Map(status.map((entry) => [entry.path, entry]));
}

/** True when the entry was already dirty before the run: same
 *  status code and, for renames, same origin — a rename's identity
 *  is the pair of its paths, not the target alone. */
export function isPreExisting(
  prior: StatusEntry | undefined,
  entry: StatusEntry,
): boolean {
  return (
    prior !== undefined &&
    prior.code === entry.code &&
    prior.origin === entry.origin
  );
}

/** The rename origins of a status snapshot: the set of `origin`
 *  paths renames recorded. */
export function renameOriginsOf(status: readonly StatusEntry[]): Set<string> {
  return new Set(
    status.flatMap((entry) =>
      entry.origin === undefined ? [] : [entry.origin],
    ),
  );
}

/** The pre-run git baseline a statusSince comparison starts from:
 *  HEAD, the full status, and the content hashes captured before
 *  the run. The guardrails' PreRunState satisfies this structurally
 *  — it adds only the captured contents the revert needs. */
export interface GitBaseline {
  readonly commit: string;
  readonly status: readonly StatusEntry[];
  readonly hashes: ReadonlyMap<string, string>;
}

/** Rename origins under the prefix that this run moved: an origin
 *  untouched by the run was already a pre-run rename origin whose
 *  content hash still matches the pre-run snapshot. */
async function changedRenameOrigins(
  dataRoot: string,
  entries: readonly StatusEntry[],
  preRunOrigins: ReadonlySet<string>,
  hashes: ReadonlyMap<string, string>,
  under: (path: string) => boolean,
): Promise<string[]> {
  const changed: string[] = [];

  for (const entry of entries) {
    if (entry.origin === undefined || !under(entry.origin)) {
      continue;
    }

    const untouched =
      preRunOrigins.has(entry.origin) &&
      (await hashMatches(dataRoot, entry.origin, hashes.get(entry.origin)));

    if (!untouched) {
      changed.push(entry.origin);
    }
  }

  return changed;
}

/** Paths under the prefix whose post-run git state differs from the
 *  pre-run snapshot: a new status entry, a moved status code or
 *  rename origin, or a re-edit of a file already dirty before the
 *  run (caught by the content hash). */
async function changedStatusPaths(
  dataRoot: string,
  entries: readonly StatusEntry[],
  before: ReadonlyMap<string, StatusEntry>,
  hashes: ReadonlyMap<string, string>,
  under: (path: string) => boolean,
): Promise<string[]> {
  const changed: string[] = [];

  for (const entry of entries) {
    if (!under(entry.path)) {
      continue;
    }

    const untouched =
      isPreExisting(before.get(entry.path), entry) &&
      (await hashMatches(dataRoot, entry.path, hashes.get(entry.path)));

    if (!untouched) {
      changed.push(entry.path);
    }
  }

  return changed;
}

/** Pre-run dirty paths under the prefix that vanished from the
 *  post-run status entirely: a deleted untracked page is invisible
 *  to git status, so the captured hashes are compared against disk. */
async function vanishedPreRunPaths(
  dataRoot: string,
  hashes: ReadonlyMap<string, string>,
  under: (path: string) => boolean,
): Promise<string[]> {
  const changed: string[] = [];

  for (const path of hashes.keys()) {
    if (under(path) && !(await hashMatches(dataRoot, path, hashes.get(path)))) {
      changed.push(path);
    }
  }

  return changed;
}

/**
 * Post-run comparison under one path prefix (issue #72, wiki-query
 * stage 1): the full post-run status entries, every path under
 * `prefix` whose git state differs from the pre-run snapshot, and
 * whether HEAD moved. A path differs when it gains a status entry
 * (a new file, or a rename whose origin or target sits under the
 * prefix), when its status code, rename origin, or content hash
 * moved — including a re-edit of a file already dirty before the
 * run — or when a pre-run dirty path under the prefix vanished from
 * the post-run status entirely (a deleted untracked page is
 * invisible to git status, so the captured hashes are compared
 * against the disk). A run that commits its writes leaves a clean
 * tree: no path reports, `headMoved` carries it. The caller decides
 * what a change means and whether to revert with `revertToPreRun`
 * (which wants the full entries, not only the prefix's).
 */
export async function statusSince(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: GitBaseline,
  prefix: string,
): Promise<{
  readonly entries: readonly StatusEntry[];
  readonly changed: readonly string[];
  readonly headMoved: boolean;
}> {
  const entries = await porcelainStatus(dataRoot, env);
  const before = statusIndex(pre.status);
  const preRunOrigins = renameOriginsOf(pre.status);
  const under = (path: string): boolean => path.startsWith(`${prefix}/`);
  const changed = [
    ...(await changedRenameOrigins(
      dataRoot,
      entries,
      preRunOrigins,
      pre.hashes,
      under,
    )),
    ...(await changedStatusPaths(dataRoot, entries, before, pre.hashes, under)),
    ...(await vanishedPreRunPaths(dataRoot, pre.hashes, under)),
  ];

  return {
    entries,
    changed: [...new Set(changed)].sort(),
    headMoved: (await headCommit(dataRoot, env)) !== pre.commit,
  };
}

/** The repository root containing `dir`, or undefined outside any
 *  git repository (repository discovery unconfined — the caller is
 *  locating a repo, not running repo commands). Shared by the
 *  one-shot migration scripts' clean-tree gates. */
export async function gitRepoRoot(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { env },
    );

    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Refuse a directory with uncommitted changes: the review surface
 *  of a one-shot wiki-tree rewrite (backfill-origin, link-sources) is
 *  a clean git diff, and `git restore` the revert. Warns and proceeds
 *  outside any git repo — there is no safety net to demand. */
export async function assertCleanTree(
  dir: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const repoRoot = await gitRepoRoot(dir, env);

  if (repoRoot === undefined) {
    console.error(
      createColors(!env.NO_COLOR).yellow(
        `${label}: no git repo at ${dir} — proceeding without the git safety net`,
      ),
    );

    return;
  }

  const { stdout } = await runGit(
    repoRoot,
    ["status", "--porcelain", "--", "."],
    env,
  );

  if (stdout.trim() !== "") {
    throw new Error(
      `${dir} has uncommitted changes — commit or stash first; the review surface is a clean git diff (see git -C ${repoRoot} status)`,
    );
  }
}
