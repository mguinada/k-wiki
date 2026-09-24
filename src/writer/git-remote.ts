/**
 * Git plumbing for the shared-writer protocol (issue #390): one
 * dir-bound runner every writer module shares, plus the remote
 * observation and history-position primitives the coordinator,
 * lease, and probe need — `ls-remote` for live remote refs (never a
 * default fetch, whose refspecs need not observe `refs/k-wiki/`),
 * explicit-refspec fetches, fast-forward-only merges, and the
 * up-to-date/behind/ahead/diverged classification the coordinator
 * refuses on. Everything takes the injected runner, so tests run the
 * real git binary against temp repositories without process-env
 * threading.
 */

import { runGit } from "../data/git.ts";

/** The stdout/stderr pair one git invocation yields. */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** One dir-bound git runner: the process env is bound at
 *  construction (the CLI boundary's run context), never threaded
 *  call to call. Rejects on a non-zero exit like runGit. */
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

/** The git host a runner is built for: working directory plus the
 *  child-process environment. */
export interface GitHost {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Build the dir-bound runner for one host. */
export function gitRunnerFor(host: GitHost): GitRunner {
  return async (args) => {
    const result = await runGit(host.dir, args, host.env);

    return { stdout: result.stdout, stderr: result.stderr };
  };
}

/** Run git and return trimmed stdout; the underlying rejection (with
 *  git's stderr) propagates. */
export async function gitOut(
  git: GitRunner,
  args: readonly string[],
): Promise<string> {
  return (await git(args)).stdout.trim();
}

/** Run git for its effect only; discard all output. */
export async function gitRun(
  git: GitRunner,
  args: readonly string[],
): Promise<void> {
  await git(args);
}

/** True when git succeeded (exit 0) — for probes whose failure is a
 *  result, not an error. */
export async function gitOk(
  git: GitRunner,
  args: readonly string[],
): Promise<boolean> {
  try {
    await git(args);

    return true;
  } catch {
    return false;
  }
}

/** The ref OID a live remote currently reports, or undefined when
 *  the remote has no such ref. `--refs` filters annotation noise;
 *  the patterns are full ref names. Never a fetch: the default
 *  fetch refspecs need not retrieve custom refs (issue #390). */
export async function lsRemoteOids(
  git: GitRunner,
  remote: string,
  refs: readonly string[],
): Promise<Map<string, string>> {
  const args = ["ls-remote", "--refs", remote, ...refs];
  const out = await gitOut(git, args);
  const oids = new Map<string, string>();

  for (const line of out.split("\n")) {
    const [oid, ref] = line.split("\t");

    if (oid !== undefined && ref !== undefined && oid !== "") {
      oids.set(ref.trim(), oid);
    }
  }

  return oids;
}

/** One ref's live remote OID, or undefined when absent. */
export async function lsRemoteOid(
  git: GitRunner,
  remote: string,
  ref: string,
): Promise<string | undefined> {
  return (await lsRemoteOids(git, remote, [ref])).get(ref);
}

/** Fetch an explicit refspec (`+src:dst` or `src`) from a remote.
 *  Custom refs are only observable through an explicit refspec —
 *  the one fetch form the protocol relies on. */
export async function fetchRefspec(
  git: GitRunner,
  remote: string,
  refspec: string,
): Promise<void> {
  await gitRun(git, ["fetch", remote, refspec]);
}

/** The local OID of a ref-ish, or undefined when it does not exist.
 *  `--verify --quiet` resolves exactly one object or exits non-zero
 *  with no output — one invocation answers both. */
export async function revParseOid(
  git: GitRunner,
  refish: string,
): Promise<string | undefined> {
  const args = ["rev-parse", "--verify", "--quiet", refish];

  try {
    const out = await gitOut(git, args);

    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`.
 *  Unresolvable objects (gc after a reset) count as false — the
 *  fail-closed direction for the snapshot anchor check. */
export async function isAncestor(
  git: GitRunner,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return await gitOk(git, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
}

/** The checked-out branch's name, or undefined on a detached HEAD. */
export async function currentBranch(
  git: GitRunner,
): Promise<string | undefined> {
  const out = await gitOut(git, ["symbolic-ref", "--short", "HEAD"]);

  return out === "" ? undefined : out;
}

/** Where local history sits relative to the remote branch OID. */
export type RemotePosition = "up-to-date" | "behind" | "ahead" | "diverged";

/** Classify the local HEAD against the remote branch OID: behind
 *  means a fast-forward can reach it; ahead and diverged are the
 *  refuse-before-anything states (issue #390 — no automatic
 *  merge/rebase/reset of derived content). The caller must have
 *  fetched the remote branch into this repository first — ancestry
 *  is a local object-graph question, so an unfetched OID classifies
 *  as diverged. */
export async function classifyPosition(
  git: GitRunner,
  remoteOid: string,
): Promise<RemotePosition> {
  const local = await gitOut(git, ["rev-parse", "HEAD"]);

  if (local === remoteOid) {
    return "up-to-date";
  }

  if (await isAncestor(git, local, remoteOid)) {
    return "behind";
  }

  return (await isAncestor(git, remoteOid, local)) ? "ahead" : "diverged";
}

/** Fast-forward the current branch to `target` — refuses anything
 *  that would create a merge commit. */
export async function mergeFfOnly(
  git: GitRunner,
  target: string,
): Promise<void> {
  await gitRun(git, ["merge", "--ff-only", target]);
}
