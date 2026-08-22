import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runGit } from "../data/init-data-repo.ts";
import { sha256 } from "../sync/hash.ts";
import { buildPageIndex, extractWikilinks, listFiles } from "../wiki-links.ts";

/**
 * Post-run guardrails (guide §1, §7, §9; issue #12): three mechanical
 * checks after every headless agent run, with automatic revert to the
 * pre-run commit on failure. Quality auditing stays the agent's lint
 * job (§17); these checks only catch catastrophic failure classes that
 * are cheap to verify mechanically.
 *
 *  1. immutability — the run may change only `wiki/` (never the
 *     wiki/AGENTS.md contract), `outputs/`, and `raw/manifest.json`;
 *     everything else must be untouched relative to the pre-run
 *     state, and HEAD must not move;
 *  2. frontmatter — every wiki page the run changed carries the
 *     required fields (`title`, `type`, `created`, `updated`, `tags`;
 *     plus `sources` for pages not of type `source`);
 *  3. wikilinks — every `[[wikilink]]` in a changed page resolves to
 *     an existing wiki file, and no remaining page keeps a link to a
 *     page the run deleted.
 */

/** Paths only these guardrails may see changed after a run. */
const ALLOWED_PREFIXES = ["wiki/", "outputs/"] as const;

/** The manifest is sync-owned, but a run may legitimately rewrite it. */
const ALLOWED_EXACT = "raw/manifest.json";

/** The wiki contract file: no run may write it (guide §10). */
const FORBIDDEN_EXACT = "wiki/AGENTS.md";

/** Frontmatter fields every wiki page must carry (§9). */
const REQUIRED_FIELDS = [
  "title",
  "type",
  "created",
  "updated",
  "tags",
] as const;

export interface StatusEntry {
  /** The two-letter porcelain code, e.g. ` M`, `??`, `R `. */
  readonly code: string;
  /** Repository-relative path; for renames, the target path. */
  readonly path: string;
  /** For renames, the repository-relative origin path. */
  readonly origin: string | undefined;
}

/** One tripped guardrail: which check, and every problem found. */
export interface GuardrailFailure {
  readonly check: 1 | 2 | 3;
  readonly name: "immutability" | "frontmatter" | "wikilinks";
  readonly problems: readonly string[];
}

/**
 * Parse `git status --porcelain -uall` output. Rename lines
 * (`R  old -> new`) report both paths: `path` is the target,
 * `origin` the source.
 */
export function parseStatus(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }

    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const renamed = rest.indexOf(" -> ");

    entries.push({
      code,
      path: renamed === -1 ? rest : rest.slice(renamed + 4),
      origin: renamed === -1 ? undefined : rest.slice(0, renamed),
    });
  }

  return entries;
}

/** True when a path is one the run is allowed to have changed. */
function isAllowed(path: string): boolean {
  return (
    path !== FORBIDDEN_EXACT &&
    (path === ALLOWED_EXACT ||
      ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)))
  );
}

/** True for wiki content pages (`.md` files under `wiki/`). */
function isWikiPage(path: string): boolean {
  return path.startsWith("wiki/") && path.endsWith(".md");
}

/** True when git reports the path as untracked. */
function isUntracked(entry: StatusEntry): boolean {
  return entry.code.includes("?");
}

/** True when git reports the path as deleted. */
function isDeleted(entry: StatusEntry): boolean {
  return entry.code.includes("D");
}

/** Index one status snapshot by path, for code-to-code comparison. */
function statusIndex(status: readonly StatusEntry[]): Map<string, string> {
  return new Map(status.map((entry) => [entry.path, entry.code]));
}

/** A file's bytes, or null when the path is absent. */
async function readContent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** SHA-256 of a file's bytes; "absent" when the file is gone. */
async function hashPath(path: string): Promise<string> {
  try {
    return sha256(await readFile(path));
  } catch {
    return "absent";
  }
}

/** HEAD's full commit hash in the data repo. */
async function headCommit(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await runGit(dataRoot, ["rev-parse", "HEAD"], env);

  return stdout.trim();
}

/** The state a failed run is reverted to. */
export interface PreRunState {
  /** HEAD at the start of the run; the revert target. */
  readonly commit: string;
  /** The full pre-run git status. */
  readonly status: readonly StatusEntry[];
  /** Content hashes of every dirty path — clean-tree status codes
   *  alone cannot tell an agent re-edit of an already-dirty page
   *  (the normal case: nothing commits the wiki between runs) from
   *  an untouched one. */
  readonly hashes: ReadonlyMap<string, string>;
  /** The bytes of every dirty path (null: absent), so the revert can
   *  restore uncommitted pre-run work a reset alone would destroy. */
  readonly contents: ReadonlyMap<string, Buffer | null>;
}

/**
 * Capture the pre-run state: the revert-target commit plus the git
 * status and the content hashes of every dirty path, so a run that
 * edits an already-dirty `raw/` file still trips check 1 and an
 * agent re-edit of an already-dirty wiki page is still checked.
 */
export async function capturePreRunState(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<PreRunState> {
  let commit: string;

  try {
    commit = await headCommit(dataRoot, env);
  } catch (cause) {
    throw new Error(
      `cannot capture the pre-run commit in ${dataRoot}: the data repo has no commit to revert to — run data:init or commit the data repo first`,
      { cause },
    );
  }

  const status = parseStatus(
    (
      await runGit(
        dataRoot,
        ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"],
        env,
      )
    ).stdout,
  );
  const contents = new Map<string, Buffer | null>();
  const hashes = new Map<string, string>();

  for (const entry of status) {
    const content = await readContent(join(dataRoot, entry.path));

    contents.set(entry.path, content);
    hashes.set(entry.path, content === null ? "absent" : sha256(content));
  }

  return { commit, status, contents, hashes };
}

/** Wiki `.md` pages this run created or modified (not deleted). */
async function changedWikiPages(
  dataRoot: string,
  pre: PreRunState,
  entries: readonly StatusEntry[],
): Promise<string[]> {
  const before = statusIndex(pre.status);
  const changed: string[] = [];

  for (const entry of entries) {
    if (!isWikiPage(entry.path) || isDeleted(entry)) {
      continue;
    }

    const priorCode = before.get(entry.path);
    const isDirty =
      priorCode === undefined ||
      priorCode !== entry.code ||
      (await hashPath(join(dataRoot, entry.path))) !==
        pre.hashes.get(entry.path);

    if (isDirty) {
      changed.push(entry.path);
    }
  }

  return changed;
}

/** Read each changed wiki page; checks 2 and 3 share the texts. */
async function readPages(
  dataRoot: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();

  for (const path of paths) {
    texts.set(path, await readFile(join(dataRoot, path), "utf8"));
  }

  return texts;
}

/**
 * Frontmatter problems of one wiki page (guardrail 2): a complete
 * `---` block and the required fields of §9. Pages not of type
 * `source` derive from source material and must also name `sources`.
 * Field semantics (date formats, vocabulary) stay lint's job.
 */
export function checkWikiFrontmatter(text: string): string[] {
  const lines = text.split(/\r?\n/);

  if (lines[0] !== "---") {
    return ["no frontmatter block"];
  }

  const closing = lines.indexOf("---", 1);

  if (closing === -1) {
    return ["no closing --- for the frontmatter block"];
  }

  const keys = new Set<string>();
  let type: string | undefined;

  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line);

    if (match === null) {
      continue;
    }

    keys.add(match[1] ?? "");

    if (match[1] === "type") {
      type = line
        .slice(line.indexOf(":") + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  const missing: string[] = REQUIRED_FIELDS.filter((field) => !keys.has(field));

  if (type !== undefined && type !== "source" && !keys.has("sources")) {
    missing.push("sources");
  }

  return missing.map(
    (field) => `missing required frontmatter field "${field}"`,
  );
}

/** The post-run git state plus the first guardrail that tripped, if any. */
export interface PostRunState {
  readonly entries: readonly StatusEntry[];
  readonly failure: GuardrailFailure | undefined;
}

/** The outside-whitelist path an entry changed, if any: a rename
 *  touches both its paths, so either may be the violation. */
function changedOutside(entry: StatusEntry): string | undefined {
  if (entry.origin !== undefined && !isAllowed(entry.origin)) {
    return entry.origin;
  }

  return isAllowed(entry.path) ? undefined : entry.path;
}

/**
 * Guardrail 1: no path outside the whitelist changed by status code
 * or by content, and HEAD did not move. Compares the post-run status
 * and hashes against the pre-run state.
 */
async function checkImmutability(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  entries: readonly StatusEntry[],
): Promise<GuardrailFailure | undefined> {
  const before = statusIndex(pre.status);
  const problems = new Set<string>();

  for (const entry of entries) {
    const outside = changedOutside(entry);

    if (outside !== undefined && before.get(entry.path) !== entry.code) {
      problems.add(`${outside} changed by the run`);
    }
  }

  for (const [path, was] of pre.hashes) {
    if (!isAllowed(path) && (await hashPath(join(dataRoot, path))) !== was) {
      problems.add(`${path} changed by the run`);
    }
  }

  const head = await headCommit(dataRoot, env);

  if (head !== pre.commit) {
    problems.add(`HEAD moved to ${head.slice(0, 8)} by the run`);
  }

  if (problems.size === 0) {
    return undefined;
  }

  return {
    check: 1,
    name: "immutability",
    problems: [...problems],
  };
}

/** Guardrail 2: every changed page carries the §9 required fields. */
function checkChangedFrontmatter(
  texts: ReadonlyMap<string, string>,
): GuardrailFailure | undefined {
  const problems: string[] = [];

  for (const [path, text] of texts) {
    for (const problem of checkWikiFrontmatter(text)) {
      problems.push(`${path}: ${problem}`);
    }
  }

  if (problems.length === 0) {
    return undefined;
  }

  return { check: 2, name: "frontmatter", problems };
}

/**
 * Wiki page names the run removed, by deletion or rename: every
 * remaining link to one is newly dangling. A page already deleted
 * before the run dangled already — not this run's doing.
 */
function deletedWikiPageNames(
  pre: PreRunState,
  entries: readonly StatusEntry[],
): Set<string> {
  const before = statusIndex(pre.status);
  const deleted = new Set<string>();

  const take = (path: string): void => {
    const prior = before.get(path);

    if (prior === undefined || !prior.includes("D")) {
      deleted.add(basename(path, ".md"));
    }
  };

  for (const entry of entries) {
    if (entry.origin !== undefined && isWikiPage(entry.origin)) {
      take(entry.origin);
    }

    if (isWikiPage(entry.path) && isDeleted(entry)) {
      take(entry.path);
    }
  }

  return deleted;
}

/** Guardrail 3: every wikilink in every changed page resolves, and no
 *  remaining page keeps a link to a page the run deleted. */
async function checkChangedWikilinks(
  dataRoot: string,
  texts: ReadonlyMap<string, string>,
  deletedNames: ReadonlySet<string>,
): Promise<GuardrailFailure | undefined> {
  let files: string[] = [];

  try {
    files = (await listFiles(join(dataRoot, "wiki"))).filter(
      (file) => file.endsWith(".md") && basename(file) !== "AGENTS.md",
    );
  } catch {
    // A run that deleted every wiki page has no links left to check.
  }

  const index = buildPageIndex(files);
  const problems: string[] = [];

  for (const [path, text] of texts) {
    for (const link of extractWikilinks(text)) {
      if (!index.has(link.target)) {
        problems.push(`${path}:${link.line} -> ${link.raw}`);
      }
    }
  }

  if (deletedNames.size > 0) {
    const checked = new Set(texts.keys());

    for (const file of files) {
      if (checked.has(`wiki/${file}`)) {
        continue;
      }

      const text = await readFile(join(dataRoot, "wiki", file), "utf8");

      for (const link of extractWikilinks(text)) {
        if (deletedNames.has(link.target)) {
          problems.push(`wiki/${file}:${link.line} -> ${link.raw}`);
        }
      }
    }
  }

  if (problems.length === 0) {
    return undefined;
  }

  return { check: 3, name: "wikilinks", problems };
}

/**
 * Run the three guardrails against the data repo and return the first
 * one that tripped. Checks 2 and 3 read every wiki page the run
 * changed (checks run in issue-#12 order: cheap git comparison first).
 */
export async function runGuardrails(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
): Promise<PostRunState> {
  const entries = parseStatus(
    (
      await runGit(
        dataRoot,
        ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"],
        env,
      )
    ).stdout,
  );
  const immutability = await checkImmutability(dataRoot, env, pre, entries);

  if (immutability !== undefined) {
    return { entries, failure: immutability };
  }

  const changed = await changedWikiPages(dataRoot, pre, entries);
  const texts = await readPages(dataRoot, changed);
  const frontmatter = checkChangedFrontmatter(texts);

  if (frontmatter !== undefined) {
    return { entries, failure: frontmatter };
  }

  const deletedNames = deletedWikiPageNames(pre, entries);

  return {
    entries,
    failure: await checkChangedWikilinks(dataRoot, texts, deletedNames),
  };
}

/**
 * Revert a failed run: hard-reset the data repo to the pre-run commit,
 * remove the untracked files the run created (reset alone leaves them),
 * then restore the uncommitted pre-run dirty paths from the captured
 * contents — a reset alone would destroy work from earlier runs that
 * nobody has committed yet (the normal case between runs).
 */
export async function revertToPreRun(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  postEntries: readonly StatusEntry[],
): Promise<void> {
  await runGit(dataRoot, ["reset", "--hard", pre.commit], env);

  const before = new Set(
    pre.status.filter(isUntracked).map((entry) => entry.path),
  );
  const fresh = [
    ...new Set(
      postEntries
        .filter((entry) => isUntracked(entry) && !before.has(entry.path))
        .map((entry) => entry.path),
    ),
  ];

  if (fresh.length > 0) {
    await runGit(dataRoot, ["clean", "-fd", "--", ...fresh], env);
  }

  for (const entry of pre.status) {
    if (entry.origin !== undefined) {
      await rm(join(dataRoot, entry.origin), { force: true });
    }

    const target = join(dataRoot, entry.path);
    const content = pre.contents.get(entry.path);

    if (content === null || content === undefined) {
      await rm(target, { force: true });

      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
