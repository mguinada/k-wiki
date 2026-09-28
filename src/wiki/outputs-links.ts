/**
 * The outputs-namespace link resolver (issue #410, completed by issue
 * #414): an `outputs/…` wikilink target resolves against the data
 * root's outputs/ directory, never the wiki page index — the cycle
 * report the ingest prompt promises (issue #385) is written after the
 * log entry that cites it, so the link class lives outside any page
 * index. One classifier for every consumer — the ingest guardrails'
 * check 3, `scripts/check-links.ts`, the dashboard KPIs' dead-link
 * count, `check-crosslinks`' audited-wiki pass, and the sandbox
 * citation wall (src/sandbox/citations.ts) — so the resolvers
 * cannot disagree about which outputs citations are alive: a citation
 * resolves only when its target names an existing file under
 * outputs/, and a traversal escaping the directory is its own
 * failure, never a silent pass.
 */

import { statSync } from "node:fs";
import { join, posix } from "node:path";

/** The data-root directory an `outputs/…` citation resolves against. */
export const OUTPUTS_DIR = "outputs";

/** True when a wikilink target names the outputs namespace: the
 *  `outputs/` prefix with the slash. A bare or longer name (`outputs`,
 *  `outputsX`) is an ordinary page name and never outputs. */
export function isOutputsTarget(target: string): boolean {
  return target.startsWith(`${OUTPUTS_DIR}/`);
}

/** The target's outputs-relative path — `outputs/a/b.md` → `a/b.md` —
 *  or undefined when the target cannot name a file inside the outputs
 *  directory: an empty page segment (`outputs/`), a traversal that
 *  escapes it (`outputs/../raw/manifest.json`), or an absolute
 *  remainder. `..` steps that stay inside (`outputs/a/../b.md`)
 *  normalize away and stay resolvable. */
export function outputsRelativeTarget(target: string): string | undefined {
  const rest = target.slice(OUTPUTS_DIR.length + 1);
  const normalized = posix.normalize(rest);

  if (
    rest === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

/** Why an outputs citation fails: `escape` — the target cannot name a
 *  file inside the outputs directory; `missing` — well-formed, but no
 *  such file exists there. */
export type OutputsLinkProblem = "escape" | "missing";

/** The shared classification every resolver calls (issue #414):
 *  undefined when the citation resolves, else why it fails. `exists`
 *  answers for one normalized outputs-relative path — the filesystem
 *  probe (outputsFileProbe) for the guardrails, check-links, and
 *  check-crosslinks; set membership for the pure dashboard KPIs. */
export function outputsLinkProblem(
  target: string,
  exists: (relative: string) => boolean,
): OutputsLinkProblem | undefined {
  const relative = outputsRelativeTarget(target);

  if (relative === undefined) {
    return "escape";
  }

  return exists(relative) ? undefined : "missing";
}

/** The parenthetical a failing outputs citation carries in every
 *  problem line — identical across all resolvers, so the surfaces
 *  cannot drift (issue #414). */
export function outputsProblemReason(
  target: string,
  problem: OutputsLinkProblem,
): string {
  return problem === "escape"
    ? "escapes the outputs/ directory"
    : `no outputs file "${outputsRelativeTarget(target)}"`;
}

/** A filesystem probe over one outputs directory: true only when the
 *  outputs-relative path names an existing regular file — a directory
 *  (or anything else) does not resolve a citation. */
export function outputsFileProbe(
  outputsDir: string,
): (relative: string) => boolean {
  return (relative) => {
    try {
      return statSync(join(outputsDir, relative)).isFile();
    } catch {
      return false;
    }
  };
}
