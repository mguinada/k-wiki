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
 *     plus `sources` for pages not of type `source`) — except
 *     `wiki/log.md`, the append-only log, which has none by design;
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

/** The contract's append-only log (guide §10): no §9 frontmatter by
 *  design — the agent appends to it on every meaningful run, so
 *  check 2 exempts it (first exposed by a real logged run, #13). */
const FRONTMATTER_EXEMPT = "wiki/log.md";

/** Structural meta pages (guide §9): they carry frontmatter but are
 *  not derived from source material, so the `sources` field is optional. */
const SOURCES_EXEMPT = new Set(["wiki/index.md", "wiki/overview.md"]);

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

/** Undo git's C-string quoting of one porcelain path: git quotes
 *  every path containing whitespace, quotes, or control bytes, and
 *  escapes `"`, `\\`, and control bytes inside the quotes. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }

  const inner = path.slice(1, -1);
  const C_ESCAPES: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };

  let result = "";
  let i = 0;

  while (i < inner.length) {
    const char = inner[i];

    i += 1;

    if (char !== "\\" || i === inner.length) {
      result += char;

      continue;
    }

    const escaped = inner[i] ?? "";

    i += 1;

    const octal = /^[0-7]{1,3}/.exec(inner.slice(i - 1));

    if (C_ESCAPES[escaped] !== undefined) {
      result += C_ESCAPES[escaped];
    } else if (octal !== null) {
      i += octal[0].length - 1;

      result += String.fromCharCode(Number.parseInt(octal[0], 8));
    } else {
      result += escaped;
    }
  }

  return result;
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
        separator === -1 ? unquote(rest) : unquote(rest.slice(separator + 4)),
      origin: separator === -1 ? undefined : unquote(rest.slice(0, separator)),
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

/** Index one status snapshot by path, for entry-to-entry comparison. */
function statusIndex(status: readonly StatusEntry[]): Map<string, StatusEntry> {
  return new Map(status.map((entry) => [entry.path, entry]));
}

/** True when the entry was already dirty before the run: same
 *  status code and, for renames, same origin — a rename's identity
 *  is the pair of its paths, not the target alone. */
function isPreExisting(
  prior: StatusEntry | undefined,
  entry: StatusEntry,
): boolean {
  return (
    prior !== undefined &&
    prior.code === entry.code &&
    prior.origin === entry.origin
  );
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
  /** Content hashes of every dirty path and every rename origin
   *  ("absent" when the file is gone) — clean-tree status codes
   *  alone cannot tell an agent re-edit of an already-dirty page
   *  (the normal case: nothing commits the wiki between runs) from
   *  an untouched one, nor a file restored onto a rename origin. */
  readonly hashes: ReadonlyMap<string, string>;
  /** The bytes of every dirty path and rename origin (null: absent),
   *  so the revert can restore uncommitted pre-run work a reset
   *  alone would destroy. */
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

  const capture = async (path: string): Promise<void> => {
    const content = await readContent(join(dataRoot, path));

    contents.set(path, content);
    hashes.set(path, content === null ? "absent" : sha256(content));
  };

  for (const entry of status) {
    await capture(entry.path);

    if (entry.origin !== undefined) {
      await capture(entry.origin);
    }
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

    const isDirty =
      !isPreExisting(before.get(entry.path), entry) ||
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
export function checkWikiFrontmatter(
  text: string,
  options: { skipSources?: boolean } = {},
): string[] {
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

  if (type !== undefined && type !== "source" && !options.skipSources && !keys.has("sources")) {
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

/** The outside-whitelist paths an entry changed: a rename touches
 *  both its paths, so either may be the violation. */
function outsidePaths(entry: StatusEntry): string[] {
  const outside: string[] = [];

  if (entry.origin !== undefined && !isAllowed(entry.origin)) {
    outside.push(entry.origin);
  }

  if (!isAllowed(entry.path)) {
    outside.push(entry.path);
  }

  return outside;
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
  const preRunOrigins = new Set(
    pre.status.flatMap((entry) =>
      entry.origin === undefined ? [] : [entry.origin],
    ),
  );

  for (const entry of entries) {
    for (const outside of outsidePaths(entry)) {
      const preExisting =
        outside === entry.origin
          ? preRunOrigins.has(outside)
          : isPreExisting(before.get(entry.path), entry);

      if (!preExisting) {
        problems.add(`${outside} changed by the run`);
      }
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
    if (path === FRONTMATTER_EXEMPT) {
      continue;
    }

    for (const problem of checkWikiFrontmatter(text, {
      skipSources: SOURCES_EXEMPT.has(path),
    })) {
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
 * or renamed away before the run dangled already — not this run's
 * doing — so pre-run deletions and rename origins are skipped.
 * Deleting an untracked page leaves no status trace, so a pre-run
 * untracked page whose file is now gone also counts as deleted.
 */
async function deletedWikiPageNames(
  dataRoot: string,
  pre: PreRunState,
  entries: readonly StatusEntry[],
): Promise<Set<string>> {
  const alreadyGone = new Set<string>();

  for (const entry of pre.status) {
    if (entry.origin !== undefined || isDeleted(entry)) {
      alreadyGone.add(entry.origin ?? entry.path);
    }
  }

  const deleted = new Set<string>();

  const take = (path: string): void => {
    if (!alreadyGone.has(path)) {
      deleted.add(basename(path, ".md"));
    }
  };

  for (const entry of pre.status) {
    if (
      isWikiPage(entry.path) &&
      isUntracked(entry) &&
      (await readContent(join(dataRoot, entry.path))) === null
    ) {
      take(entry.path);
    }
  }

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
        if (deletedNames.has(link.target) && !index.has(link.target)) {
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

  const deletedNames = await deletedWikiPageNames(dataRoot, pre, entries);

  return {
    entries,
    failure: await checkChangedWikilinks(dataRoot, texts, deletedNames),
  };
}

/**
 * Revert a failed run: hard-reset the data repo to the pre-run commit,
 * remove the untracked files the run created (reset alone leaves them),
 * then restore every path captured before the run — dirty paths and
 * rename origins alike — from the captured contents; a reset alone
 * would destroy work from earlier runs that nobody has committed yet
 * (the normal case between runs).
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

  for (const [path, content] of pre.contents) {
    const target = join(dataRoot, path);

    if (content === null) {
      await rm(target, { force: true });

      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
