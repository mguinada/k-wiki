import { execFile } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";

/**
 * EAGAIN tolerance for iCloud dataless files (issue #216). With
 * Optimize Mac Storage, macOS evicts file bodies and serves only
 * stubs; reading or copying such a file through Node fails with
 * EAGAIN (`Unknown system error -11`) instead of blocking until
 * iCloud materializes it, while a plain `cat` succeeds. These
 * helpers convert exactly one EAGAIN failure into a self-healing
 * attempt — bounded, no backoff machinery (guide §26 rule 3) — and
 * leave every other error envelope untouched: persistent EAGAIN
 * still fails loudly.
 */

/** The pause before the single re-read attempt (issue #216: ~1–2 s). */
export const EAGAIN_RETRY_DELAY_MS = 1500;

/** Hard ceiling on one materializing `cat` read (issue #216: 30 s/file). */
export const MATERIALIZE_TIMEOUT_MS = 30_000;

/** One materialized note can be at most this large for the cat path. */
const MATERIALIZE_MAX_BUFFER = 32 * 1024 * 1024;

/** Whether `cause` is the iCloud dataless-file EAGAIN (mapped code or
 *  the unmapped errno -11 the live deployment logged). */
export function isEagain(cause: unknown): boolean {
  const error = cause as NodeJS.ErrnoException;

  return (
    error?.code === "EAGAIN" || (error as { errno?: number })?.errno === -11
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The cat-equivalent materializing read: a blocking descriptor
 *  downloads the dataless body where Node's own read refuses to.
 *  When even this fails, `fallback` — the retained EAGAIN error —
 *  keeps the loud envelope unchanged. */
async function materializeByCat(
  path: string,
  fallback: Error,
): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(
        "cat",
        [path],
        {
          encoding: "buffer",
          timeout: MATERIALIZE_TIMEOUT_MS,
          maxBuffer: MATERIALIZE_MAX_BUFFER,
        },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      );
    });
  } catch {
    throw fallback;
  }
}

/** Read one file, tolerating one dataless-file EAGAIN: a delayed
 *  re-read, then a materializing cat read, before giving up loudly. */
export async function readFileTolerant(
  path: string,
  delayMs: number = EAGAIN_RETRY_DELAY_MS,
): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (first) {
    if (!isEagain(first)) {
      throw first;
    }

    await sleep(delayMs);
  }

  try {
    return await readFile(path);
  } catch (second) {
    if (!isEagain(second)) {
      throw second;
    }

    return await materializeByCat(path, second as Error);
  }
}

/** Copy one file, tolerating a dataless-file EAGAIN on the target:
 *  drop the stub (copy-over re-creates it) and retry once. */
export async function copyFileTolerant(
  source: string,
  target: string,
): Promise<void> {
  try {
    await copyFile(source, target);
  } catch (first) {
    if (!isEagain(first)) {
      throw first;
    }

    await rm(target, { force: true });
    await copyFile(source, target);
  }
}
