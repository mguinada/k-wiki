/**
 * Deterministic measurement and verdict logic for the content-quality bench.
 * The dev runner owns the disposable real-model cycle; this module only reads
 * the produced wiki and therefore remains model-free and testable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles } from "../cli/shared.ts";

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
  readonly fields: Readonly<Record<string, string | undefined>>;
  readonly text: string;
}

function fieldValue(key: string, value: string): string | undefined {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (unquoted !== "") return unquoted;
  return key === "tags" || key === "sources" ? "[list]" : undefined;
}

function addField(
  line: string,
  fields: Record<string, string | undefined>,
): void {
  const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
  if (match === null) return;
  fields[match[1] ?? ""] = fieldValue(match[1] ?? "", match[2] ?? "");
}

function frontmatter(
  text: string,
): Readonly<Record<string, string | undefined>> {
  const lines = text.split("\n");
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const fields: Record<string, string | undefined> = {};
  if (close === -1) return fields;
  for (const line of lines.slice(1, close)) addField(line, fields);
  return fields;
}

function body(text: string): string {
  const lines = text.split("\n");
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  return close === -1 ? text : lines.slice(close + 1).join("\n");
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
      (path) => !path.startsWith("sandbox/") && !path.endsWith("AGENTS.md"),
    )
    .sort();
}

function linkCount(text: string): number {
  return text.match(/\[\[[^\]]+\]\]/g)?.length ?? 0;
}

function textureMetrics(
  pages: readonly PageData[],
): Readonly<Record<string, number>> {
  const bodies = pages.map((page) => body(page.text));
  const lines = bodies.flatMap((value) => value.split("\n")).filter(Boolean);
  const listLines = lines.filter((line) => /^\s*[-*+]\s+/.test(line)).length;
  const emphasis = bodies.reduce(
    (count, value) => count + (value.match(/\*\*[^*]+\*\*/g)?.length ?? 0),
    0,
  );
  const links = bodies.reduce((count, value) => count + linkCount(value), 0);
  const headings = bodies.reduce(
    (count, value) => count + (value.match(/^#{1,6}\s+/gm)?.length ?? 0),
    0,
  );
  const specifics = bodies.reduce(
    (count, value) => count + (value.match(/\b\d+(?:\.\d+)?\b/g)?.length ?? 0),
    0,
  );

  return {
    listShare: ratio(listLines, lines.length),
    emphasisPerPage: ratio(emphasis, pages.length),
    linksPerPage: ratio(links, pages.length),
    headingsPerPage: ratio(headings, pages.length),
    specificsPerPage: ratio(specifics, pages.length),
  };
}

async function readPages(wikiDir: string): Promise<PageData[]> {
  return await Promise.all(
    (await benchPages(wikiDir)).map(async (path) => {
      const text = await readFile(join(wikiDir, path), "utf8");
      return { path, text, fields: frontmatter(text) };
    }),
  );
}

function pageFindings(
  page: PageData,
  bands: ContentQualityBands,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const missing = bands.requiredFields.filter(
    (field) => page.fields[field] === undefined,
  );
  if (missing.length > 0)
    findings.push({
      lane: "blocking",
      name: "frontmatter",
      detail: `${page.path}: missing ${missing.join(", ")}`,
    });
  if (
    page.fields.status !== undefined &&
    !new Set(bands.statusAllowlist).has(page.fields.status)
  )
    findings.push({
      lane: "blocking",
      name: "status",
      detail: `${page.path}: ${page.fields.status}`,
    });
  if (
    page.fields.confidence !== undefined &&
    !new Set(bands.confidenceAllowlist).has(page.fields.confidence)
  )
    findings.push({
      lane: "blocking",
      name: "confidence",
      detail: `${page.path}: ${page.fields.confidence}`,
    });
  if (sourceSlugViolation(page, bands.sourceSlugSuffix))
    findings.push({
      lane: "blocking",
      name: "source-slug",
      detail: `${page.path}: source pages end in -source.md`,
    });
  return findings;
}

function advisoryFindings(
  metrics: Readonly<Record<string, number>>,
  bands: ContentQualityBands,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  if (outside(metrics.pageCount ?? 0, bands.pageCount))
    findings.push({
      lane: "advisory",
      name: "page-count",
      detail: `${metrics.pageCount} outside ${bands.pageCount.join("–")}`,
    });
  if (outside(metrics.sourceShare ?? 0, bands.sourceShare))
    findings.push({
      lane: "advisory",
      name: "source-share",
      detail: `${metrics.sourceShare} outside ${bands.sourceShare.join("–")}`,
    });
  return findings;
}

export async function evaluateContentQuality(input: {
  readonly wikiDir: string;
  readonly bands: ContentQualityBands;
  readonly correctnessFailures: readonly string[];
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
  return `# Content-quality bench\n\nVerdict: ${report.verdict}\n\n## Blocking\n${rows(report.blocking)}\n\n## Advisory\n${rows(report.advisory)}\n\n## Metrics\n${Object.entries(
    report.metrics,
  )
    .map(([name, value]) => `- ${name}: ${value}`)
    .join("\n")}\n`;
}
