import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContentQualityBands,
  evaluateContentQuality,
  renderBenchReport,
} from "../../src/quality/content-quality-bench.ts";

const dirs: string[] = [];

async function wikiWith(page: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-quality-bench-"));
  dirs.push(root);
  const wiki = join(root, "wiki");
  await mkdir(wiki, { recursive: true });
  await writeFile(join(wiki, "page.md"), page);
  return wiki;
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

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("evaluateContentQuality", () => {
  it("fails deterministic counter-signals", async () => {
    const wiki = await wikiWith(
      valid.replace("confidence: high", "confidence: certain"),
    );
    const report = await evaluateContentQuality({
      wikiDir: wiki,
      bands,
      correctnessFailures: [],
      pendingConventionFailures: [],
    });
    expect(report.verdict).toBe("fail");
  });

  it("warns when a texture metric is outside its observed band", async () => {
    const wiki = await wikiWith(
      valid.replace(
        "A **linked** page [[source-source]].",
        "- one\n- two\n- three\n",
      ),
    );
    const report = await evaluateContentQuality({
      wikiDir: wiki,
      bands,
      correctnessFailures: [],
      pendingConventionFailures: [],
    });
    expect(report.verdict).toBe("warn");
  });

  it("renders a durable human-readable verdict", async () => {
    const wiki = await wikiWith(valid.replace("type: concept", "type: source"));
    const report = await evaluateContentQuality({
      wikiDir: wiki,
      bands: { ...bands, pageCount: [1, 4] },
      correctnessFailures: [],
      pendingConventionFailures: ["query answerability: fixture question"],
    });
    expect(renderBenchReport(report)).toContain("Verdict: pass");
  });
});
