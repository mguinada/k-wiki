/**
 * Source-removal receipts (issue #390): the human-confirmation
 * artifact that gates source removals and renames in shared-writer
 * mode. A stale local iCloud view must never become a shared
 * canonical expunge, so the coordinator plans the candidate
 * removal/rename set before mutating `raw/`, stamps it with the
 * canonical remote SHA it holds the lease under, and refuses to
 * proceed until a human reruns the cycle with that exact receipt.
 * The receipt is per-machine state (excluded from git), role-neutral
 * — any Mac whose vault view is current may confirm — and invalid
 * the moment the remote advances or the candidate set changes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPlainObject, readTextIfExists } from "../cli/shared.ts";
import { appendIgnoreEntries } from "../ingest/snapshot.ts";
import type { VaultRemovalPlan } from "../sync/projection.ts";

/** The per-machine receipt file, under the data repo's outputs/. */
export const RECEIPT_FILENAME = "outputs/shared-writer-receipt.json";

/** The receipt schema version. */
export const RECEIPT_VERSION = 1;

/** One confirmed removal/rename set, anchored to the canonical
 *  remote SHA the planning cycle held the lease under. */
export interface RemovalReceipt {
  readonly version: 1;
  readonly base: string;
  readonly plans: readonly VaultRemovalPlan[];
}

/** Build the receipt a refusal writes: the planned set plus the
 *  canonical remote SHA it was planned against. */
export function buildReceipt(
  base: string,
  plans: readonly VaultRemovalPlan[],
): RemovalReceipt {
  return { version: 1, base, plans };
}

/** Whether two removal plans describe the same candidate set — exact
 *  paths, exact pairing, order-insensitive per vault. */
function samePlan(a: VaultRemovalPlan, b: VaultRemovalPlan): boolean {
  if (a.vault !== b.vault) {
    return false;
  }

  return samePaths(a.removals, b.removals) && sameRenames(a.renames, b.renames);
}

/** Exact multiset equality on path sets, order-insensitive. */
function samePaths(x: readonly string[], y: readonly string[]): boolean {
  if (x.length !== y.length) {
    return false;
  }

  const ys = [...y].sort();

  return [...x].sort().every((path, index) => path === ys[index]);
}

/** Exact multiset equality on from→to pairs, order-insensitive; the
 *  NUL separator cannot occur in a path, so the key is collision-free. */
function sameRenames(
  x: VaultRemovalPlan["renames"],
  y: VaultRemovalPlan["renames"],
): boolean {
  if (x.length !== y.length) {
    return false;
  }

  const keys = (renames: VaultRemovalPlan["renames"]) =>
    renames.map((rename) => `${rename.from}\u0000${rename.to}`).sort();
  const ys = keys(y);

  return keys(x).every((key, index) => key === ys[index]);
}

/** Parse receipt text; throws with the origin on any shape
 *  violation — a malformed receipt is a refusal, never a pass. */
export function parseReceipt(text: string, origin: string): RemovalReceipt {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${origin}: not valid JSON`, { cause });
  }

  if (
    !isPlainObject(parsed) ||
    parsed.version !== RECEIPT_VERSION ||
    typeof parsed.base !== "string" ||
    parsed.base === "" ||
    !Array.isArray(parsed.plans)
  ) {
    throw new Error(
      `${origin}: expected a version-1 receipt with "base" and "plans"`,
    );
  }

  const plans: VaultRemovalPlan[] = parsed.plans.map((plan) => {
    if (
      !isPlainObject(plan) ||
      typeof plan.vault !== "string" ||
      !Array.isArray(plan.removals) ||
      !Array.isArray(plan.renames)
    ) {
      throw new Error(`${origin}: malformed plan entry`);
    }

    return {
      vault: plan.vault,
      removals: plan.removals.map((path) => String(path)),
      renames: plan.renames.map((rename) => {
        if (
          !isPlainObject(rename) ||
          typeof rename.from !== "string" ||
          typeof rename.to !== "string"
        ) {
          throw new Error(`${origin}: malformed rename entry`);
        }

        return { from: rename.from, to: rename.to };
      }),
    };
  });

  return { version: 1, base: parsed.base, plans };
}

/** Why a receipt does not match the recomputed candidate set. */
export type ReceiptMatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Match a supplied receipt against the freshly recomputed plan and
 *  the current canonical remote SHA: the base must be unchanged and
 *  the candidate set identical (issue #390 — a changed set or
 *  advanced remote invalidates the receipt). */
export function matchReceipt(
  receipt: RemovalReceipt,
  base: string,
  plans: readonly VaultRemovalPlan[],
): ReceiptMatch {
  if (receipt.base !== base) {
    return {
      ok: false,
      reason: `receipt was planned against remote ${receipt.base.slice(0, 8)}, canonical is now ${base.slice(0, 8)}`,
    };
  }

  if (receipt.plans.length !== plans.length) {
    return { ok: false, reason: "receipt vault set differs from the plan" };
  }

  for (const [index, plan] of plans.entries()) {
    const confirmed = receipt.plans[index];

    if (confirmed === undefined || !samePlan(plan, confirmed)) {
      return {
        ok: false,
        reason: `receipt candidate set differs from the current plan${plan === undefined ? "" : ` (vault ${plan.vault})`}`,
      };
    }
  }

  return { ok: true };
}

/** Keep the receipt out of the data repo's history: per-machine
 *  state, like the lint-window snapshot and the heartbeat — via
 *  .git/info/exclude, never the tracked .gitignore (an appended
 *  tracked file would leave every checkout permanently dirty). Same
 *  one append helper, same semantics. */
export async function ensureReceiptIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  if (
    await appendIgnoreEntries(
      join(dataRoot, ".git", "info", "exclude"),
      "# shared-writer removal receipt: per-machine state, never committed (issue #390)",
      [[RECEIPT_FILENAME, [RECEIPT_FILENAME]]],
    )
  ) {
    onProgress(
      `shared-writer: ignoring ${RECEIPT_FILENAME} in the data repo so no commit can take the receipt`,
    );
  }
}

/** Write the receipt file for the human's confirming rerun. */
export async function writeReceipt(
  dataRoot: string,
  receipt: RemovalReceipt,
): Promise<string> {
  const path = join(dataRoot, RECEIPT_FILENAME);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return path;
}

/** Load the receipt a confirming rerun supplies via
 *  `--removal-receipt <path>`. */
export async function readReceipt(path: string): Promise<RemovalReceipt> {
  const text = await readTextIfExists(path);

  if (text === undefined) {
    throw new Error(`removal receipt not found: ${path}`);
  }

  return parseReceipt(text, path);
}

/** The human-readable listing a refusal prints: exact paths, the
 *  anchor SHA, and the confirmation command shape. */
export function describeReceipt(receipt: RemovalReceipt): readonly string[] {
  const lines = [
    `proposed source removals/renames — base ${receipt.base.slice(0, 8)}:`,
  ];

  for (const plan of receipt.plans) {
    for (const path of plan.removals) {
      lines.push(`  removal  ${plan.vault}/${path}`);
    }

    for (const rename of plan.renames) {
      lines.push(`  rename   ${plan.vault}/${rename.from} → ${rename.to}`);
    }
  }

  lines.push(
    `rerun with --removal-receipt <path to ${RECEIPT_FILENAME}> to confirm`,
  );

  return lines;
}
