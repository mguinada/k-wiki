/**
 * The agent run primitives: AgentRunner, spawnAgent (non-interactive
 * child run with timeout and output cap), runAgentTargets (the
 * ordered ingest target list tried in order over spawnAgent, with
 * the no-kept-output retry gate), and readPrompt. Shared by
 * wiki-ingest, wiki-sync, wiki-query, and k-wiki (extracted from
 * wiki-ingest.ts, issue #129); the stderr progress sink lives in
 * cli/progress.ts.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pluralized } from "../cli/shared.ts";
import { changedPaths } from "../data/git.ts";
import {
  type AgentSettings,
  type AgentTarget,
  agentArgs,
  agentCommandOverride,
  agentTargets,
  formatAgentInvocation,
  settingsForTarget,
  targetLabel,
} from "./agent-settings.ts";
import type { PreRunState } from "./guardrails.ts";

/** How the agent is invoked; injectable for tests. */
export type AgentRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number | undefined;
  },
) => Promise<{ stdout: string; stderr: string }>;

/** The agent gets 30 minutes by default; a hung run must not hang the wrapper. */
const AGENT_TIMEOUT_MS = 30 * 60_000;

/** Collected output cap: 16 MB, far above any final agent report. */
const AGENT_MAX_BUFFER = 16 * 1024 * 1024;

/** The last 500 characters of a buffer — where the failure lands. */
function tail(text: string): string {
  return text.slice(-500).trim();
}

/**
 * Run the agent CLI non-interactively, capturing its final output.
 * stdin is closed ("ignore"): an open pipe never reaching EOF makes
 * the agent wait on stdin forever — verified against pi 0.84.2, whose
 * `-p` mode reads stdin even when the prompt arrives via `--print`.
 * A run exceeding AGENT_TIMEOUT_MS is killed and reported as failed.
 */
export function spawnAgent(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number | undefined;
  },
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const seconds = Math.ceil(timeoutMs / 1000);

      reject(
        new Error(
          `agent ${command} timed out after ${pluralized(seconds, "second")}`,
        ),
      );
    }, timeoutMs);

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > AGENT_MAX_BUFFER) {
        child.kill("SIGKILL");

        return;
      }

      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`agent ${command} could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const out = Buffer.concat(stdout).toString("utf8");
      const errText = Buffer.concat(stderr).toString("utf8");

      if (code === 0) {
        resolve({ stdout: out, stderr: errText });

        return;
      }

      const why =
        signal !== null
          ? `killed with ${signal} (output over ${AGENT_MAX_BUFFER} bytes, or wrapper shutdown)`
          : `exited with code ${code}`;

      reject(new Error(`agent ${why}: ${tail(errText)}`));
    });
  });
}

/** The final error of a failed targets-list run: every tried target
 *  named in order. A legacy single-target run keeps its raw error. */
function labeledFailure(
  settings: AgentSettings,
  failures: readonly string[],
  cause: unknown,
): unknown {
  if (settings.targets === undefined) {
    return cause;
  }

  return new Error(`agent targets failed: ${failures.join("; ")}`, {
    cause,
  });
}

export async function runAgentTargets(
  settings: AgentSettings,
  prompt: string,
  options: {
    readonly root: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly timeoutMs?: number | undefined;
    readonly pre: PreRunState;
    readonly onProgress: (message: string) => void;
    readonly runAgent: AgentRunner;
  },
): Promise<{ stdout: string; agentError: unknown; target: AgentTarget }> {
  const targets = agentTargets(settings);
  const first = targets[0];

  if (first === undefined) {
    throw new Error("agent settings need at least one target");
  }

  const failures: string[] = [];
  let stdout = "";
  let agentError: unknown;
  let target = first;

  // A launcher that already resolved the agent binary to an absolute
  // path (the scheduled wrapper, issue #399) hands it over through
  // the environment; it wins over the settings' bare command name,
  // which the launchd PATH cannot resolve.
  const override = agentCommandOverride(options.environment);

  for (const [index, current] of targets.entries()) {
    target = current;
    const targetSettings = settingsForTarget(settings, target);
    const command = override ?? targetSettings.command;

    options.onProgress(
      `wiki-ingest: invoking agent: ${formatAgentInvocation({
        ...targetSettings,
        command,
      })}`,
    );

    try {
      ({ stdout } = await options.runAgent(
        command,
        agentArgs(targetSettings, prompt),
        {
          cwd: options.root,
          env: options.environment,
          timeoutMs: options.timeoutMs,
        },
      ));
      agentError = undefined;
      break;
    } catch (error) {
      agentError = error;
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${targetLabel(target)}: ${reason}`);

      if (
        index === targets.length - 1 ||
        (await changedPaths(options.root, options.environment, options.pre))
          .length > 0
      ) {
        break;
      }

      options.onProgress(
        `wiki-ingest: falling back to ${targetLabel(targets[index + 1] ?? target)} from ${targetLabel(target)}: ${reason}`,
      );
    }
  }

  if (agentError !== undefined) {
    agentError = labeledFailure(settings, failures, agentError);
  }

  return { stdout, agentError, target };
}

export async function readPrompt(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read prompt at ${path}`, { cause });
  }
}
