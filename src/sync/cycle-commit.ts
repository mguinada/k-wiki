/**
 * The cycle's data-repo commit (issue #13): what the commit message
 * summarizes, the pathspec discipline (wiki/, raw/, and outputs/
 * only when it holds something git can act on — the manifest
 * snapshot moved there but is ignored, issue #112), and the one
 * `git add -A` + `git commit` pair both the manual and the
 * scheduled writers run. Extracted from wiki-sync.ts so the
 * orchestrator stays orchestration-only.
 */

/** One cycle commit: what the message summarizes. */
export interface CommitSummary {
  readonly sourcesCount: number;
  /** e.g. `1 added, 0 changed, 0 removed, 0 renamed`. */
  readonly sourcesLine: string;
  readonly pagesCreated: number;
  readonly pagesUpdated: number;
  /** Data-repo-relative lint report path; undefined when none was written. */
  readonly lintReport: string | undefined;
}

/** The commit message: sources processed, pages touched, lint report. */
export function formatCommitMessage(summary: CommitSummary): string {
  const sources =
    summary.sourcesCount === 1
      ? "1 source processed"
      : `${summary.sourcesCount} sources processed`;
  const pagesTouched = summary.pagesCreated + summary.pagesUpdated;
  const pages =
    pagesTouched === 1 ? "1 page touched" : `${pagesTouched} pages touched`;
  const lines = [
    `wiki-sync: ${sources}, ${pages}`,
    "",
    `- sources: ${summary.sourcesLine}`,
    `- pages: ${summary.pagesCreated} created, ${summary.pagesUpdated} updated`,
  ];

  if (summary.lintReport !== undefined) {
    lines.push(`- lint: ${summary.lintReport}`);
  }

  return lines.join("\n");
}

/** The cycle's commit outcome. */
export type CommitResult =
  | {
      readonly status: "committed";
      readonly hash: string;
      readonly message: string;
    }
  | { readonly status: "nothing-to-commit" };
