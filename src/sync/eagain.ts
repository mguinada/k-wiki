import { execFile } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";

/**
 * EAGAIN tolerance for iCloud dataless files (issue #216). With
 * Optimize Mac Storage, macOS evicts file bodies and serves only
 * stubs; reading or copying such a file through Node fails with
 * EAGAIN (`Unknown system error -11`) instead of blocking until
 * iCloud materializes it. These helpers retry such failures inside
 * a bounded per-file budget (issue #229) — no backoff machinery
 * (guide §26 rule 3) — and leave every other error envelope
 * untouched: EAGAIN that outlasts the budget still fails loudly.
 * The budget covers genuinely transient EAGAIN only: a launchd-run
 * process is refused outright (access control, guide §26 rule 10),
 * so no retry here can materialize a file for the schedule.
 */

/** The pause between EAGAIN retries inside the budget (issue #216: ~1–2 s). */
export const EAGAIN_RETRY_DELAY_MS = 1500;

/** Default per-file EAGAIN budget: retries plus the final materializing
 *  `cat` read must all fit inside it (issues #216, #229: 30 s/file). */
export const MATERIALIZE_TIMEOUT_MS = 30_000;

/** One materialized note can be at most this large for the cat path. */
const MATERIALIZE_MAX_BUFFER = 32 * 1024 * 1024;

/** Whether `cause` is the iCloud dataless-file EAGAIN (mapped code or
 *  the unmapped errno -11 the live deployment logged). */
export function isEagain(cause: unknown): boolean {
  const error = cause as NodeJS.ErrnoException;

  return error?.code === "EAGAIN" || error?.errno === -11;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The cat-equivalent materializing read: a blocking descriptor
 *  downloads the dataless body where Node's own read refuses to —
 *  but only for a process the provider will serve (guide §26
 *  rule 10: a launchd-run process is refused here too). When even
 *  this fails, `fallback` — the retained EAGAIN error — keeps the
 *  loud envelope unchanged. */
async function materializeByCat(
  path: string,
  fallback: Error,
  timeoutMs: number,
): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(
        "cat",
        [path],
        {
          encoding: "buffer",
          timeout: Math.max(timeoutMs, 1_000),
          maxBuffer: MATERIALIZE_MAX_BUFFER,
        },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      );
    });
  } catch {
    throw fallback;
  }
}

/** Read one file, tolerating dataless-file EAGAIN within a per-file
 *  budget: re-read after `delayMs` while the budget lasts, then one
 *  final cat-equivalent materializing attempt. The budget covers
 *  genuinely transient EAGAIN only (guide §26 rule 10): a
 *  launchd-run process's refusal is access control — no retry
 *  overrides it, and the read fails loudly. */
export async function readFileTolerant(
  path: string,
  delayMs: number = EAGAIN_RETRY_DELAY_MS,
  deadlineMs: number = MATERIALIZE_TIMEOUT_MS,
): Promise<Buffer> {
  const deadline = Date.now() + deadlineMs;
  let retained: unknown;

  while (true) {
    try {
      return await readFile(path);
    } catch (cause) {
      if (!isEagain(cause)) {
        throw cause;
      }

      retained = cause;
    }

    if (Date.now() + delayMs > deadline) {
      break;
    }

    await sleep(delayMs);
  }

  return await materializeByCat(path, retained as Error, deadline - Date.now());
}

/** Copy one file, tolerating dataless-file EAGAIN on the target
 *  within the same per-file budget: drop the stub (copy-over
 *  re-creates it), wait, and retry until the budget is spent. */
export async function copyFileTolerant(
  source: string,
  target: string,
  delayMs: number = EAGAIN_RETRY_DELAY_MS,
  deadlineMs: number = MATERIALIZE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;

  while (true) {
    try {
      await copyFile(source, target);

      return;
    } catch (cause) {
      if (!isEagain(cause) || Date.now() + delayMs > deadline) {
        throw cause;
      }
    }

    await rm(target, { force: true });
    await sleep(delayMs);
  }
}
