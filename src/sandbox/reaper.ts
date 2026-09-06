/**
 * The sandbox TTL reaper (issue #338, decision 6 of #289): the
 * deterministic hygiene epilogue of every wiki-ingest run — delete
 * each `wiki/sandbox/` page whose `expires:` stamp is strictly past
 * (edge 1: a note goes when today is *after* its expiry date;
 * expiring today survives until tomorrow). Deletion is working-tree
 * deletion only: wiki-ingest never commits, so the next wiki-sync
 * cycle's commit stage versions the removals like any other wiki
 * diff. The sweep is idempotent (an already-reaped note is a no-op,
 * not an error), a no-op without a sandbox namespace (a sandbox-less
 * repo runs byte-identically to before), and it does not coordinate
 * with live runs (decision 3's no-global-lock stance, edge 2: the
 * 7-day stamp floor makes the practical window unreachable; a
 * reaped-and-recreated note is just a new note). Stamps the reaper
 * cannot read — absent, empty, or not a plain `YYYY-MM-DD` date —
 * never delete: the reaper acts only on what `expires:` clearly
 * says is gone.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "../cli/run-context.ts";
import { listFiles, pluralized, statIfExists } from "../cli/shared.ts";
import { closingFence, unquote } from "../wiki/pages.ts";
import { SANDBOX_DIR } from "./stamps.ts";

/** A plain date-level stamp, the wiki's `YYYY-MM-DD` convention. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What one sweep did: the repo-relative sandbox pages it deleted. */
export interface ReapResult {
  readonly reaped: readonly string[];
}

/** The `expires:` stamp of a sandbox page's text: the top-level
 *  `expires:` scalar inside the frontmatter block, unquoted;
 *  undefined when the block or the key is absent. */
export function readExpiresStamp(text: string): string | undefined {
  const lines = text.split(/\r?\n/);

  if (lines[0] !== "---") {
    return undefined;
  }

  const end = closingFence(lines);

  if (end === -1) {
    return undefined;
  }

  for (const line of lines.slice(1, end)) {
    const value = /^expires:\s*(.*)$/.exec(line)?.[1];

    if (value !== undefined) {
      const stamp = unquote(value.trim());

      return stamp === "" ? undefined : stamp;
    }
  }

  return undefined;
}

/** True when the stamp says the note is gone (edge 1): a plain date
 *  strictly before today. Anything else — future, today, malformed,
 *  absent — survives. */
function isExpired(expires: string | undefined, today: string): boolean {
  return expires !== undefined && ISO_DATE.test(expires) && expires < today;
}

/**
 * Delete every expired sandbox page in the run's data repo. Silent
 * and write-free without a sandbox namespace; one progress line
 * naming the reaped pages otherwise.
 */
export async function reapExpiredSandboxNotes(
  run: RunContext,
): Promise<ReapResult> {
  const sandboxDir = join(run.dataRoot, SANDBOX_DIR);

  if ((await statIfExists(sandboxDir)) === undefined) {
    return { reaped: [] };
  }

  const today = run.now().toISOString().slice(0, 10);
  const reaped: string[] = [];

  for (const rel of await listFiles(sandboxDir, "", { extension: ".md" })) {
    const text = await readFile(join(sandboxDir, rel), "utf8");

    if (isExpired(readExpiresStamp(text), today)) {
      await rm(join(sandboxDir, rel));
      reaped.push(`${SANDBOX_DIR}/${rel}`);
    }
  }

  if (reaped.length > 0) {
    run.onProgress(
      `sandbox: reaper — deleted ${pluralized(reaped.length, "expired note")}: ${reaped.join(", ")}`,
    );
  }

  return { reaped };
}
