/**
 * The scheduled run's log plumbing: where the log lives on this
 * machine, the 5 MiB one-generation rotation, and the serialized
 * run-log writer the wrapper's cycle narrates through (issue #244:
 * one append in flight, every line recorded in arrival order).
 * Extracted from scheduled-run.ts — the log is the wrapper's own
 * concern, separate from the cycle it narrates.
 */

import { mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage } from "../cli/colors.ts";

/** The log file for this machine: `~/Library/Logs/k-wiki/` on macOS
 *  (the only scheduled platform today), the XDG state dir elsewhere. */
export function scheduledLogPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "darwin"
    ? join(home, "Library", "Logs", "k-wiki", "scheduled-run.log")
    : join(home, ".local", "state", "k-wiki", "logs", "scheduled-run.log");
}

/** Rotate the log at 5 MiB: one previous generation (`.1`) is kept,
 *  older ones dropped — enough history for a personal wiki, no growth
 *  beyond ~10 MiB. */
export async function rotateLogIfNeeded(
  logPath: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<void> {
  const size = await stat(logPath).then(
    (info) => info.size,
    () => 0,
  );

  if (size >= maxBytes) {
    await rename(logPath, `${logPath}.1`).catch(() => {});
  }
}

/** Append one line to the run log, rotating first. Best-effort: a
 *  failed log write reports to stderr and never fails the cycle. */
export async function appendLog(logPath: string, line: string): Promise<void> {
  try {
    await rotateLogIfNeeded(logPath);
    await mkdir(dirname(logPath), { recursive: true });
    await appendFileLine(logPath, line);
  } catch (error) {
    console.error(`scheduled-run: log write failed — ${errorMessage(error)}`);
  }
}

/** The run's serialized log writer (issue #244): one append in
 *  flight, every line recorded in arrival order. */
export interface RunLogWriter {
  readonly log: (line: string) => void;
  readonly flush: () => Promise<void>;
}

/** Serialize log appends through one queue: fire-and-forget appends
 *  raced each other and the rotation (two concurrent appends can both
 *  pass the 5 MiB check and both rename — one generation is lost),
 *  and interleaved opens recorded lines out of order. The queue
 *  keeps exactly one appendLog in flight and orders the rest; flush
 *  settles when the last line is on disk. */
export function createRunLog(
  logPath: string,
  append: (logPath: string, line: string) => Promise<void> = appendLog,
): RunLogWriter {
  let tail: Promise<void> = Promise.resolve();

  return {
    log: (line: string): void => {
      tail = tail.then(() => append(logPath, line));
    },
    flush: (): Promise<void> => tail,
  };
}

async function appendFileLine(logPath: string, line: string): Promise<void> {
  const handle = await open(logPath, "a");

  await handle.writeFile(`${line}\n`);
  await handle.close();
}
