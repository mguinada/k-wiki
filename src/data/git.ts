import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

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
