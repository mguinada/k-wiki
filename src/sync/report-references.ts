/**
 * The cycle↔lint cross-reference contract of the report day files
 * (issue #459): the standalone marker a lint section carries when no
 * citing cycle exists, and the two readers that extract a section's
 * declared reference — a lint run's cycle back-reference and a cycle
 * section's lint bullet. Both read only non-fenced lines (a fenced
 * line is quoted content, never a declaration), so the checker and
 * the pair assert agree on what a section declares.
 */

import { scannedLines } from "./fence-state.ts";

/** The exact marker line of a standalone lint run's section body:
 *  no citing cycle exists, and the checker exempts marked runs. */
export const STANDALONE_MARKER = "Standalone — no citing cycle.";

/** What a lint run section's body declares about its citing cycle:
 *  the explicit standalone marker, a cycle back-reference, or
 *  neither (a shape problem the checker reports). */
export type LintRunReference =
  | { readonly kind: "standalone" }
  | {
      readonly kind: "cycle";
      readonly path: string;
      readonly sectionTitle: string;
    }
  | { readonly kind: "none" };

/** A lint run's back-reference contract line: the exact shape the
 *  prompt dictates. */
const BACK_REFERENCE_LINE = /^Cycle audited: `([^`\n]+)` — section "([^"]+)"/;

/** Extract a lint run section's declared citing-cycle reference;
 *  a fenced line is quoted content, never a declaration. */
export function lintRunReference(body: string): LintRunReference {
  const standalone = scannedLines(body).some(
    (scanned) => !scanned.fenced && scanned.line.includes(STANDALONE_MARKER),
  );

  if (standalone) {
    return { kind: "standalone" };
  }

  const line = scannedLines(body).find(
    (scanned) => !scanned.fenced && BACK_REFERENCE_LINE.test(scanned.line),
  )?.line;
  const match = BACK_REFERENCE_LINE.exec(line ?? "");
  const path = match?.[1];
  const sectionTitle = match?.[2];

  if (path !== undefined && sectionTitle !== undefined) {
    return { kind: "cycle", path, sectionTitle };
  }

  return { kind: "none" };
}

/** The lint bullet's reference tail: the exact shape the digest's
 *  lint line carries. */
const LINT_BULLET = /— report `([^`\n]+)` — section "([^"]+)"/;

/** The cycle section's lint reference: the report path plus the
 *  exact lint run section title it audited, or undefined when the
 *  section carries no lint-run reference (lint skipped, empty
 *  window, failure section); a fenced line is quoted content, never
 *  a reference. */
export function cycleLintReference(
  body: string,
): { readonly path: string; readonly sectionTitle: string } | undefined {
  const line = scannedLines(body).find(
    (scanned) => !scanned.fenced && LINT_BULLET.test(scanned.line),
  )?.line;

  const match = LINT_BULLET.exec(line ?? "");
  const path = match?.[1];
  const sectionTitle = match?.[2];

  if (path === undefined || sectionTitle === undefined) {
    return undefined;
  }

  return { path, sectionTitle };
}
