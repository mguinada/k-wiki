/**
 * enable-shared-writer (issue #390): the human door that opts a
 * remote-backed data repo into shared-writer mode. The marker it
 * commits — `.k-wiki/shared-writer.json` at the data repo root — is
 * operator-owned and visible to every checkout; no per-machine
 * switch exists to forget. Enablement is itself serialized: after a
 * live capability probe of the configured remote, it acquires the
 * same bootstrap lease the cycles use, re-fetches and
 * fast-forwards, then publishes the marker commit and deletes the
 * exact lease in one atomic push. A competing enablement or a remote
 * advance fails the whole attempt without a partial marker; the
 * command resets the marker commit it made and never pushes it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";
import { refuseDirtyWorkingTree } from "./cycle-steps.ts";
import {
  classifyPosition,
  currentBranch,
  fetchRefspec,
  type GitRunner,
  gitOk,
  gitRunnerFor,
  lsRemoteOid,
  mergeFfOnly,
} from "./git-remote.ts";
import { leaseHolder } from "./lease.ts";
import {
  acquireLease,
  fetchedTreeOid,
  finalizeWithLeaseRelease,
  releaseOwnLease,
} from "./lease-ops.ts";
import { LEASE_REF_NAMESPACE, MARKER_PATH, markerIsEnabled, markerPath } from "./marker.ts";
import { probeRemoteCapabilities, reportProbe } from "./probe.ts";
import { resolveDataRootFromArgs } from "./resolve.ts";

/** The v1 lease ref every enable writes into the marker. */
const DEFAULT_LEASE_REF = `${LEASE_REF_NAMESPACE}shared-writer-v1`;

/** Help text: every switch, argument, and default (AGENTS.md CLI
 *  rule). */
const HELP = `Usage: enable-shared-writer [-h | --help] [<config>] [<raw-dir>]

Opt the data repo into shared-writer mode: manual wiki-sync and
scheduled-run cycles then serialize through one remote lease on the
configured origin (a lease held elsewhere refuses this machine; an
expired lease is taken over by exact OID), every cycle begins from
the canonical remote tree, and a content commit is pushed before the
lease is released. The switch is a tracked marker at the data repo
root, committed and pushed by this command — visible to every
checkout, never a per-machine setting.

What it does, in order:
  1. verifies the data repo: a configured origin, a clean checkout
     (the run lock is allowed state), on a branch that fast-forwards
     to origin;
  2. probes the remote's live capabilities with disposable refs —
     custom refs under refs/k-wiki/, exact-OID compare-and-swap
     replacement, and the conditional atomic finalization — refusing
     without writing anything when the remote cannot do them;
  3. acquires the bootstrap lease, re-fetches, fast-forwards;
  4. commits the marker and pushes it together with the exact lease
     delete in one atomic push, verifying the remote head after.

  -h, --help     Print this help and exit; no side effects.
  <config>       Path to sync.json. Default: the repo's own sync.json.
  <raw-dir>      Whose parent data repo to enable. Default:
                 <dataRoot>/raw from the config, otherwise the repo's
                 own raw/.

What it writes: .k-wiki/shared-writer.json in the data repo, one
commit and one push on it. A refused or failed attempt leaves the
remote untouched (probe refs are verified removed or named for manual
deletion) and resets the marker commit it made. Manual shared mode
pushes by design: enabling this command is the operator's consent.
Errors print red and exit 1; progress goes to stderr; NO_COLOR is
honored.`;

/** Print one usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("enable-shared-writer", message);
}

/** The marker document this command writes (schema v1). */
function markerDocument(branch: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      remote: "origin",
      branch,
      leaseRef: DEFAULT_LEASE_REF,
      sourceRemovalPolicy: "confirm",
    },
    null,
    2,
  )}\n`;
}

/** Step 1's clean/current verification: refusal text or undefined. */
async function cleanCurrentRefusal(
  git: GitRunner,
  dataRoot: string,
): Promise<string | undefined> {
  const dirty = await refuseDirtyWorkingTree(git);

  if (dirty !== undefined) {
    return dirty;
  }

  if (!(await gitOk(git, ["remote", "get-url", "origin"]))) {
    return "the data repo has no origin remote — shared-writer mode serializes through one";
  }

  if (dataRoot.trim() === "") {
    return "internal: empty data root";
  }

  return undefined;
}

/** One enable attempt: the lease, if acquired, is released on failure. */
export async function enable(dataRoot: string): Promise<string> {
  const env = process.env;
  const git = gitRunnerFor({ dir: dataRoot, env });
  const clean = await cleanCurrentRefusal(git, dataRoot);

  if (clean !== undefined) {
    throw new Error(clean);
  }

  if (await markerIsEnabled(dataRoot)) {
    return `shared-writer mode already enabled (marker at ${MARKER_PATH})`;
  }
  const branch = await currentBranch(git);

  if (branch === undefined) {
    throw new Error("the data repo is on a detached HEAD — check out a branch");
  }

  await fetchRefspec(git, "origin", `refs/heads/${branch}`);

  const remoteOid = await lsRemoteOid(git, "origin", `refs/heads/${branch}`);

  if (remoteOid === undefined) {
    throw new Error(
      `origin has no refs/heads/${branch} — push the data repo's branch first`,
    );
  }

  const position = await classifyPosition(git, remoteOid);

  if (position === "behind") {
    await mergeFfOnly(git, "FETCH_HEAD");
  } else if (position !== "up-to-date") {
    throw new Error(
      "the data repo is ahead of or diverged from origin — resolve manually before enabling",
    );
  }

  if (await markerIsEnabled(dataRoot)) {
    return `shared-writer mode already enabled (marker at ${MARKER_PATH})`;
  }

  const treeOid = await fetchedTreeOid(git);
  const probe = await probeRemoteCapabilities({
    git,
    remote: "origin",
    treeOid,
    now: () => new Date(),
    holder: leaseHolder(),
    onProgress: (message) => console.error(message),
  });

  reportProbe(probe);

  if (!probe.ok) {
    throw new Error(
      "the remote does not support the shared-writer protocol — marker not written",
    );
  }

  return await commitMarkerUnderLease(dataRoot, git, branch, treeOid);
}

/** Bootstrap lease, marker commit, and atomic finalize. */
async function commitMarkerUnderLease(
  dataRoot: string,
  git: GitRunner,
  branch: string,
  treeOid: string,
): Promise<string> {
  const outcome = await acquireBootstrapLease(git, treeOid);

  try {
    await fetchRefspec(
      git,
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    );
    await mergeFfOnly(git, `origin/${branch}`);

    if (await markerIsEnabled(dataRoot)) {
      await releaseIfOwn(git, outcome.oid);

      return `shared-writer mode already enabled (marker at ${MARKER_PATH})`;
    }

    const path = markerPath(dataRoot);

    await mkdir(join(dataRoot, ".k-wiki"), { recursive: true });
    await writeFile(path, markerDocument(branch));
    await git(["add", "--", MARKER_PATH]);
    await git(["commit", "-m", "enable shared-writer mode (v1)"]);

    const markerHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

    try {
      await finalizeWithLeaseRelease({
        git,
        remote: "origin",
        branchRef: `refs/heads/${branch}`,
        leaseRef: DEFAULT_LEASE_REF,
        newBranchOid: markerHead,
        leaseOid: outcome.oid,
      });
    } catch (error) {
      await resetOwnCommit(git, markerHead, error);
      throw error;
    }

    return `shared-writer mode enabled — ${branch} advanced to ${markerHead.slice(0, 8)} with the marker (${MARKER_PATH})`;
  } catch (error) {
    await releaseIfOwn(git, outcome.oid);

    throw error;
  }
}

/** The bootstrap lease acquire, with a refuse that names the holder. */
async function acquireBootstrapLease(
  git: GitRunner,
  treeOid: string,
): Promise<{ readonly oid: string }> {
  const attempt = await acquireLease({
    git,
    remote: "origin",
    leaseRef: DEFAULT_LEASE_REF,
    treeOid,
    base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
    now: () => new Date(),
    holder: leaseHolder(),
  });

  if (attempt.status === "refused") {
    throw new Error(
      `cannot enable while another writer holds the lease — ${attempt.reason}`,
    );
  }

  return attempt.lease;
}

/** Reset the marker commit this command made (never pushed): only
 *  while HEAD still is that exact commit — a commit that landed
 *  meanwhile belongs to another writer and must survive. The failed
 *  finalize's own error rides along as the cause. */
async function resetOwnCommit(
  git: GitRunner,
  markerHead: string,
  finalizeError: unknown,
): Promise<void> {
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();

  if (head !== markerHead) {
    throw new Error(
      `finalize failed and HEAD is no longer this enable's marker commit (HEAD ${head.slice(0, 8) || "unresolved"}, marker ${markerHead.slice(0, 8)}) — nothing was reset; remove the unpushed marker commit by hand`,
      { cause: finalizeError },
    );
  }

  await git(["reset", "--hard", `${markerHead}~1`]);
}

/** Best-effort release of the exact bootstrap lease. */
async function releaseIfOwn(git: GitRunner, oid: string): Promise<void> {
  try {
    await releaseOwnLease({
      git,
      remote: "origin",
      leaseRef: DEFAULT_LEASE_REF,
      ownOid: oid,
    });
  } catch {
    // The lease expires in four hours; take over by exact OID then.
  }
}

/** The CLI entry point: parse, resolve the data repo, enable. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    positionals: {
      max: 2,
      error: (_arg, count) =>
        `expected at most two arguments (<config> and <raw-dir>), got ${count}`,
    },
  });

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const configPath = parsed.positional[0] ?? join(repoRoot, "sync.json");
  const resolved = await resolveDataRootFromArgs(
    configPath,
    parsed.positional[1],
  );

  if (resolved.error !== undefined) {
    fail(resolved.error);

    return;
  }

  try {
    console.log(await enable(resolved.dataRoot));
  } catch (error) {
    fail(errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/writer/enable-shared-writer.ts` runs */
refuseDirectExecution(import.meta.url, "enable-shared-writer");
