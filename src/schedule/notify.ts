/**
 * The macOS notification surface (issue #362): one best-effort
 * `osascript display notification` call shared by the scheduled
 * wrapper's in-process ALERT path and the sync-watchdog's stale
 * verdict — pipeline failures reach the operator's screen instead
 * of a log nobody reads. The pipeline is macOS-only by design (the
 * vault lives in iCloud), so osascript covers every host that can
 * run the schedule; no new dependency. KWIKI_NOTIFY=0 disables
 * every notification (tests, e2e, quiet hosts) — the same
 * environment-override shape as NO_COLOR and KWIKI_SCHEDULED_LOG.
 */

import { spawn } from "node:child_process";

/** The minimal child surface notifyUser needs: a `once` that can
 *  register error/close listeners. The real spawn's ChildProcess
 *  satisfies it structurally; tests fake it with an EventEmitter. */
export interface NotifiedProcess {
  once(event: string, listener: () => void): unknown;
}

/** The spawn function notifyUser runs; injectable for tests. */
export type NotifySpawner = (
  command: string,
  args: readonly string[],
  spawnOptions: { readonly stdio: "ignore" },
) => NotifiedProcess;

/** Fire one macOS notification. Best-effort by contract: a missing
 *  osascript, a non-darwin host, or KWIKI_NOTIFY=0 all stay silent,
 *  and the call never throws — notification is a courtesy layer,
 *  never a failure mode of the pipeline that fires it. */
export async function notifyUser(
  title: string,
  message: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly notifyDisabled?: boolean;
    readonly spawner?: NotifySpawner;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const disabled = options.notifyDisabled ?? process.env.KWIKI_NOTIFY === "0";

  if (platform !== "darwin" || disabled) {
    return;
  }

  const spawner = options.spawner ?? spawn;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;

  await new Promise<void>((resolve) => {
    const child = spawner("osascript", ["-e", script], { stdio: "ignore" });

    // Either terminal event settles the promise; the first wins and
    // the second is a no-op (a Promise resolves once).
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}
