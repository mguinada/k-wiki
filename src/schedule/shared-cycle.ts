/**
 * The scheduled cycle's shared-writer mode (issue #390): the wrapper
 * keeps its schedule, logs, heartbeat, and local run-lock duties,
 * and delegates the remote work to the same coordinator manual
 * wiki-sync runs — no pull, no push. A malformed marker fails loud
 * before any source scan; the full-lint sweep runs inside the lease
 * tenure as the coordinator's runSweep step.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { runContext } from "../cli/run-context.ts";
import { repoRoot } from "../cli/shared.ts";
import { agentRunFlags } from "../cli/shell.ts";
import { loadSyncConfig } from "../sync/config.ts";
import { readSharedWriterMarker } from "../writer/marker.ts";
import {
  buildScheduledEnv,
  DEFAULT_LINT_FULL_TIMEOUT_MS,
  parseScheduledRunArgs,
  type ScheduledRunOptions,
  spawnRepoScript,
  sweepArgsFor,
} from "./scheduled-run.ts";

/** Whether this cycle runs in shared-writer mode: the data repo
 *  carries a valid marker (issue #390). A malformed marker fails the
 *  cycle loud — fail closed before any source scan — never silently
 *  downgraded to local mode. */
export async function scheduledSharedMode(
  options: ScheduledRunOptions,
): Promise<boolean> {
  const read = await readSharedWriterMarker(options.dataRoot);

  if (read.kind === "invalid") {
    throw new Error(
      `shared-writer marker invalid — failing closed: ${read.reason}`,
    );
  }

  return read.kind === "enabled";
}

/** The shared-mode pipeline: no pull, no push — the wrapper keeps
 *  its schedule, logs, heartbeat, and local run lock, and the
 *  coordinator (the same state machine manual wiki-sync runs) does
 *  fetch, lease, fast-forward, cycle, and the atomic finalize. The
 *  full-lint sweep runs inside the lease tenure as the coordinator's
 *  runSweep step (its edits ride the cycle's commit). */
export async function runSharedPipeline(
  options: ScheduledRunOptions,
  log: (line: string) => void,
): Promise<void> {
  const args = options.args ?? [];
  const parsed = parseScheduledRunArgs(args);
  const runFlags = agentRunFlags(parsed.values);

  if (runFlags.error !== undefined) {
    throw new Error(runFlags.error);
  }

  // The parsed positionals, never the raw argv head — value flags
  // (--settings, --outputs, --timeout) precede them.
  const configPath = parsed.positional[0] ?? join(repoRoot, "sync.json");
  const rawDirArg = parsed.positional[1];
  const config = await loadSyncConfig(configPath, homedir());
  const rawDir = rawDirArg ?? join(options.dataRoot, "raw");
  const { runSharedCycle } = await import("../writer/coordinator.ts");

  log("scheduled-run: shared-writer mode — delegating to the coordinator");

  const outcome = await runSharedCycle({
    run: runContext({
      rawDir,
      env: {
        ...process.env,
        ...buildScheduledEnv(process.env.HOME ?? homedir(), process.execPath),
      },
      onProgress: (message) => log(message),
    }),
    config,
    configPath,
    settingsPath: runFlags.settings ?? join(options.repoRoot, "settings.yml"),
    outputsDir: runFlags.outputs ?? join(options.repoRoot, "outputs"),
    promptsDir: join(options.repoRoot, "prompts"),
    timeoutMs: runFlags.timeoutMs,
    runSweep:
      options.lintFull === true ? () => runSweepStep(options, log) : undefined,
  });

  if (outcome.status === "refused") {
    throw new Error(outcome.reason);
  }
}

/** The full-lint sweep as the coordinator's runSweep step: the same
 *  wiki-lint --full spawn the local pipeline uses, streamed into the
 *  log. */
async function runSweepStep(
  options: ScheduledRunOptions,
  log: (line: string) => void,
): Promise<void> {
  const timeoutMs = options.lintFullTimeoutMs ?? DEFAULT_LINT_FULL_TIMEOUT_MS;
  const runLintFull =
    options.runLintFull ??
    (async (lintArgs: readonly string[]) => {
      await spawnRepoScript(options.repoRoot, "wiki-lint", lintArgs, log);
    });

  log(`scheduled-run: wiki-lint --full starting (budget ${timeoutMs / 1000}s)`);
  await runLintFull(sweepArgsFor(options, timeoutMs));
  log("scheduled-run: wiki-lint --full finished — running the cycle");
}
