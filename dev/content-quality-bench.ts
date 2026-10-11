#!/usr/bin/env node
/** Run the disposable, real-model content-quality bench. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWikiLinks } from "../scripts/check-links.ts";
import { errorMessage } from "../src/cli/colors.ts";
import { runContext } from "../src/cli/run-context.ts";
import { repoRoot } from "../src/cli/shared.ts";
import { parseArgs } from "../src/cli/shell.ts";
import { seedDataRepo } from "../src/data/init-data-repo.ts";
import { checkRaw } from "../src/health/check-raw.ts";
import {
  type ContentQualityBands,
  evaluateContentQuality,
  renderBenchReport,
} from "../src/quality/content-quality-bench.ts";
import { fileLastQuery, renderQueryArtifact } from "../src/query/file-last.ts";
import { runWikiQuery } from "../src/query/wiki-query.ts";
import { checkCitationWall } from "../src/sandbox/citations.ts";
import { loadSyncConfig } from "../src/sync/config.ts";
import { runWikiSync } from "../src/sync/wiki-sync.ts";
import { checkWikiFidelity } from "../src/wiki/fidelity.ts";
import { listWikiPages } from "../src/wiki/pages.ts";
import { checkWikiProvenance } from "../src/wiki/provenance.ts";
import { extractWikilinks } from "../src/wiki/wiki-links.ts";

interface Question {
  readonly question: string;
  readonly terms: readonly string[];
}

const HELP = `Usage: content-quality-bench [-h | --help] [--settings <path>] [--outputs <dir>]

Build a disposable synthetic vault, run one full wiki-sync cycle and query
answerability smoke with the configured real agent, then write bench-report.json
and bench-report.md. It never reads a real vault or data repository.

  --settings <path> Agent settings. Default: settings.yml in this checkout.
  --outputs <dir>   Durable report directory. Default: outputs/content-quality-bench.
  -h, --help        Print this help and exit; no side effects.`;

function fixtureFiles(): Readonly<Record<string, string>> {
  const header = "---\nwiki: true\n---\n\n";
  return {
    "Research/Agent Evaluation/Chapter One.md": `${header}# Agent evaluation chapter one\n\nA threshold of 0.80 selects a passing evaluation. Procedure Alpha samples fixed prompts.\n`,
    "Research/Agent Evaluation/Chapter Two.md": `${header}# Agent evaluation chapter two\n\nProcedure Beta uses adversarial prompts and records failure modes.\n`,
    "Research/retrieval.md": `${header}# Retrieval approach\n\nRetrieval ranks passages before generation. It trades latency for grounded answers.\n`,
    "Research/fine-tuning.md": `${header}# Fine-tuning approach\n\nFine-tuning changes model weights. Unlike retrieval, it does not add current passages at query time.\n`,
    "Research/borderline-term.md": `${header}# Calibration drift\n\nCalibration drift appears only in this note.\n`,
    "Research/link-stubs.md": `${header}# Link-only stubs\n\n[[Agent Evaluation]] [[retrieval]] [[fine-tuning]]\n`,
  };
}

async function writeFixture(root: string): Promise<string> {
  const vault = join(root, "Content Quality Fixture");
  for (const [path, text] of Object.entries(fixtureFiles())) {
    const target = join(vault, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, text);
  }
  return vault;
}

async function correctnessFailures(dataRoot: string): Promise<string[]> {
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

async function filingFidelityFailures(dataRoot: string): Promise<string[]> {
  const artifactPath = join(dataRoot, "outputs", "last-query.md");
  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(
    artifactPath,
    renderQueryArtifact({
      question: "What does Procedure Alpha sample?",
      timestamp: "2026-10-11T00:00:00.000Z",
      pages: ["agent-evaluation-source"],
      answer:
        "[[agent-evaluation-source]] answers this. Rerun with --web for enrichment.",
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
  return page.includes("Rerun with --web") || missing.length > 0
    ? [
        "query filing fidelity: web partition or sources missing, or stale rerun hint retained",
      ]
    : [];
}

async function answerabilityFailures(
  dataRoot: string,
  settingsPath: string,
  questions: readonly Question[],
): Promise<string[]> {
  const wiki = join(dataRoot, "wiki");
  const pages = await listWikiPages(wiki);
  const texts = new Map(
    await Promise.all(
      pages.map(
        async (path) =>
          [
            path.replace(/\.md$/, ""),
            await readFile(join(wiki, path), "utf8"),
          ] as const,
      ),
    ),
  );
  const failures: string[] = [];
  for (const item of questions) {
    const result = await runWikiQuery({
      settingsPath,
      run: runContext({
        rawDir: join(dataRoot, "raw"),
        onProgress: console.error,
      }),
      promptsDir: join(repoRoot, "prompts"),
      outputsDir: join(dataRoot, "outputs"),
      question: item.question,
    });
    const cited = extractWikilinks(result.answer).map((link) => link.target);
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
  const parsed = parseArgs(args, {
    value: ["--settings", "--outputs"],
    positionals: { max: 0, error: (arg) => `unexpected argument ${arg}` },
  });
  if (parsed.error !== undefined) throw new Error(parsed.error);
  const settingsPath =
    parsed.values.get("--settings") ?? join(repoRoot, "settings.yml");
  const outputDir =
    parsed.values.get("--outputs") ??
    join(repoRoot, "outputs", "content-quality-bench");
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
    const failures = [
      ...(await correctnessFailures(dataRoot)),
      ...(await filingFidelityFailures(dataRoot)),
      ...(await answerabilityFailures(dataRoot, settingsPath, questions)),
    ];
    const report = await evaluateContentQuality({
      wikiDir: join(dataRoot, "wiki"),
      bands,
      correctnessFailures: failures,
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
}

main().catch((error) => {
  console.error(`content-quality-bench: ${errorMessage(error)}`);
  process.exitCode = 1;
});
