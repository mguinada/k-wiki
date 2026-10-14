/**
 * Sanitized lease-maintenance observability (issue #464): one log
 * line per lease maintenance step (renew / take-over / retain /
 * release), rendered over the run's progress sink in the dim class.
 * The line names the maintenance verb, the lease ref, the own (or
 * current) OID short, the tree-read exit status, the step's duration,
 * and the shared fetch-head file's `{exists, size}` state — so an
 * external git process emptying that file ambiently becomes
 * attributable from surviving logs without this module reading,
 * writing, or merging through it: not its contents, tokens,
 * credentials, or any child stderr. The module's one git-dir stat of
 * the file is the guard's documented diagnostic-only exception.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "./git-remote.ts";
import { gitOut } from "./git-remote.ts";

/** The maintenance verbs the writer runtime reports. */
export type MaintenanceVerb = "renew" | "take-over" | "retain" | "release";

/** One maintenance step, as it lands in the line. */
export interface MaintenanceObservation {
  readonly verb: MaintenanceVerb;
  /** The lease ref the step acted on. */
  readonly ref: string;
  /** The own (or current) lease OID the step held. */
  readonly oid: string;
  /** Whether the step's tree read succeeded, or degraded to the
   *  retention's last-known-tree fallback (issue #464). */
  readonly treeRead: "ok" | "degraded";
  /** Wall-clock duration of the whole step, milliseconds. */
  readonly durationMs: number;
}

/** The dim renderer the caller binds: the terminalColors context is
 *  the caller's render boundary (its run env), and no file contents
 *  ever reach the line. */
export type DimRender = (text: string) => string;

/** The shared fetch-head file's state, `{exists, size}` only. This
 *  stat is the no-fetch-head guard's (issue #464) one documented
 *  diagnostic-only exception: the file is referenced here as a
 *  filesystem path for its `{exists, size}` state alone — FETCH_HEAD
 *  or its resolved path is never passed to git as a ref or refspec,
 *  its contents are never read or returned, and no operational
 *  behavior (ref selection, tree resolution, merge, retention,
 *  fencing) branches on it. */

/** The `{exists, size}` state of the shared fetch-head file, best
 *  effort: an unreadable git dir or missing file yields the absent
 *  state. Never an error path — observability must not fail a step. */
export async function fetchHeadState(
  git: GitRunner,
): Promise<{ exists: boolean; size: number }> {
  try {
    const gitDir = await gitOut(git, ["rev-parse", "--absolute-git-dir"]);
    const info = await stat(join(gitDir, "FETCH_HEAD"));

    return { exists: true, size: info.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

/** The dim-class maintenance line for one step; the caller supplies
 *  the dim render bound to its own NO_COLOR-honoring terminalColors. */
export function maintenanceLine(options: {
  readonly obs: MaintenanceObservation;
  readonly fetchHead: { exists: boolean; size: number };
  readonly dim: DimRender;
}): string {
  const { obs, fetchHead, dim } = options;

  return dim(
    `shared-writer: lease maintenance ${obs.verb} — ref ${obs.ref}, ` +
      `own ${obs.oid.slice(0, 8)}, tree read ${obs.treeRead}, ` +
      `dur ${Math.round(obs.durationMs)}ms, ` +
      `FETCH_HEAD {exists: ${fetchHead.exists}, size: ${fetchHead.size}}`,
  );
}

/** Report one maintenance step at the render boundary: the fetch-head
 *  state is observed first (it can only fail into the absent state)
 *  and the line always lands. */
export async function reportMaintenance(
  git: GitRunner,
  options: {
    readonly onProgress: (message: string) => void;
    readonly obs: MaintenanceObservation;
    readonly dim: DimRender;
  },
): Promise<void> {
  const { onProgress, obs, dim } = options;

  onProgress(
    maintenanceLine({ obs, fetchHead: await fetchHeadState(git), dim }),
  );
}
