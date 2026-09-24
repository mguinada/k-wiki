/**
 * writer-lease (issue #390): the human door to the shared-writer
 * lease. `status` observes the live lease read-only — OID, holder,
 * expiry, base, renewal count — plus the marker's presence, so an
 * operator on any Mac can see who holds the write. `takeover` is the
 * one exceptional recovery: it replaces the lease by exact expected
 * OID with explicit confirmation, no expiry requirement, and there
 * is deliberately no generic force-unlock — quoting the exact OID is
 * what separates a considered recovery from a blind one.
 */

import { join } from "node:path";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";
import { type GitRunner, gitRunnerFor, lsRemoteOid } from "./git-remote.ts";
import {
  casPush,
  LEASE_PROTOCOL_VERSION,
  leaseExpired,
  observeLease,
} from "./lease.ts";
import { readSharedWriterMarker } from "./marker.ts";
import { resolveDataRootFromArgs } from "./resolve.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI
 *  rule). */
const HELP = `Usage: writer-lease [-h | --help] status [<config>] [<raw-dir>]
       writer-lease takeover --expected <oid> --confirm [<config>] [<raw-dir>]

Inspect or recover the shared-writer lease of a marker-enabled data
repo. The lease is the remote ref that serializes every manual and
scheduled cycle; it is normally owned by whichever writer holds it
and released (or taken over) by the protocol itself.

  status    Observe the live lease read-only: marker presence, the
            lease OID, holder, acquired/expiry timestamps, base
            commit, and renewal count, plus whether the lease is
            expired. No lease held is a normal state and exits 0; a
            malformed marker or unreadable lease fails closed
            (exit 1).

  takeover  Re-open the lane by deleting the exact expected lease —
            the exceptional recovery for a holder that died with the
            lease live. Requires the full lease OID as reported by
            status and an explicit --confirm; it refuses a lease
            that no longer reads as the expected OID (someone else
            moved it), and there is no generic force-unlock. The
            deleted holder's fenced finalize push still fails, so a
            live writer can never be silently overridden.

  --expected <oid>  The exact lease OID to replace (takeover only).
  --confirm         Required: the takeover happens when both the OID
                    and this flag are present (takeover only).
  -h, --help        Print this help and exit; no side effects.
  <config>          Path to sync.json. Default: the repo's own
                    sync.json.
  <raw-dir>         Whose parent data repo to inspect. Default:
                    <dataRoot>/raw from the config, otherwise the
                    repo's own raw/.

What it writes: nothing on disk. status prints the lease's fields;
takeover prints the replacement lease's OID and expiry. Exit 0 on a
completed read or takeover, 1 on a refusal or failure. Errors print
red, prefixed "writer-lease:"; progress goes to stderr; NO_COLOR is
honored.`;

/** Print one usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("writer-lease", message);
}

/** The status verb: read-only lease observation. */
async function statusVerb(git: GitRunner, dataRoot: string): Promise<void> {
  const marker = await readSharedWriterMarker(dataRoot);

  if (marker.kind === "absent") {
    console.log(
      "shared-writer mode: not enabled (no marker) — no lease applies",
    );

    return;
  }

  if (marker.kind === "invalid") {
    throw new Error(
      `shared-writer marker invalid — failing closed: ${marker.reason}`,
    );
  }

  const lease = await observeLease(
    git,
    marker.marker.remote,
    marker.marker.leaseRef,
  );

  if (lease === undefined) {
    console.log(
      `lease ${marker.marker.leaseRef}: none held — the writer lane is free`,
    );

    return;
  }

  const expired = leaseExpired(lease.body, () => new Date());

  console.log(`lease ${marker.marker.leaseRef} @ ${lease.oid}`);
  console.log(
    `  holder:    ${lease.body.holder}${expired ? " (EXPIRED — a cycle may take it over; humans may take it over by exact OID)" : " (live)"}`,
  );
  console.log(`  acquired:  ${lease.body.acquired}`);
  console.log(`  expires:   ${lease.body.expires}`);
  console.log(`  base:      ${lease.body.base.slice(0, 8)}`);
  console.log(`  renewals:  ${lease.body.renewals}`);
  console.log(
    `  protocol:  v${LEASE_PROTOCOL_VERSION}, token ${lease.body.token.slice(0, 8)}…`,
  );
  console.log(
    expired
      ? "next cycle takes this lease over automatically; nothing to do"
      : `to recover early: writer-lease takeover --expected ${lease.oid} --confirm`,
  );
}

/** The takeover verb: exact-OID, confirmed replacement. */
async function takeoverVerb(
  git: GitRunner,
  dataRoot: string,
  expected: string,
  confirmed: boolean,
): Promise<void> {
  const marker = await readSharedWriterMarker(dataRoot);

  if (marker.kind !== "enabled") {
    throw new Error(
      marker.kind === "absent"
        ? "shared-writer mode is not enabled on this data repo — nothing to take over"
        : `shared-writer marker invalid — failing closed: ${marker.reason}`,
    );
  }

  if (!confirmed) {
    throw new Error("takeover requires --confirm — it replaces a live lease");
  }

  if (!/^[0-9a-f]{40}$/.test(expected)) {
    throw new Error(
      "--expected must be the full 40-character lease OID as reported by writer-lease status",
    );
  }

  const observed = await observeLease(
    git,
    marker.marker.remote,
    marker.marker.leaseRef,
  );

  if (observed === undefined) {
    throw new Error(
      `no lease is live on ${marker.marker.leaseRef} — nothing to take over`,
    );
  }

  const live = await lsRemoteOid(
    git,
    marker.marker.remote,
    marker.marker.leaseRef,
  );

  if (live !== expected) {
    throw new Error(
      `the lease no longer reads ${expected} (it reads ${live ?? "gone"}) — refusing; re-run status and quote the current OID`,
    );
  }

  // Re-open the lane: a fenced, compare-and-swap delete of the exact
  // quoted lease. The stale holder's atomic finalize still fails —
  // its delete update targets an absent ref, and an atomic push
  // refuses as a whole. There is no unlocked-gap hazard: the next
  // acquirer creates by compare-and-swap on an absent ref, the same
  // race every normal acquire runs.
  await casPush(git, marker.marker.remote, [
    { ref: marker.marker.leaseRef, deleted: true, expectedOid: expected },
  ]);

  const after = await lsRemoteOid(
    git,
    marker.marker.remote,
    marker.marker.leaseRef,
  );

  if (after !== undefined) {
    throw new Error(
      `lease ${marker.marker.leaseRef} still present after takeover — fail closed`,
    );
  }

  console.log(
    `lease ${expected.slice(0, 8)} taken over and released — the lane is free; the previous holder's fenced finalize push will fail`,
  );
}

/** The CLI entry point. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    value: ["--expected"],
    boolean: ["--confirm"],
    positionals: {
      max: 3,
      error: (_arg, count) =>
        `expected at most three arguments (verb, <config>, <raw-dir>), got ${count}`,
    },
  });

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const verb = parsed.positional[0];
  const configPath = parsed.positional[1] ?? join(repoRoot, "sync.json");
  const resolved = await resolveDataRootFromArgs(
    configPath,
    parsed.positional[2],
  );

  if (resolved.error !== undefined) {
    fail(resolved.error);

    return;
  }

  const git = gitRunnerFor({
    dir: resolved.dataRoot,
    env: process.env,
  });

  try {
    await dispatchVerb(verb, git, resolved.dataRoot, {
      expected: parsed.values.get("--expected") ?? "",
      confirmed: parsed.flags.has("--confirm"),
    });
  } catch (error) {
    fail(errorMessage(error));
  }
}

/** Route one verb; undefined or unknown verbs are usage errors. */
async function dispatchVerb(
  verb: string | undefined,
  git: GitRunner,
  dataRoot: string,
  takeover: { readonly expected: string; readonly confirmed: boolean },
): Promise<void> {
  if (verb === "status") {
    await statusVerb(git, dataRoot);

    return;
  }

  if (verb === "takeover") {
    await takeoverVerb(git, dataRoot, takeover.expected, takeover.confirmed);

    return;
  }

  fail(
    verb === undefined
      ? "expected a verb: status or takeover"
      : `unknown verb ${JSON.stringify(verb)} — expected status or takeover`,
  );
}

/* v8 ignore next: covered only under direct `node src/writer/writer-lease.ts` runs */
refuseDirectExecution(import.meta.url, "writer-lease");
