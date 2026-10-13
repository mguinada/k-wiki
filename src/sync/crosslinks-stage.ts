/**
 * The crosslink stage (issue #96): the check-crosslinks core run
 * over the data repo's wiki against every configured second brain —
 * the wiki/AGENTS.md contract the wiki-sync cycle enforces after
 * every run. Extracted from wiki-sync.ts so the orchestrator stays
 * orchestration-only; a failed audit fails the cycle like a lint
 * failure, and an instance without `secondBrain.domains` never
 * reaches this module.
 */

import type { RunContext } from "../cli/run-context.ts";
import { pluralized } from "../cli/shared.ts";
import { checkCrossWikiLinks } from "../wiki/crosslinks.ts";
import { expandHome } from "./config.ts";

/** What the crosslink stage reports back to the cycle digest. */
export interface CrosslinksResult {
  /** The expanded domain wiki dirs the audit ran against. */
  readonly domains: readonly string[];
  /** Cross-wiki links found in the audited wiki. */
  readonly external: number;
  /** Markdown pages scanned across the domain wikis. */
  readonly domainPages: number;
}

export interface CrosslinksOptions {
  /** The run context: the audit runs over the context's wiki dir.
   *  Built once at the CLI boundary (issue #257). */
  readonly run: RunContext;
  /** Domain wiki dirs from the settings' `secondBrain.domains`;
   *  undefined or absent (the key missing) skips the stage entirely. */
  readonly domains?: readonly string[] | undefined;
  /** Home dir for `~` expansion in domains; default: `os.homedir()`. */
  readonly home?: string;
}

/**
 * The crosslink stage (issue #96): run the check-crosslinks core
 * over the data repo's wiki against every configured domain wiki —
 * every cycle, after lint, whatever the ingest stage did. A broken
 * or forbidden link throws (one `file:line -> [[link]]` item per
 * problem), stopping the cycle before the commit like a lint
 * failure; a misconfigured domain dir (no sibling manifest) fails
 * the same way. Nothing reverts: the agent run already passed its
 * guardrails, and the uncommitted diff is the fix surface.
 */
export async function runCrosslinksStage(
  options: CrosslinksOptions,
): Promise<CrosslinksResult | undefined> {
  if (options.domains === undefined) {
    return undefined;
  }

  const { run } = options;
  const domains = options.domains.map((dir) => expandHome(dir, options.home));

  run.onProgress(
    `wiki-sync: crosslinks — auditing against ${pluralized(domains.length, "domain wiki")}`,
  );

  const report = await checkCrossWikiLinks(run.wikiDir, ...domains);

  if (report.problems.length > 0) {
    throw new Error(`crosslink audit failed — ${report.problems.join("; ")}`);
  }

  return {
    domains,
    external: report.external,
    domainPages: report.domainPages,
  };
}
