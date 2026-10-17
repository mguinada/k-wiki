/**
 * Deterministic measurement and verdict logic for the content-quality bench.
 * The runner module (content-quality-runner.ts) owns the disposable
 * real-model cycle; this module only reads the produced wiki and therefore
 * remains model-free and testable.
 *
 * The #432 page-shape conventions shipped in the diff that flipped the
 * containment: source-slug and canonical-answerability findings are
 * blocking. Before that ship they rode a non-gating pending-convention
 * lane (the ratified pre-#432 containment).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { listFiles } from "../cli/shared.ts";
import {
  bodyAfterFrontmatter,
  type PageFields,
  parsePageFields,
} from "../wiki/pages.ts";
import { extractWikilinks, stem, unfencedLines } from "../wiki/wiki-links.ts";

export type BenchVerdict = "pass" | "warn" | "fail";

export interface ContentQualityBands {
  readonly pageCount: readonly [number, number];
  readonly sourceShare: readonly [number, number];
  readonly statusAllowlist: readonly string[];
  readonly confidenceAllowlist: readonly string[];
  readonly sourceSlugSuffix: string;
  readonly requiredFields: readonly string[];
}

export interface BenchFinding {
  readonly lane: "blocking" | "advisory";
  readonly name: string;
  readonly detail: string;
}

export interface ContentQualityReport {
  readonly verdict: BenchVerdict;
  readonly blocking: readonly BenchFinding[];
  readonly advisory: readonly BenchFinding[];
  readonly metrics: Readonly<Record<string, number>>;
}

interface PageData {
  readonly path: string;
  readonly fields: PageFields;
  readonly text: string;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function outside(value: number, range: readonly [number, number]): boolean {
  return value < range[0] || value > range[1];
}

function sourceSlugViolation(page: PageData, suffix: string): boolean {
  return page.fields.type === "source" && !page.path.endsWith(suffix);
}

async function benchPages(wikiDir: string): Promise<string[]> {
  return (await listFiles(wikiDir, "", { extension: ".md" }))
    .filter(
      (path) =>
        !path.startsWith("sandbox/") &&
        !path.endsWith("AGENTS.md") &&
        path !== "log.md",
    )
    .sort();
}

function linkSymmetry(pages: readonly PageData[]): number {
  const indexByStem = new Map(
    pages.map((page, index) => [stem(page.path), index] as const),
  );
  const edges = new Set<string>();

  for (const [index, page] of pages.entries()) {
    const targets = extractWikilinks(bodyAfterFrontmatter(page.text)).map(
      (link) => link.target,
    );

    for (const target of targets) {
      const to = indexByStem.get(target);
      if (to !== undefined && to !== index) edges.add(`${index}:${to}`);
    }
  }

  let reciprocated = 0;

  for (const edge of edges) {
    const [from, to] = edge.split(":");
    if (edges.has(`${to}:${from}`)) reciprocated += 1;
  }

  return ratio(reciprocated, edges.size);
}

const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const THRESHOLD =
  /(?:[<>]=?|[≥≤])\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:[<>]=?|[≥≤])/g;
const NAMED_PROCEDURE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
const EMPHASIS = /\*\*[^*]+\*\*/g;
const HEADING = /^#{1,6}\s+/gm;

function countMatches(lines: readonly string[], pattern: RegExp): number {
  return lines.reduce(
    (sum, line) => sum + (line.match(pattern)?.length ?? 0),
    0,
  );
}

function textureMetrics(
  pages: readonly PageData[],
): Readonly<Record<string, number>> {
  const lines = pages
    .flatMap((page) => [...unfencedLines(bodyAfterFrontmatter(page.text))])
    .map(([, line]) => line)
    .filter(Boolean);

  const proseLines = lines.filter((line) => !/^#{1,6}\s/.test(line));
  const citedLines = proseLines.filter(
    (line) => extractWikilinks(line).length > 0,
  );

  const listLines = lines.filter((line) => /^\s*[-*+]\s+/.test(line)).length;
  const emphasis = countMatches(lines, EMPHASIS);
  const links = pages.reduce(
    (count, page) =>
      count + extractWikilinks(bodyAfterFrontmatter(page.text)).length,
    0,
  );
  const headings = countMatches(lines, HEADING);

  const anchored =
    countMatches(citedLines, NUMBER) +
    countMatches(citedLines, THRESHOLD) +
    countMatches(citedLines, NAMED_PROCEDURE);
  const procedures = countMatches(proseLines, NAMED_PROCEDURE);

  return {
    listShare: ratio(listLines, lines.length),
    emphasisPerPage: ratio(emphasis, pages.length),
    linksPerPage: ratio(links, pages.length),
    headingsPerPage: ratio(headings, pages.length),
    specificsPerPage: ratio(countMatches(lines, NUMBER), pages.length),
    thresholdsPerPage: ratio(countMatches(lines, THRESHOLD), pages.length),
    proceduresPerPage: ratio(procedures, pages.length),
    anchoredSpecificsPerPage: ratio(anchored, pages.length),
    linkSymmetry: linkSymmetry(pages),
  };
}

async function readPages(wikiDir: string): Promise<PageData[]> {
  return await Promise.all(
    (await benchPages(wikiDir)).map(async (path) => {
      const text = await readFile(join(wikiDir, path), "utf8");
      return { path, text, fields: parsePageFields(text) };
    }),
  );
}

function pageFindings(
  page: PageData,
  bands: ContentQualityBands,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const missing = bands.requiredFields.filter((field) => {
    const value = page.fields[field as keyof PageFields];

    return (
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    );
  });
  if (missing.length > 0) {
    findings.push({
      lane: "blocking",
      name: "frontmatter",
      detail: `${page.path}: missing ${missing.join(", ")}`,
    });
  }

  if (
    page.fields.status !== undefined &&
    !new Set(bands.statusAllowlist).has(page.fields.status)
  ) {
    findings.push({
      lane: "blocking",
      name: "status",
      detail: `${page.path}: ${page.fields.status}`,
    });
  }

  if (
    page.fields.confidence !== undefined &&
    !new Set(bands.confidenceAllowlist).has(page.fields.confidence)
  ) {
    findings.push({
      lane: "blocking",
      name: "confidence",
      detail: `${page.path}: ${page.fields.confidence}`,
    });
  }

  return findings;
}

function sourceSlugFindings(
  pages: readonly PageData[],
  bands: ContentQualityBands,
): BenchFinding[] {
  return pages
    .filter((page) => sourceSlugViolation(page, bands.sourceSlugSuffix))
    .map((page) => ({
      lane: "blocking" as const,
      name: "source-slug",
      detail: `${page.path}: source pages end in -source.md`,
    }));
}

function advisoryFindings(
  metrics: Readonly<Record<string, number>>,
  bands: ContentQualityBands,
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  if (outside(metrics.pageCount ?? 0, bands.pageCount)) {
    findings.push({
      lane: "advisory",
      name: "page-count",
      detail: `${metrics.pageCount} outside ${bands.pageCount.join("–")}`,
    });
  }

  if (outside(metrics.sourceShare ?? 0, bands.sourceShare)) {
    findings.push({
      lane: "advisory",
      name: "source-share",
      detail: `${metrics.sourceShare} outside ${bands.sourceShare.join("–")}`,
    });
  }

  return findings;
}

/** The worklists the correctness floor consumes — the mechanically
 *  defective ones. The single-source open set and the tag inventory
 *  stay out: candidates the lint agent judges, never verdicts. */
export interface BenchWorklists {
  readonly orphans: readonly { page: string; detail: string }[];
  readonly nonSourceEdges: readonly { page: string; detail: string }[];
  readonly frontmatterMisses: readonly { page: string; detail: string }[];
  readonly indexMisses: readonly { page: string; detail: string }[];
  readonly duplicateTitles: readonly { page: string; detail: string }[];
  readonly danglingIndexEntries: readonly string[];
}

export function worklistFloorFailures(worklists: BenchWorklists): string[] {
  const line = (entry: { page: string; detail: string }) =>
    `lint-worklists: ${entry.page} — ${entry.detail}`;

  return [
    ...worklists.orphans.map(line),
    ...worklists.nonSourceEdges.map(line),
    ...worklists.frontmatterMisses.map(line),
    ...worklists.indexMisses.map(line),
    ...worklists.duplicateTitles.map(line),
    ...worklists.danglingIndexEntries.map((d) => `lint-worklists: ${d}`),
  ];
}

export async function evaluateContentQuality(input: {
  readonly wikiDir: string;
  readonly bands: ContentQualityBands;
  readonly correctnessFailures: readonly string[];
  readonly answerabilityFailures: readonly string[];
}): Promise<ContentQualityReport> {
  const pages = await readPages(input.wikiDir);

  const blocking = [
    ...input.correctnessFailures.map(
      (detail): BenchFinding => ({
        lane: "blocking",
        name: "correctness-floor",
        detail,
      }),
    ),
    ...pages.flatMap((page) => pageFindings(page, input.bands)),
    ...input.answerabilityFailures.map(
      (detail): BenchFinding => ({
        lane: "blocking",
        name: "answerability",
        detail,
      }),
    ),
    ...sourceSlugFindings(pages, input.bands),
  ];

  const sourcePages = pages.filter(
    (page) => page.fields.type === "source",
  ).length;

  const metrics = {
    pageCount: pages.length,
    sourceShare: ratio(sourcePages, pages.length),
    ...textureMetrics(pages),
  };

  const advisory = advisoryFindings(metrics, input.bands);
  const verdict: BenchVerdict =
    blocking.length > 0 ? "fail" : advisory.length > 0 ? "warn" : "pass";

  return { verdict, blocking, advisory, metrics };
}

export function renderBenchReport(report: ContentQualityReport): string {
  const rows = (items: readonly BenchFinding[]) =>
    items.length === 0
      ? "- none"
      : items.map((item) => `- ${item.name}: ${item.detail}`).join("\n");
  return `# Content-quality bench\n\nVerdict: ${report.verdict}\n\n## Blocking now\n${rows(report.blocking)}\n\n## Advisory\n${rows(report.advisory)}\n\n## Metrics\n${Object.entries(
    report.metrics,
  )
    .map(([name, value]) => `- ${name}: ${value}`)
    .join("\n")}\n`;
}

/* v8 ignore next: covered only under direct `node src/quality/content-quality-bench.ts` runs */
refuseDirectExecution(import.meta.url, "content-quality-bench", "dev");
