/**
 * recover-fix-surface (issue #400): the human door to a failed
 * shared-writer cycle's fix surface. When a cycle fails mid-run the
 * coordinator retains its lease over the dirty paths and records
 * exactly that surface (paths, content hashes, lease ref + OID +
 * holder + expiry) in the data repo's git dir. This verb shows that
 * record — default action — and, with an explicit `recover` plus
 * `--yes`, discards exactly the recorded paths and settles the
 * lease. Anything else dirty on disk is a refusal: a human edit
 * made after the failure is never eaten.
 */

import { join } from "node:path";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { type ParsedCli, parseArgs } from "../cli/shell.ts";
import { type GitRunner, gitRunnerFor } from "./git-remote.ts";
import { leaseExpired, leaseHolder, type ObservedLease } from "./lease.ts";
import { readSharedWriterMarker, type SharedWriterMarker } from "./marker.ts";
import {
  AUTO_RECOVERY_REFUSED_TICKS,
  recoverRecordedSurface,
} from "./recovery.ts";
import {
  divergenceMessage,
  divergenceOf,
  evaluateSurface,
  type LeaseSnapshot,
  type RecoveryRecord,
  readRecoveryRecord,
} from "./recovery-record.ts";
import { resolveDataRootFromArgs } from "./resolve.ts";

const NOTHING_RECORDED =
  "nothing to recover — no failed-cycle surface is recorded";

/** Help text: every switch, argument, and default (AGENTS.md CLI
 *  rule). */
const HELP = `Usage: recover-fix-surface [-h | --help] [show] [<config>] [<raw-dir>]
       recover-fix-surface recover --yes [<config>] [<raw-dir>]

Recover a failed shared-writer cycle's fix surface on a marker-
enabled data repo. When a cycle fails mid-run, its lease is retained
over the dirty paths it left and that exact surface is recorded
(paths, content hashes, lease ref, OID, holder, expiry). This verb
works only on that record — with nothing recorded it does nothing.

  show (default) Print the recorded surface: every path a recovery
                 would discard, the retained lease (ref, OID, holder,
                 expiry), its lapsed/live state, and the refused-tick
                 count toward the cycle's own auto-recovery. Refuses
                 when the live dirty set diverges from the record.

  recover        Discard exactly the recorded paths (tracked revert,
                 staged-add and untracked removal — never a repo-wide
                 reset or clean) and settle the lease by exact-OID
                 atomic replace with a short recovery lease. Requires
                 --confirm-grade explicitness via --yes. Refuses when
                 the live dirty set differs from the record — a human
                 edit made after the failure must never be eaten —
                 and when the recorded lease moved off its OID.

  --yes          Required for recover; the run happens only with it.
  -h, --help     Print this help and exit; no side effects.
  <config>       Path to sync.json. Default: the repo's own
                 sync.json.
  <raw-dir>      Whose parent data repo to inspect. Default:
                 <dataRoot>/raw from the config, otherwise the
                 repo's own raw/.

What it writes: show writes nothing. recover reverts the recorded
paths in the data repo's working tree and replaces the lease ref on
the remote (history and other paths untouched) and removes the
record. Exit 0 on a completed show or recovery, 1 on a refusal or
failure. Errors print red, prefixed "recover-fix-surface:";
NO_COLOR is honored. The cycle door recovers the same surfaces by
itself after three refused ticks — this verb is the immediate path.`;

/** Print one usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("recover-fix-surface", message);
}

/** The parsed invocation: the action (show by default) and the
 *  positional resolution inputs. */
interface Invocation {
  readonly action: "show" | "recover";
  readonly configPath: string;
  readonly rawDir: string | undefined;
}

/** The action word's resolution from the first positional: the named
 *  action, `show` for a path-like or absent positional, undefined
 *  for an unknown action word (the caller's usage error). */
function actionOf(first: string | undefined): "show" | "recover" | undefined {
  if (first === "show" || first === "recover") {
    return first;
  }

  if (first === undefined || first.includes("/") || first.includes(".")) {
    return "show";
  }

  return undefined;
}

/** Resolve the action and positionals: the action word is optional —
 *  with it, <config> and <raw-dir> shift one position; without it
 *  the default `show` runs over the given positionals. Undefined
 *  when the invocation already failed. */
function resolveInvocation(parsed: ParsedCli): Invocation | undefined {
  const first = parsed.positional[0];
  const action = actionOf(first);

  if (action === undefined) {
    fail(`unknown action ${JSON.stringify(first)} — expected show or recover`);

    return undefined;
  }

  const isAction = first === "show" || first === "recover";

  return {
    action,
    configPath:
      (isAction ? parsed.positional[1] : first) ?? join(repoRoot, "sync.json"),
    rawDir: isAction ? parsed.positional[2] : parsed.positional[1],
  };
}

/** The marker of an enabled data repo, or the standing refusals. */
async function requireEnabledMarker(
  dataRoot: string,
): Promise<SharedWriterMarker> {
  const marker = await readSharedWriterMarker(dataRoot);

  if (marker.kind === "absent") {
    throw new Error(
      "shared-writer mode is not enabled on this data repo — nothing to recover",
    );
  }

  if (marker.kind === "invalid") {
    throw new Error(
      `shared-writer marker invalid — failing closed: ${marker.reason}`,
    );
  }

  return marker.marker;
}

/** The show action: print exactly what a recovery would discard —
 *  paths, lease, expiry — refusing on divergence like the executor
 *  (the show must never describe a recovery that would be refused). */
async function runShow(
  git: GitRunner,
  marker: SharedWriterMarker,
): Promise<void> {
  const record = await readRecoveryRecord(git);

  if (record === undefined) {
    throw new Error(NOTHING_RECORDED);
  }

  const evaluation = await evaluateSurface({ git, marker, record });

  if (evaluation.livePaths.length === 0) {
    console.log("the recorded paths are currently clean on disk");
  } else if (divergenceOf(evaluation).length > 0) {
    throw new Error(divergenceMessage(divergenceOf(evaluation)));
  }

  const expired =
    evaluation.lease === undefined
      ? undefined
      : leaseExpired(evaluation.lease.body, NOW_WALLCLOCK);

  printShow(record, expired);
}

/** The wall clock — the verb is a human door with no injected clock. */
const NOW_WALLCLOCK = (): Date => new Date();

/** The show report: header, paths, lease, and tick count. */
function printShow(record: RecoveryRecord, expired: boolean | undefined): void {
  console.log(`recorded fix surface of cycle ${record.cycleId}:`);

  for (const path of record.paths) {
    console.log(`  ${path}`);
  }

  console.log(leaseLine(record.lease));

  if (expired !== undefined) {
    console.log(
      expired ? "lease state: lapsed" : "lease state: live (recovery waits)",
    );
  }

  console.log(
    `refused ticks toward auto-recovery: ${record.refusedTicks} of ${AUTO_RECOVERY_REFUSED_TICKS}`,
  );
  console.log(
    "a recovery discards exactly the paths above, then settles the lease",
  );
}

/** The lease line of the show report. */
function leaseLine(lease: LeaseSnapshot | null): string {
  return lease === null
    ? "lease: none was live at recording time"
    : `lease: ${lease.ref} @ ${lease.oid.slice(0, 8)} held by ${lease.holder}, expires ${lease.expires}`;
}

/** The recover action: discard the recorded surface and retake the
 *  lease, with the human door's explicitness and serialization. */
async function runRecover(
  git: GitRunner,
  marker: SharedWriterMarker,
): Promise<void> {
  const outcome = await recoverRecordedSurface({
    git,
    marker,
    now: NOW_WALLCLOCK,
    holder: leaseHolder(),
    retakeLease: true,
  });

  console.log(
    `discarded ${outcome.discarded.length} recorded path(s) from cycle ${outcome.cycleId}`,
  );
  console.log(recoveryLeaseLine(outcome.replacement));
  console.log("the next cycle runs clean");
}

/** The retake report line. */
function recoveryLeaseLine(replacement: ObservedLease | null): string {
  return replacement === null
    ? "no live lease to retake — the writer lane is free"
    : `lease retaken by exact OID: recovery lease ${replacement.oid.slice(0, 8)} held by you, expires ${replacement.body.expires} — the next cycle takes it over`;
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
    boolean: ["--yes"],
    positionals: {
      max: 3,
      error: (_arg, count) =>
        `expected at most three arguments (action, <config>, <raw-dir>), got ${count}`,
    },
  });

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const invocation = resolveInvocation(parsed);

  if (invocation === undefined) {
    return;
  }

  const resolved = await resolveDataRootFromArgs(
    invocation.configPath,
    invocation.rawDir,
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
    const marker = await requireEnabledMarker(resolved.dataRoot);

    if (invocation.action === "show") {
      await runShow(git, marker);

      return;
    }

    if (!parsed.flags.has("--yes")) {
      throw new Error(
        "recover requires --yes — it discards the recorded working-tree paths",
      );
    }

    await runRecover(git, marker);
  } catch (error) {
    fail(errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/writer/recover-fix-surface.ts` runs */
refuseDirectExecution(import.meta.url, "recover-fix-surface");
