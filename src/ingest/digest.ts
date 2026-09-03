/**
 * The digest domain of one ingest run (issue #258, extracted from
 * wiki-ingest.ts): the per-run review digest (counts first, details
 * after), the failure digest of a guardrail-reverted run, and the
 * deterministic expunge seed (guide §14a). Rendering and seeding
 * only — orchestration, prompts, and snapshot management live in
 * the sibling modules.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  type PageFields,
  readPageFields,
  wikilinkTarget,
} from "../wiki/pages.ts";
import { buildPageIndex } from "../wiki/wiki-links.ts";
import { type AgentSettings, isolationLabel } from "./agent-settings.ts";
import type { GuardrailFailure } from "./guardrails.ts";
import {
  type ManifestDiff,
  sourceCount,
  type UnverifiedFrontierPage,
  vaultEntryLines,
  type WikiPages,
} from "./manifest-diff.ts";

/**
 * The deterministic expunge seed (guide §14a): every source page whose
 * `origin` names a removed raw path, every page whose `sources` cites a
 * removed raw path or a seeded source page, plus `index.md` and
 * `overview.md` unconditionally. A missing wiki tree seeds only the
 * unconditional pair — the prompt's full-text search covers the rest.
 */
export async function directSetForRemovals(
  wikiRoot: string,
  removedRawPaths: readonly string[],
): Promise<readonly string[]> {
  let files: string[];

  try {
    files = await listWikiPages(wikiRoot);
  } catch {
    files = [];
  }

  const wanted = new Set(removedRawPaths.map(normalizeRawPath));
  const fields = new Map<string, PageFields>();
  const originPages = new Set<string>();

  for (const file of files) {
    const pageFields = await readPageFields(join(wikiRoot, file));

    fields.set(file, pageFields);

    if (
      pageFields.origin !== undefined &&
      wanted.has(normalizeRawPath(pageFields.origin))
    ) {
      originPages.add(file);
    }
  }

  const nameToPage = buildPageIndex(files);
  const seed = new Set<string>(["index.md", "overview.md"]);

  for (const file of originPages) {
    seed.add(file);
  }

  for (const [file, pageFields] of fields) {
    const cites = pageFields.sources.some((entry) => {
      if (isWikilinkEntry(entry)) {
        const cited = nameToPage.get(wikilinkTarget(entry));

        return cited !== undefined && originPages.has(cited);
      }

      return wanted.has(normalizeRawPath(entry));
    });

    if (cites) {
      seed.add(file);
    }
  }

  return [...seed].sort();
}

/** One completed run, everything the digest reports. */
export interface IngestRun {
  readonly startedAt: Date;
  readonly mode: "full" | "incremental" | "expunge";
  readonly promptFile: string;
  readonly settings: AgentSettings;
  readonly diff: ManifestDiff;
  readonly pages: WikiPages;
  /** Deterministic expunge seed; set only for expunge runs. */
  readonly directSet: readonly string[] | undefined;
  readonly agentOutput: string;
  /** Pages created or updated with exactly one sources entry. */
  readonly unverifiedFrontier: readonly UnverifiedFrontierPage[];
  /** The guardrail that tripped, when the run was auto-reverted. */
  readonly guardrailFailure?: GuardrailFailure | undefined;
  /** True when the run ingested explicit `--sources` paths
   *  (issue #133); the digest Mode line records it. */
  readonly explicitSources?: boolean | undefined;
}

/** Render the digest's per-vault changed-source listing: the same
 *  entry lines under a bold vault heading (D-19). */
function digestVaultLines(diff: ManifestDiff): string[] {
  const lines: string[] = [];

  for (const vault of diff.vaults) {
    lines.push(`**${vault.vault}**`, ...vaultEntryLines(vault));
  }

  return lines;
}

/** The digest header: run identity, agent, mode, sources, counts. */
function digestHeaderLines(run: IngestRun): string[] {
  const { settings } = run;
  const label = run.mode === "expunge" ? " (expunge)" : "";
  const scoped =
    run.explicitSources === true ? " · sources selected explicitly" : "";
  const lines: string[] = [
    `# Wiki ingest digest${label} — ${run.startedAt.toISOString()}`,
    "",
    `- **Agent:** \`${settings.command}\`${settings.provider ? ` · provider \`${settings.provider}\`` : ""} · model \`${settings.model}\` · reasoning \`${settings.reasoning}\` · ${isolationLabel(settings)}`,
    `- **Mode:** ${run.mode}${scoped} · prompt \`${run.promptFile}\``,
    `- **Sources:** ${sourceCount(run.diff, "added")} added, ${sourceCount(run.diff, "changed")} changed, ${sourceCount(run.diff, "removed")} removed, ${sourceCount(run.diff, "renamed")} renamed`,
  ];

  if (run.pages.unavailable === undefined) {
    lines.push(
      `- **Wiki pages:** ${run.pages.created.length} created, ${run.pages.updated.length} updated, ${run.pages.deleted.length} deleted`,
    );
  } else {
    lines.push(`- **Wiki pages:** unavailable — ${run.pages.unavailable}`);
  }

  return lines;
}

/** The Guardrails-failed section, or nothing when none tripped. */
function digestGuardrailLines(failure: GuardrailFailure | undefined): string[] {
  if (failure === undefined) {
    return [];
  }

  const lines = [
    "",
    "## Guardrails failed",
    "",
    `Check ${failure.check} (${failure.name}) tripped; the run was auto-reverted to the pre-run commit.`,
    "",
  ];

  for (const problem of failure.problems) {
    lines.push(`- ${problem}`);
  }

  return lines;
}

/** The expunge run's deterministic direct set, or nothing. */
function digestDirectSetLines(run: IngestRun): string[] {
  if (run.mode !== "expunge" || run.directSet === undefined) {
    return [];
  }

  const lines = ["", "## Expunge direct set", ""];

  for (const page of run.directSet) {
    lines.push(`- wiki/${page}`);
  }

  return lines;
}

/** The unverified-frontier section, or nothing when empty. */
function digestFrontierLines(
  frontier: readonly UnverifiedFrontierPage[],
): string[] {
  if (frontier.length === 0) {
    return [];
  }

  const lines = [
    "",
    "## Unverified frontier",
    "",
    "Pages with exactly one source (mechanical):",
  ];

  for (const page of frontier) {
    lines.push(`- ${page.path} (1 source: ${page.sources[0]})`);
  }

  return lines;
}

/** The git-diff page listing: created, updated, deleted — or why
 *  git could not report. */
function digestPageDiffLines(pages: WikiPages): string[] {
  if (pages.unavailable !== undefined) {
    return [`unavailable: ${pages.unavailable}`];
  }

  const lines = ["Created:"];

  for (const path of pages.created) {
    lines.push(`- ${path}`);
  }

  lines.push("", "Updated:");

  for (const path of pages.updated) {
    lines.push(`- ${path}`);
  }

  lines.push("", "Deleted:");

  for (const path of pages.deleted) {
    lines.push(`- ${path}`);
  }

  return lines;
}

/** Render the per-run digest markdown: counts first, details after. */
export function formatDigest(run: IngestRun): string {
  const lines = digestHeaderLines(run);

  lines.push(...digestGuardrailLines(run.guardrailFailure));
  lines.push(
    "- **Contradictions and unresolved questions:** in the agent report below",
  );

  if (run.mode !== "full") {
    lines.push("", "## Changed sources", "", ...digestVaultLines(run.diff));
  }

  lines.push(...digestDirectSetLines(run));
  lines.push(...digestFrontierLines(run.unverifiedFrontier));
  lines.push(
    "",
    "## Wiki pages (git diff)",
    "",
    ...digestPageDiffLines(run.pages),
  );
  lines.push("", "## Agent report", "", run.agentOutput);

  return `${lines.join("\n")}\n`;
}

/** The failure digest's input (C-16): the run's identity fields —
 *  an IngestRun minus the fields meaningless after the revert (page
 *  buckets, direct set, frontier, outcome flags) — plus the tripped
 *  check and the explicit-diff marker; no re-declared IngestRun
 *  shape that must stay in sync by hand. */
type FailureDigestRun = Omit<
  IngestRun,
  | "pages"
  | "directSet"
  | "unverifiedFrontier"
  | "guardrailFailure"
  | "explicitSources"
> & {
  readonly failure: GuardrailFailure;
  readonly explicitDiff: ManifestDiff | undefined;
};

/** Write the digest of a guardrail-reverted run: no page counts, the
 *  tripped check named, the agent output kept for review. */
export async function writeFailureDigest(
  digestPath: string,
  run: FailureDigestRun,
): Promise<void> {
  const { failure } = run;

  await writeFile(
    digestPath,
    formatDigest({
      startedAt: run.startedAt,
      mode: run.mode,
      promptFile: run.promptFile,
      settings: run.settings,
      diff: run.diff,
      pages: {
        created: [],
        updated: [],
        deleted: [],
        unavailable: `run reverted — guardrail check ${failure.check} (${failure.name}) tripped`,
      },
      directSet: undefined,
      agentOutput: run.agentOutput,
      unverifiedFrontier: [],
      guardrailFailure: failure,
      ...(run.explicitDiff !== undefined && { explicitSources: true }),
    }),
    "utf8",
  );
}
