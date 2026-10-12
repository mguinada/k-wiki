import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContentQualityBands,
  evaluateContentQuality,
  renderBenchReport,
  worklistFloorFailures,
} from "../../src/quality/content-quality-bench.ts";

const dirs: string[] = [];

async function wikiWith(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-quality-bench-"));
  dirs.push(root);
  const wiki = join(root, "wiki");
  await mkdir(wiki, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(wiki, name), text);
  }
  return wiki;
}

async function reportFor(files: Readonly<Record<string, string>>) {
  return evaluateContentQuality({
    wikiDir: await wikiWith(files),
    bands,
    correctnessFailures: [],
    pendingConventionFailures: [],
  });
}

const bands: ContentQualityBands = {
  pageCount: [2, 4],
  sourceShare: [0, 1],
  statusAllowlist: ["needs-review"],
  confidenceAllowlist: ["low", "medium", "high"],
  sourceSlugSuffix: "-source.md",
  requiredFields: ["title", "type", "created", "updated", "tags"],
};

const valid = `---
title: "Page"
type: concept
created: 2026-10-11
updated: 2026-10-11
tags:
  - test
sources:
  - "[[source-source]]"
confidence: high
status: needs-review
---

A **linked** page [[source-source]].
`;

const specific = valid.replace(
  "A **linked** page [[source-source]].",
  "Procedure Alpha keeps the threshold at ≥ 0.80. See [[source-source]].",
);

const entry = (page: string, detail: string) => ({ page, detail });

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("evaluateContentQuality", () => {
  it("fails deterministic counter-signals", async () => {
    const report = await reportFor({
      "page.md": valid.replace("confidence: high", "confidence: certain"),
    });
    expect(report.verdict).toBe("fail");
  });

  it("warns when the page count is outside its band", async () => {
    const report = await reportFor({
      "page.md": valid.replace(
        "A **linked** page [[source-source]].",
        "- one\n- two\n- three\n",
      ),
    });
    expect(report.verdict).toBe("warn");
  });

  it("reports zero link symmetry when no link edge is reciprocated", async () => {
    const report = await reportFor({
      "page.md": valid,
      "source-source.md": valid.replace(
        "A **linked** page [[source-source]].",
        "A standalone page without links.",
      ),
    });
    expect(report.metrics.linkSymmetry).toBe(0);
  });

  it("reports full link symmetry when every link edge is reciprocated", async () => {
    const report = await reportFor({
      "page.md": valid,
      "source-source.md": valid.replace(
        "A **linked** page [[source-source]].",
        "A linked page back to [[page]].",
      ),
    });
    expect(report.metrics.linkSymmetry).toBe(1);
  });

  it("ignores wikilinks inside fenced code when measuring symmetry", async () => {
    const report = await reportFor({
      "page.md": valid,
      "source-source.md": valid.replace(
        "A **linked** page [[source-source]].",
        "A cited page.\n\n```md\nA mere example: [[page]].\n```\n",
      ),
    });
    expect(report.metrics.linkSymmetry).toBe(0);
  });

  it("counts comparison-anchored numbers as thresholds", async () => {
    const report = await reportFor({ "page.md": specific });
    expect(report.metrics.thresholdsPerPage).toBe(1);
  });

  it("counts capitalized phrases as named procedures", async () => {
    const report = await reportFor({ "page.md": specific });
    expect(report.metrics.proceduresPerPage).toBe(1);
  });

  it("counts specifics on cited lines as anchored attribution", async () => {
    const report = await reportFor({ "page.md": specific });
    expect(report.metrics.anchoredSpecificsPerPage).toBe(3);
  });

  it("renders a durable human-readable verdict", async () => {
    const wiki = await wikiWith({
      "page.md": valid.replace("type: concept", "type: source"),
    });
    const report = await evaluateContentQuality({
      wikiDir: wiki,
      bands: { ...bands, pageCount: [1, 4] },
      correctnessFailures: [],
      pendingConventionFailures: ["query answerability: fixture question"],
    });
    expect(renderBenchReport(report)).toContain("Verdict: pass");
  });
});

describe("worklistFloorFailures", () => {
  it("routes mechanical worklist entries into the correctness floor", () => {
    expect(
      worklistFloorFailures({
        orphans: [entry("drift.md", "no inbound links")],
        nonSourceEdges: [
          entry("drift.md", "sources entry cites type: concept"),
        ],
        frontmatterMisses: [entry("drift.md", "missing: tags")],
        indexMisses: [entry("drift.md", "not listed in index.md")],
        duplicateTitles: [entry("drift.md", "duplicate title slug drift")],
        danglingIndexEntries: ["index.md -> [[ghost]] has no page"],
      }),
    ).toEqual([
      "lint-worklists: drift.md — no inbound links",
      "lint-worklists: drift.md — sources entry cites type: concept",
      "lint-worklists: drift.md — missing: tags",
      "lint-worklists: drift.md — not listed in index.md",
      "lint-worklists: drift.md — duplicate title slug drift",
      "lint-worklists: index.md -> [[ghost]] has no page",
    ]);
  });

  it("returns no floor failures when the mechanical lists are empty", () => {
    expect(
      worklistFloorFailures({
        orphans: [],
        nonSourceEdges: [],
        frontmatterMisses: [],
        indexMisses: [],
        duplicateTitles: [],
        danglingIndexEntries: [],
      }),
    ).toEqual([]);
  });
});
