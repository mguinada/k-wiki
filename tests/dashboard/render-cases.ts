import {
  computeKpis,
  type DashboardInput,
  type DashboardKpis,
} from "../../src/dashboard/kpis.ts";
import type { DashboardMeta } from "../../src/dashboard/render.ts";

/**
 * Shared render fixtures: the base KPI set the render tests assert
 * against, plus the golden-output cases (structure-heavy and sparse)
 * whose full HTML is pinned byte-for-byte in tests/dashboard/golden/.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** A small, fully populated KPI set for rendering assertions. */
export function fixtureKpis(): DashboardKpis {
  const input: DashboardInput = {
    now: NOW,
    head: "abee7c4",
    pages: [
      {
        path: "concepts/agent-evals.md",
        title: "Agent evals",
        type: "concept",
        updated: "2026-08-25",
        status: "stable",
        sourcesCount: 11,
        sources: ["notes/Engineering/evals.md"],
        outbound: ["overview"],
      },
      {
        path: "sources/beginner-roadmap.md",
        title: "Beginner roadmap",
        type: "source",
        updated: "2026-05-01",
        status: "needs-review",
        sourcesCount: 1,
        sources: ["notes/Engineering/a.md"],
        outbound: [],
      },
      {
        path: "queries/how-to-eval.md",
        title: "How to eval",
        type: "query",
        updated: "2026-08-30",
        status: "filed",
        sourcesCount: 2,
        sources: ["notes/Engineering/a.md", "[[agent-evals]]"],
        outbound: [],
      },
      {
        path: "overview.md",
        title: "Overview",
        type: "topic",
        updated: null,
        status: null,
        sourcesCount: 0,
        sources: [],
        outbound: ["agent-evals"],
      },
    ],
    rawNoteKeys: ["Engineering/a.md", "Engineering/b.md", "Engineering/c.md"],
    ingestedKeys: ["Engineering/a.md", "Engineering/b.md"],
    lastSync: "2026-08-30T00:00:00.000Z",
    rawNoteSyncDates: [
      { key: "Engineering/a.md", lastSynced: "2026-08-30T00:00:00.000Z" },
      { key: "Engineering/b.md", lastSynced: "2026-05-01T00:00:00.000Z" },
    ],
    statusFlips: [{ date: "2026-08-20", subject: "ingest" }],
    commits: [
      { date: "2026-08-25", subject: "wiki-sync: 9 sources processed" },
      { date: "2026-08-20", subject: "wiki-sync: 0 sources processed" },
      { date: "2026-08-19", subject: "sweep: rename pages" },
    ],
    firstAdded: [
      { path: "overview.md", date: "2026-06-01" },
      { path: "concepts/agent-evals.md", date: "2026-08-20" },
      { path: "sources/beginner-roadmap.md", date: "2026-08-25" },
      { path: "queries/how-to-eval.md", date: "2026-08-28" },
    ],
    lastQuery: "2026-08-30T10:00:00.000Z",
  };

  return computeKpis(input);
}

/** The meta every golden case renders with. */
export const GOLDEN_META: DashboardMeta = {
  generatedAt: NOW,
  head: "abee7c4",
  dataRoot: "~/Lab/k-wiki-data",
};

/** One golden-output case: a name and the exact inputs to render. */
export interface RenderCase {
  readonly name: string;
  readonly kpis: DashboardKpis;
  readonly meta: DashboardMeta;
}

/** The golden cases: the base fixture, a structure-heavy variant
 *  (13 orphans, dead links, missing pages — the truncation and list
 *  branches), and a sparse variant (absent artifacts — the empty and
 *  null branches). */
export function goldenCases(): RenderCase[] {
  const base = fixtureKpis();

  const structureHeavy: DashboardKpis = {
    ...base,
    orphans: [
      'concepts/a<b>&"c.md',
      "concepts/one.md",
      "concepts/two.md",
      "concepts/three.md",
      "concepts/four.md",
      "concepts/five.md",
      "concepts/six.md",
      "concepts/seven.md",
      "concepts/eight.md",
      "concepts/nine.md",
      "concepts/ten.md",
      "concepts/eleven.md",
      "concepts/twelve.md",
    ],
    deadLinks: [
      { source: "concepts/agent-evals.md", target: "missing-page" },
      { source: "sources/a&b<c>.md", target: 'T"&g' },
    ],
    missingPages: [
      { target: "eval-harness", wantedBy: 3 },
      { target: "metrics", wantedBy: 1 },
    ],
  };

  const sparse: DashboardKpis = {
    ...base,
    totalPages: 0,
    backlog: { count: 0, rawTotal: 0, snapshotPresent: false },
    typeCounts: [],
    staleness: { fresh: 0, month: 0, quarter: 0, stale: 0, undated: 0 },
    syncLagDays: null,
    orphans: [],
    deadLinks: [],
    hubs: [],
    statusCounts: [
      { label: "stable", count: 100 },
      { label: "filed", count: 1 },
    ],
    missingPages: [],
    sourceRot: { fresh: 0, aging: 0, stale: 0 },
    mostCited: [],
    cadenceDays: null,
    needsReviewChurn: [
      { week: "2026-06-08", count: 1 },
      { week: "2026-08-24", count: 100 },
    ],
    runsPerWeek: [
      { week: "2026-06-08", count: 0 },
      { week: "2026-08-24", count: 0 },
    ],
    sourcesPerRun: null,
    growth: [],
    provenance: { zero: 0, single: 0, twoThree: 0, fourPlus: 0 },
    funnel: { present: false, filedCount: 0, lastRunAt: null },
  };

  return [
    { name: "base", kpis: base, meta: GOLDEN_META },
    { name: "structure-heavy", kpis: structureHeavy, meta: GOLDEN_META },
    {
      name: "sparse",
      kpis: sparse,
      meta: { generatedAt: NOW, head: "", dataRoot: "" },
    },
  ];
}
