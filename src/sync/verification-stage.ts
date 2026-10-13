/**
 * The verification stage (issue #138): the deterministic
 * check-fidelity and check-provenance cores run over the data repo's
 * wiki/ and raw/ every cycle, after lint and the audits, before the
 * commit — one problem line per finding fails the cycle (the caller
 * owns the revert). Extracted from wiki-sync.ts so the orchestrator
 * stays orchestration-only.
 */

import type { RunContext } from "../cli/run-context.ts";
import {
  checkWikiFidelity,
  type FidelityReport,
  summarizeFidelity,
} from "../wiki/fidelity.ts";
import {
  checkWikiProvenance,
  type ProvenanceReport,
  summarizeProvenance,
} from "../wiki/provenance.ts";

/** What the verification stage reports back to the cycle digest: the
 *  raw checks plus their digested verdict lines, so the cycle digest
 *  states the audits without re-importing the summarizers. */
export interface VerificationResult {
  readonly fidelity: FidelityReport;
  readonly provenance: ProvenanceReport;
  readonly fidelityLine: string;
  readonly provenanceLine: string;
}

export interface VerificationOptions {
  /** The run context: the checks run over the context's wiki dir and
   *  raw dir. Built once at the CLI boundary (issue #257). */
  readonly run: RunContext;
}

/**
 * The verification stage (issue #138): run the deterministic
 * check-fidelity (issue #125) and check-provenance (issue #65) cores
 * over the data repo's wiki/ and raw/ — every cycle, after lint, the
 * crosslink audit, and the citation wall, whatever the ingest stage did. One problem
 * line per finding throws (fidelity first, provenance second),
 * stopping the cycle before the commit; the caller owns the revert.
 */
export async function runVerificationStage(
  options: VerificationOptions,
): Promise<VerificationResult> {
  const { run } = options;

  run.onProgress(
    "wiki-sync: verification — checking citation fidelity and provenance",
  );

  const fidelity = await checkWikiFidelity(run.wikiDir, run.rawDir);

  failProblems("fidelity", fidelity.problems);

  const provenance = await checkWikiProvenance(run.wikiDir, run.rawDir);

  failProblems("provenance", provenance.problems);

  return {
    fidelity,
    provenance,
    fidelityLine: summarizeFidelity(fidelity),
    provenanceLine: summarizeProvenance(provenance),
  };
}

/** Fail the cycle naming one problem line per finding: the shared
 *  failure shape of the stage's two checks. */
function failProblems(
  check: "fidelity" | "provenance",
  problems: readonly string[],
): void {
  if (problems.length > 0) {
    throw new Error(`${check} check failed:\n${problems.join("\n")}`);
  }
}
