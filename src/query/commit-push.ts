/**
 * Filing durability (issue #436): committing is what filing means —
 * one commit path-staging exactly the query page, `index.md`, and
 * `log.md`, message `query: file <slug>`, immune to unrelated dirt
 * elsewhere in the tree. The push is the guarded ask: it rides the
 * shared-writer lease machinery as-is — fetch first, fast-forward-only
 * exact refspec, clean refusals — never force, never a merge.
 */

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { errorMessage } from "../cli/colors.ts";
import { runGit } from "../data/git.ts";
import { refuseDirtyWorkingTree } from "../writer/cycle-steps.ts";
import {
  currentBranch,
  fetchRefspec,
  type GitRunner,
  gitRunnerFor,
  isAncestor,
  lsRemoteOid,
  revParseOid,
} from "../writer/git-remote.ts";
import {
  describeLease,
  leaseExpired,
  leaseHolder,
  type ObservedLease,
  observeLease,
} from "../writer/lease.ts";
import {
  acquireLease,
  fetchedTreeOid,
  releaseOwnLease,
  takeOverExpiredLease,
} from "../writer/lease-ops.ts";
import {
  readSharedWriterMarker,
  type SharedWriterMarker,
} from "../writer/marker.ts";

/** The forward-only commit-message convention for query filings. */
export function queryCommitMessage(slug: string): string {
  return `query: file ${slug}`;
}

/** The three repo-relative paths one filing commit stages. */
export function filingPaths(pagePath: string): string[] {
  return [pagePath, "wiki/index.md", "wiki/log.md"];
}

/**
 * Commit the filing atomically: stage exactly the three filed paths
 * and commit them with the pinned message — unrelated dirt elsewhere
 * in the data repo stays out. Returns the commit OID.
 */
export async function commitFiling(options: {
  readonly dataRoot: string;
  /** The filed page, data-repo relative (`wiki/queries/<slug>.md`). */
  readonly pagePath: string;
  readonly slug: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  const paths = filingPaths(options.pagePath);

  await runGit(options.dataRoot, ["add", "-A", "--", ...paths], options.env);
  await runGit(
    options.dataRoot,
    [
      "commit",
      "--quiet",
      "-m",
      queryCommitMessage(options.slug),
      "--",
      ...paths,
    ],
    options.env,
  );

  const { stdout } = await runGit(
    options.dataRoot,
    ["rev-parse", "HEAD"],
    options.env,
  );

  return stdout.trim();
}

/** The streams the interactive push ask reads and writes. */
export interface PushAskIo {
  readonly input: Readable;
  readonly output: Writable;
  readonly isTTY: boolean;
}

/**
 * The guarded push ask: `push now? [y/N]`, default no. Only a
 * terminal is asked — a piped or non-interactive run defaults to no,
 * so an unattended filing never pushes.
 */
export async function confirmPush(io: PushAskIo): Promise<boolean> {
  if (!io.isTTY) {
    return false;
  }

  const rl = createInterface({ input: io.input, output: io.output });

  try {
    const answer = (
      await Promise.race([
        rl.question("push now? [y/N] "),
        new Promise<null>((resolve) => {
          rl.once("close", () => resolve(null));
        }),
      ])
    )
      ?.trim()
      .toLowerCase();

    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** The live lease refusal when another writer holds the write. */
async function liveLeaseRefusal(
  git: GitRunner,
  marker: SharedWriterMarker,
): Promise<string | undefined> {
  const observed = await observeLease(git, marker.remote, marker.leaseRef);

  if (observed === undefined || leaseExpired(observed.body, () => new Date())) {
    return undefined;
  }

  return `shared-writer lease is live — ${describeLease(observed)}; a writer never pushes under another writer's lease`;
}

/** Acquire the lease (or take over an expired one by exact OID)
 *  after refusing a live lease; throw on any refusal — the push
 *  never races another writer. */
async function acquirePushLease(options: {
  readonly git: GitRunner;
  readonly marker: SharedWriterMarker;
  readonly base: string;
}): Promise<ObservedLease> {
  const { git, marker } = options;
  const live = await liveLeaseRefusal(git, marker);

  if (live !== undefined) {
    throw new Error(live);
  }

  const observed = await observeLease(git, marker.remote, marker.leaseRef);
  const outcome =
    observed === undefined
      ? await acquireLease({
          git,
          remote: marker.remote,
          leaseRef: marker.leaseRef,
          treeOid: await fetchedTreeOid(git),
          base: options.base,
          now: () => new Date(),
          holder: leaseHolder(),
        })
      : await takeOverExpiredLease({
          git,
          remote: marker.remote,
          leaseRef: marker.leaseRef,
          observed,
          treeOid: await fetchedTreeOid(git),
          base: options.base,
          now: () => new Date(),
          holder: leaseHolder(),
        });

  if (outcome.status === "refused") {
    throw new Error(`shared-writer lease unavailable — ${outcome.reason}`);
  }

  return outcome.lease;
}

/** Everything the push needs once the marker, branch, tree, and
 *  remote-head preconditions hold; `refused` carries the guidance. */
type PushPreparation =
  | {
      readonly kind: "ready";
      readonly git: GitRunner;
      readonly marker: SharedWriterMarker;
      readonly head: string;
      readonly remoteOid: string;
    }
  | { readonly kind: "refused"; readonly reason: string };

/** The marker, branch, clean-tree, and remote-presence preconditions
 *  plus the first fetch — everything before the fast-forward check. */
async function preparePush(options: {
  readonly dataRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<PushPreparation> {
  const { dataRoot } = options;
  const read = await readSharedWriterMarker(dataRoot);

  if (read.kind === "absent") {
    return {
      kind: "refused",
      reason:
        "shared-writer mode is not enabled on this data repo — the push rides the shared-writer lease; run enable-shared-writer first",
    };
  }

  if (read.kind === "invalid") {
    return {
      kind: "refused",
      reason: `shared-writer marker is invalid — failing closed: ${read.reason}`,
    };
  }

  const marker = read.marker;
  const git = gitRunnerFor({ dir: dataRoot, env: options.env });
  const branchRef = `refs/heads/${marker.branch}`;
  const checkedOut = await currentBranch(git);

  if (checkedOut !== marker.branch) {
    return {
      kind: "refused",
      reason: `shared-writer mode runs on ${marker.branch} — this checkout is on ${checkedOut ?? "a detached HEAD"}`,
    };
  }

  const dirty = await refuseDirtyWorkingTree(git);

  if (dirty !== undefined) {
    return {
      kind: "refused",
      reason: `push refused — the data repo is dirty beyond the filed commit; run the sync cycle or resolve it first: ${dirty} (stage 1's saved answer, outputs/last-query.md, counts as dirt — keep the per-machine outputs dir gitignored)`,
    };
  }

  await fetchRefspec(git, marker.remote, branchRef);

  const remoteOid = await lsRemoteOid(git, marker.remote, branchRef);

  if (remoteOid === undefined) {
    return {
      kind: "refused",
      reason: `remote ${marker.remote} has no ${branchRef} — nothing canonical to push onto`,
    };
  }

  const head = await revParseOid(git, "HEAD");

  if (head === undefined) {
    throw new Error("internal: the data repo has no HEAD");
  }

  return { kind: "ready", git, marker, head, remoteOid };
}

/** The fast-forward precondition: the remote branch must sit exactly
 *  on the filing commit's parent — the remote neither moved since the
 *  filing nor sits behind an unshared local history. */
async function requireFilingDescendant(
  git: GitRunner,
  branchRef: string,
  remoteOid: string,
  head: string,
): Promise<string | undefined> {
  const parent = await revParseOid(git, "HEAD^");

  return remoteOid === parent
    ? undefined
    : (await isAncestor(git, remoteOid, head))
      ? `push refused — local history is ahead of ${branchRef} with unshared commits (the filing commit is not the remote's direct child); push them manually (git push) — never force`
      : `push refused — ${branchRef} moved since the filing commit (non-fast-forward); run the sync cycle or pull, and never force`;
}

/**
 * Push the filed commit the shared-writer way: the marker must
 * enable the mode, the checkout must be on the marker's branch, the
 * tree must be clean beyond the filed commit, and the remote branch
 * must be exactly the filing commit's parent (fetch first, then the
 * fast-forward-only exact refspec — a plain push never forces). The
 * lease is held for the tenure and released after; a push failure
 * releases it too (the tree is clean by precondition).
 */
export async function pushFiledCommit(options: {
  readonly dataRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onProgress?: (message: string) => void;
}): Promise<void> {
  const onProgress = options.onProgress ?? (() => {});
  const prepared = await preparePush(options);

  if (prepared.kind === "refused") {
    throw new Error(prepared.reason);
  }

  const { git, marker, head, remoteOid } = prepared;
  const branchRef = `refs/heads/${marker.branch}`;

  if (remoteOid === head) {
    onProgress(
      `already on the remote — ${branchRef} reads ${head.slice(0, 8)}`,
    );

    return;
  }

  const refusal = await requireFilingDescendant(
    git,
    branchRef,
    remoteOid,
    head,
  );

  if (refusal !== undefined) {
    throw new Error(refusal);
  }

  const lease = await acquirePushLease({ git, marker, base: remoteOid });

  onProgress(
    `shared-writer: lease ${lease.oid.slice(0, 8)} acquired for the push`,
  );

  try {
    await git(["push", marker.remote, `${head}:${branchRef}`]);

    const pushed = await lsRemoteOid(git, marker.remote, branchRef);

    if (pushed !== head) {
      throw new Error(
        `push reported success but ${branchRef} reads ${pushed ?? "absent"}, expected ${head} — fail closed`,
      );
    }

    onProgress(
      `pushed ${head.slice(0, 8)} to ${marker.remote} ${branchRef} (fast-forward)`,
    );
  } finally {
    try {
      onProgress(
        await releaseOwnLease({
          git,
          remote: marker.remote,
          leaseRef: marker.leaseRef,
          ownOid: lease.oid,
        }),
      );
    } catch (releaseError) {
      onProgress(
        `shared-writer: lease release failed — retained: ${errorMessage(releaseError)}`,
      );
    }
  }
}
