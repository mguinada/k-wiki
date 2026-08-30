import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createProgressRenderer, isWarning } from "../cli/progress.ts";

/**
 * The agent run primitives: AgentRunner, spawnAgent (non-interactive
 * child run with timeout and output cap), readPrompt, and the stderr
 * progress sink with its heartbeat animation. Shared by wiki-ingest,
 * wiki-sync, wiki-query, and k-wiki (extracted from wiki-ingest.ts,
 * issue #129).
 */
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

/** Interval for the progress-sink liveness line while the agent
 *  runs (see AGENT_HEARTBEAT_PREFIX for the line's wording). */
export const HEARTBEAT_MS = 60_000;

/** Heartbeat sentence prefixes (plain or expunge-labeled); the TTY
 *  renderer keeps matching messages on one animated line (spinner + clock). */
export const AGENT_HEARTBEAT_PREFIX = [
  "wiki-ingest: agent still running",
  "wiki-ingest: expunge agent still running",
] as const;

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
          `agent ${command} timed out after ${seconds} second${seconds === 1 ? "" : "s"}`,
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

export async function readPrompt(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read prompt at ${path}`, { cause });
  }
}

/** A stderr progress surface: plain lines, or one animated line. */
export interface ProgressSink {
  render(message: string): void;
  end(): void;
}

export interface ProgressTones {
  /** Routine progress lines. */
  readonly dim: (text: string) => string;
  /** WARNING-severity lines. */
  readonly yellow: (text: string) => string;
}

/**
 * The stderr presentation for one wiki-ingest run: agent heartbeats
 * keep one animated line (spinner + clock) on a TTY; every other
 * message scrolls. Non-animated runs append plain lines only.
 * Severity is detected here, at the render boundary: WARNING messages
 * render yellow, everything else dim.
 */
export function createAgentProgressSink(
  write: (text: string) => void,
  writeLine: (text: string) => void,
  animated: boolean,
  tones: ProgressTones,
  heartbeatPrefix: string | readonly string[] = AGENT_HEARTBEAT_PREFIX,
): ProgressSink {
  const prefixes =
    typeof heartbeatPrefix === "string" ? [heartbeatPrefix] : heartbeatPrefix;
  const styled = (message: string) =>
    isWarning(message) ? tones.yellow(message) : tones.dim(message);

  if (!animated) {
    return {
      render: (message) => writeLine(styled(message)),
      end: () => {},
    };
  }

  const renderer = createProgressRenderer(write);

  return {
    render: (message) => {
      if (prefixes.some((prefix) => message.startsWith(prefix))) {
        renderer.live(styled(message));
      } else {
        renderer.event(styled(message));
      }
    },
    end: () => renderer.end(),
  };
}
