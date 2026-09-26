/**
 * The scheduled run's environment (issue #14) and its child scripts:
 * `buildScheduledEnv` is the HOME/PATH an unattended launchd child
 * gets — extended past launchd's minimal PATH so the wrapper's own
 * CLIs resolve, and carrying `KWIKI_RUN_LOCK_HELD` plus the
 * launcher-resolved absolute agent path (`KWIKI_AGENT_COMMAND`,
 * issue #399) — and `spawnRepoScript` runs one of the repo's bin/
 * doors as a child with exactly that env, its stdout and stderr
 * streamed into the run log without tearing lines (issue #244 — a
 * chunk can end mid-line, so each pipe buffers its own tail).
 * Extracted from scheduled-run.ts — the env the children run in is
 * its own concern, separate from the cycle that orders them.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { AGENT_COMMAND_ENV } from "../cli/env.ts";

/** The PATH a scheduled run gets: node's bin dir first (the wrapper
 *  and any sibling CLIs), then the standard install locations — the
 *  agent CLI resolves with no interactive shell env (issue #14).
 *  It also carries `KWIKI_RUN_LOCK_HELD=1`: this wrapper already
 *  holds the run lock across the whole cycle, so the spawned
 *  wiki-sync child must not re-acquire it (issue #313).
 *  ponytail: unix PATH layout; revisit when a Windows scheduler
 *  backend lands (issue #14 follow-up) — delimiter and dirs differ. */
export function buildScheduledEnv(
  home: string,
  execPath: string,
  agentCommand?: string | undefined,
): NodeJS.ProcessEnv & { readonly PATH: string } {
  const nodeBin = dirname(execPath);

  return {
    HOME: home,
    KWIKI_RUN_LOCK_HELD: "1",
    // The launcher-resolved absolute agent path (issue #399): the
    // launchd PATH cannot resolve a bare agent name, so the children
    // spawn exactly the binary the launcher found.
    ...(agentCommand === undefined
      ? {}
      : { [AGENT_COMMAND_ENV]: agentCommand }),
    PATH: [
      nodeBin,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
  };
}

/** Stream one child pipe into the log without tearing lines
 *  (issue #244): a chunk can end mid-line, so each pipe
 *  buffers its own tail and only complete `\n`-terminated lines are
 *  recorded; a final fragment without a newline is flushed at end. */
function streamChildLines(source: Readable, log: (line: string) => void): void {
  let pending = "";

  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    pending += chunk;
    const cut = pending.lastIndexOf("\n");

    if (cut === -1) {
      return;
    }

    const complete = pending.slice(0, cut);
    pending = pending.slice(cut + 1);

    for (const line of complete.split("\n")) {
      if (line !== "") {
        log(line);
      }
    }
  });
  source.on("end", () => {
    if (pending !== "") {
      log(pending);
      pending = "";
    }
  });
}

/** Run one of the repo's bin/ scripts as a child with the scheduled
 *  env, streaming its stdout and stderr into the log. The env
 *  carries the launcher-resolved absolute agent path when the cycle
 *  resolved one (issue #399). */
export async function spawnRepoScript(
  repoRoot: string,
  name: string,
  args: readonly string[],
  log: (line: string) => void,
  agentCommand?: string | undefined,
): Promise<void> {
  const env = buildScheduledEnv(
    process.env.HOME ?? homedir(),
    process.execPath,
    agentCommand,
  );
  const child = spawn(
    process.execPath,
    [join(repoRoot, "bin", name), ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  streamChildLines(child.stdout, log);
  streamChildLines(child.stderr, log);

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", resolveCode);
  });

  if (code !== 0) {
    // code is null exactly when a signal killed the child — name it
    // instead of reporting "exited null" (issue #244).
    throw new Error(
      child.signalCode === null
        ? `${name} exited ${code}`
        : `${name} exited by signal ${child.signalCode}`,
    );
  }
}
