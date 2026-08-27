import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { createColors } from "picocolors";

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
