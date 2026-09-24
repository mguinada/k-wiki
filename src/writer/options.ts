/**
 * The shared-writer coordinator's option and outcome types (issue
 * #390): the contract every writer module and both CLI doors share,
 * split into its own module so the coordinator, the precondition
 * steps, and the leased tenure depend on types — not on each other's
 * module graphs.
 */

import type { RunContext } from "../cli/run-context.ts";
import type { AgentRunner } from "../ingest/agent-run.ts";
import type { SyncConfig } from "../sync/config.ts";
import type { WikiSyncResult } from "../sync/wiki-sync.ts";
import type { GitRunner } from "./git-remote.ts";

/** Everything one shared-mode cycle needs — the wiki-sync options'
 *  surface plus the coordinator's own inputs. */
export interface SharedCycleOptions {
  readonly run: RunContext;
  readonly config: SyncConfig;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
  readonly promptsDir: string;
  readonly timeoutMs?: number | undefined;
  readonly heartbeatMs?: number | undefined;
  readonly runAgent?: AgentRunner | undefined;
  /** `--removal-receipt <path>`: the confirming rerun's receipt. */
  readonly removalReceiptPath?: string | undefined;
  /** The scheduled wrapper's full-lint sweep, run inside the lease
   *  tenure before the cycle (its edits ride the cycle's commit). */
  readonly runSweep?: (() => Promise<void>) | undefined;
  /** Injectable git runner; defaults to the data repo's real git. */
  readonly git?: GitRunner | undefined;
  /** Injectable holder name (tests); defaults to hostname:pid. */
  readonly holder?: string | undefined;
}

/** The cycle's outcome: refused = a precondition failed before any
 *  mutation (print the reason, exit 1); completed = the ordinary
 *  cycle ran under the lease and the remote was finalized or the
 *  lease cleanly released. */
export type SharedCycleOutcome =
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "completed"; readonly result: WikiSyncResult };

/** Where the run is in its tenure — the failure rules key on it:
 *  once finalization begins, a failure retains the lease no matter
 *  how clean the tree (the commit is local-only; releasing would
 *  strand it). */
export type Phase = "prepare" | "cycle" | "finalize";
