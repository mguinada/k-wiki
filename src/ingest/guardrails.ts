import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
 *  1. immutability — the run may change only `wiki/`, `outputs/`, and
 *     `raw/manifest.json`; everything else must be untouched relative
 *     to the pre-run state, and HEAD must not move;
 *  2. frontmatter — every wiki page the run changed carries the
 *     required fields (`title`, `type`, `created`, `updated`, `tags`;
 *     plus `sources` for pages not of type `source`);
 *  3. wikilinks — every `[[wikilink]]` in a changed page resolves to
 *     an existing wiki file.
 */

/** Paths only these guardrails may see changed after a run. */
const ALLOWED_PREFIXES = ["wiki/", "outputs/"] as const;

/** The manifest is sync-owned, but a run may legitimately rewrite it. */
const ALLOWED_EXACT = "raw/manifest.json";

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
}

/** One tripped guardrail: which check, and every problem found. */
export interface GuardrailFailure {
  readonly check: 1 | 2 | 3;
  readonly name: "immutability" | "frontmatter" | "wikilinks";
  readonly problems: readonly string[];
}

/**
 * Parse `git status --porcelain -uall` output. Rename lines
 * (`R  old -> new`) report the target path.
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
    });
  }

  return entries;
}

/** True when a path is one the run is allowed to have changed. */
function isAllowed(path: string): boolean {
  return (
    path === ALLOWED_EXACT ||
    ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** SHA-256 of a file's bytes; "absent" when the file is gone. */
async function hashPath(path: string): Promise<string> {
  try {
    return sha256(await readFile(path));
  } catch {
    return "absent";
  }
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
    const { stdout } = await runGit(dataRoot, ["rev-parse", "HEAD"], env);

    commit = stdout.trim();
  } catch (cause) {
    throw new Error(
      `cannot capture the pre-run commit in ${dataRoot}: the data repo has no commit to revert to — run data:init or commit the data repo first`,
      { cause },
    );
  }

  const status = parseStatus(
    (await runGit(dataRoot, ["status", "--porcelain", "-uall"], env)).stdout,
  );
  const hashes = new Map<string, string>();

  for (const entry of status) {
    hashes.set(entry.path, await hashPath(join(dataRoot, entry.path)));
  }

  return { commit, status, hashes };
}

/** Wiki `.md` pages this run created or modified (not deleted). */
async function changedWikiPages(
  dataRoot: string,
  pre: PreRunState,
  entries: readonly StatusEntry[],
): Promise<string[]> {
  const before = new Map(pre.status.map((entry) => [entry.path, entry.code]));
  const changed: string[] = [];

  for (const entry of entries) {
    if (
      !entry.path.startsWith("wiki/") ||
      !entry.path.endsWith(".md") ||
      basename(entry.path) === "AGENTS.md" ||
      entry.code.includes("D")
    ) {
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

/**
 * Run the three guardrails against the data repo and return the first
 * one that tripped. Check 1 compares the post-run status against the
 * pre-run state: no path outside the whitelist may change (by status
 * code or by content), and HEAD must not move. Checks 2 and 3 read
 * every wiki page the run changed.
 */
export async function runGuardrails(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
): Promise<PostRunState> {
  const entries = parseStatus(
    (await runGit(dataRoot, ["status", "--porcelain", "-uall"], env)).stdout,
  );
  const before = new Map(pre.status.map((entry) => [entry.path, entry.code]));
  const problems = new Set<string>();

  for (const entry of entries) {
    if (!isAllowed(entry.path) && before.get(entry.path) !== entry.code) {
      problems.add(`${entry.path} changed by the run`);
    }
  }

  for (const [path, was] of pre.hashes) {
    if (!isAllowed(path) && (await hashPath(join(dataRoot, path))) !== was) {
      problems.add(`${path} modified by the run`);
    }
  }

  const { stdout: headLine } = await runGit(
    dataRoot,
    ["rev-parse", "HEAD"],
    env,
  );
  const head = headLine.trim();

  if (head !== pre.commit) {
    problems.add(`HEAD moved to ${head.slice(0, 8)} by the run`);
  }

  if (problems.size > 0) {
    return {
      entries,
      failure: {
        check: 1,
        name: "immutability",
        problems: [...problems],
      },
    };
  }

  const changed = await changedWikiPages(dataRoot, pre, entries);
  const frontmatterProblems: string[] = [];

  for (const path of changed) {
    const text = await readFile(join(dataRoot, path), "utf8");

    for (const problem of checkWikiFrontmatter(text)) {
      frontmatterProblems.push(`${path}: ${problem}`);
    }
  }

  if (frontmatterProblems.length > 0) {
    return {
      entries,
      failure: {
        check: 2,
        name: "frontmatter",
        problems: frontmatterProblems,
      },
    };
  }

  const wikiDir = join(dataRoot, "wiki");
  let files: string[] = [];

  try {
    files = (await listFiles(wikiDir)).filter(
      (file) => file.endsWith(".md") && basename(file) !== "AGENTS.md",
    );
  } catch {
    // A run that deleted every wiki page has no links left to check.
  }

  const index = buildPageIndex(files);
  const linkProblems: string[] = [];

  for (const path of changed) {
    const text = await readFile(join(dataRoot, path), "utf8");

    for (const link of extractWikilinks(text)) {
      if (!index.has(link.target)) {
        linkProblems.push(`${path}:${link.line} -> ${link.raw}`);
      }
    }
  }

  if (linkProblems.length > 0) {
    return {
      entries,
      failure: { check: 3, name: "wikilinks", problems: linkProblems },
    };
  }

  return { entries, failure: undefined };
}

/**
 * Revert a failed run: hard-reset the data repo to the pre-run commit
 * and remove the untracked files the run created (reset alone leaves
 * them). Untracked files that existed before the run are kept.
 * ponytail: pre-existing uncommitted changes reset to the commit; a
 * content-snapshot revert is the upgrade path if runs ever start on a
 * dirty tree that must survive a sibling run's failure.
 */
export async function revertToPreRun(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  postEntries: readonly StatusEntry[],
): Promise<void> {
  await runGit(dataRoot, ["reset", "--hard", pre.commit], env);

  const before = new Set(
    pre.status
      .filter((entry) => entry.code.includes("?"))
      .map((entry) => entry.path),
  );
  const fresh = [
    ...new Set(
      postEntries
        .filter((entry) => entry.code.includes("?") && !before.has(entry.path))
        .map((entry) => entry.path),
    ),
  ];

  if (fresh.length > 0) {
    await runGit(dataRoot, ["clean", "-fd", "--", ...fresh], env);
  }
}
