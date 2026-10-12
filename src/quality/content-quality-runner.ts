/**
 * The disposable, real-model content-quality bench cycle: it writes the
 * pinned synthetic fixture into a temp data repo, runs one full
 * wiki-sync under the configured agent, evaluates the correctness
 * floor, the pending-convention lane, and the committed bands, and
 * writes the durable pass/warn/fail report. main() is the dev
 * launcher's entry point; the model-free measurement and verdict
 * logic it drives lives in content-quality-bench.ts.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWikiLinks } from "../../scripts/check-links.ts";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { runContext } from "../cli/run-context.ts";
import { repoRoot } from "../cli/shared.ts";
import { agentRunFlags, parseArgs } from "../cli/shell.ts";
import { seedDataRepo } from "../data/init-data-repo.ts";
import { checkRaw } from "../health/check-raw.ts";
import {
  fileLastQuery,
  renderQueryArtifact,
  WEB_FILED_HINT,
} from "../query/file-last.ts";
import { GAP_HINT_LINE } from "../query/web-enrich.ts";
import { checkCitationWall } from "../sandbox/citations.ts";
import { loadSyncConfig } from "../sync/config.ts";
import { runWikiSync } from "../sync/wiki-sync.ts";
import { checkWikiFidelity } from "../wiki/fidelity.ts";
import { listWikiPages } from "../wiki/pages.ts";
import { checkWikiProvenance } from "../wiki/provenance.ts";
import { extractWikilinks, stem } from "../wiki/wiki-links.ts";
import { computeWikiWorklists } from "../wiki/worklists.ts";
import {
  type ContentQualityBands,
  evaluateContentQuality,
  renderBenchReport,
  worklistFloorFailures,
} from "./content-quality-bench.ts";

interface Question {
  readonly question: string;
  readonly terms: readonly string[];
  readonly answer: string;
}

const HELP = `Usage: content-quality-bench [-h | --help] [--settings <path>] [--outputs <dir>]

Build a disposable synthetic vault, run one full wiki-sync cycle and query
answerability smoke with the configured real agent, then write bench-report.json
and bench-report.md. It never reads a real vault or data repository.

  --settings <path> Agent settings. Default: settings.yml in this checkout.
  --outputs <dir>   Durable report directory. Default: outputs/content-quality-bench.
  -h, --help        Print this help and exit; no side effects.`;

export function fixtureFiles(): Readonly<Record<string, string>> {
  const header = "---\nwiki: true\n---\n\n";
  return {
    "Research/Agent Evaluation Source/Chapter One.md": `${header}# Agent evaluation chapter one\n\nA threshold of 0.80 selects a passing evaluation. Procedure Alpha samples fixed prompts.\n`,
    "Research/Agent Evaluation Source/Chapter Two.md": `${header}# Agent evaluation chapter two\n\nProcedure Beta uses adversarial prompts and records failure modes.\n`,
    "Research/retrieval.md": `${header}# Retrieval Approach Source\n\nRetrieval ranks passages before generation. It trades latency for grounded answers.\n`,
    "Research/fine-tuning.md": `${header}# Fine-tuning Approach Source\n\nFine-tuning changes model weights. Unlike retrieval, it does not add current passages at query time.\n`,
    "Research/borderline-term.md": `${header}# Calibration drift\n\nCalibration drift appears only in this note.\n`,
    "Research/link-stubs.md": `${header}# Link-only stubs\n\n[[Agent Evaluation Source]] [[retrieval]] [[fine-tuning]]\n`,
  };
}

export async function writeFixture(root: string): Promise<string> {
  const vault = join(root, "Content Quality Fixture");
  for (const [path, text] of Object.entries(fixtureFiles())) {
    const target = join(vault, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, text);
  }
  return vault;
}

export async function correctnessFailures(dataRoot: string): Promise<string[]> {
  const wiki = join(dataRoot, "wiki");
  const raw = join(dataRoot, "raw");
  const [links, fidelity, provenance, health, citations] = await Promise.all([
    checkWikiLinks(wiki),
    checkWikiFidelity(wiki, raw),
    checkWikiProvenance(wiki, raw),
    checkRaw(raw),
    checkCitationWall(wiki),
  ]);
  return [
    ...links.broken.map((item) => `check-links: ${item}`),
    ...fidelity.problems.map((item) => `check-fidelity: ${item}`),
    ...provenance.problems.map((item) => `check-provenance: ${item}`),
    ...health.problems.map((item) => `check-raw: ${item}`),
    ...citations.problems.map((item) => `citation-wall: ${item}`),
  ];
}

export async function worklistFailures(wiki: string): Promise<string[]> {
  return worklistFloorFailures(await computeWikiWorklists(wiki));
}

export async function filingFidelityFailures(
  dataRoot: string,
): Promise<string[]> {
  const artifactPath = join(dataRoot, "outputs", "last-query.md");
  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(
    artifactPath,
    renderQueryArtifact({
      question: "What does Procedure Alpha sample?",
      timestamp: "2026-10-11T00:00:00.000Z",
      pages: ["agent-evaluation-source"],
      answer: `[[agent-evaluation-source]] answers this.\n\n${GAP_HINT_LINE}`,
      mode: "query (--web)",
      webSources: 1,
      webRetrieved: "2026-10-11T00:00:01.000Z",
      web: {
        enrichment:
          "## Web enrichment\n\n_Independent of the answer above; not part of wiki provenance._\n\n- A traceable enrichment.",
        sources:
          "## Web sources\n\n- https://example.com/a — retrieved 2026-10-11",
        audit:
          "## Web calls audit\n\n| # | tool | target | results | timestamp |\n|---|------|--------|---------|-----------|\n| 1 | web_search | alpha | 1 | 2026-10-11T00:00:01.000Z |",
      },
    }),
    "utf8",
  );
  const filed = await fileLastQuery({ artifactPath, dataRoot });
  const page = await readFile(join(dataRoot, filed.pagePath), "utf8");
  const missing = ["## Web enrichment", "## Web sources"].filter(
    (section) => !page.includes(section),
  );
  return page.includes(GAP_HINT_LINE) ||
    !page.includes(WEB_FILED_HINT) ||
    missing.length > 0
    ? [
        "query filing fidelity: web partition or sources missing, or stale rerun hint retained",
      ]
    : [];
}

export async function answerabilityFailures(
  dataRoot: string,
  questions: readonly Question[],
): Promise<string[]> {
  const wiki = join(dataRoot, "wiki");
  const pages = await listWikiPages(wiki);
  const texts = new Map(
    await Promise.all(
      pages.map(
        async (path) =>
          [stem(path), await readFile(join(wiki, path), "utf8")] as const,
      ),
    ),
  );
  const failures: string[] = [];
  for (const item of questions) {
    const cited = extractWikilinks(item.answer).map((link) => link.target);
    const citedCoverage = cited.some((target) => {
      const page = texts.get(target)?.toLowerCase() ?? "";
      return item.terms.every((term) => page.includes(term.toLowerCase()));
    });
    if (!citedCoverage) failures.push(`query answerability: ${item.question}`);
  }
  return failures;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  /* v8 ignore start: the cycle runs the configured real agent over a
     disposable data repo — exercised by bench runs (the issue defers
     CI wiring), never by unit CI. */
  try {
    const parsed = parseArgs(args, {
      value: ["--settings", "--outputs"],
      positionals: { max: 0, error: (arg) => `unexpected argument ${arg}` },
    });

    if (parsed.error !== undefined) {
      throw new Error(parsed.error);
    }

    const agentFlags = agentRunFlags(parsed.values);

    if (agentFlags.error !== undefined) {
      throw new Error(agentFlags.error);
    }

    const settingsPath = agentFlags.settings ?? join(repoRoot, "settings.yml");
    const outputDir =
      agentFlags.outputs ?? join(repoRoot, "outputs", "content-quality-bench");

    const bands = JSON.parse(
      await readFile(
        join(repoRoot, "quality", "content-quality-bands.json"),
        "utf8",
      ),
    ) as ContentQualityBands;

    const questions = JSON.parse(
      await readFile(
        join(repoRoot, "quality", "content-quality-questions.json"),
        "utf8",
      ),
    ) as Question[];

    const root = await mkdtemp(join(tmpdir(), "k-wiki-content-quality-"));
    const dataRoot = join(root, "data");

    try {
      const vault = await writeFixture(root);

      await seedDataRepo({ dataRoot });

      const configPath = join(root, "sync.json");
      await writeFile(
        configPath,
        `${JSON.stringify({ dataRoot, vaults: [{ name: "Content Quality Fixture", root: vault, exclude: "wiki:false" }] })}\n`,
      );

      const config = await loadSyncConfig(configPath);

      await runWikiSync({
        configPath,
        config,
        settingsPath,
        outputsDir: join(dataRoot, "outputs"),
        promptsDir: join(repoRoot, "prompts"),
        run: runContext({
          rawDir: join(dataRoot, "raw"),
          onProgress: console.error,
        }),
      });

      const correctness = [
        ...(await correctnessFailures(dataRoot)),
        ...(await filingFidelityFailures(dataRoot)),
        ...(await worklistFailures(join(dataRoot, "wiki"))),
      ];

      const pendingConventionFailures = await answerabilityFailures(
        dataRoot,
        questions,
      );

      const report = await evaluateContentQuality({
        wikiDir: join(dataRoot, "wiki"),
        bands,
        correctnessFailures: correctness,
        pendingConventionFailures,
      });

      await mkdir(outputDir, { recursive: true });
      await writeFile(
        join(outputDir, "bench-report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );

      await writeFile(
        join(outputDir, "bench-report.md"),
        renderBenchReport(report),
      );

      console.log(
        `${report.verdict} — ${report.blocking.length} blocking, ${report.advisory.length} advisory`,
      );

      process.exitCode =
        report.verdict === "fail" ? 1 : report.verdict === "warn" ? 2 : 0;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } catch (cause) {
    console.error(`content-quality-bench: ${errorMessage(cause)}`);
    process.exitCode = 1;
  }
  /* v8 ignore stop */
}

/* v8 ignore next: covered only under direct `node src/quality/content-quality-runner.ts` runs */
refuseDirectExecution(import.meta.url, "content-quality-bench", "dev");
