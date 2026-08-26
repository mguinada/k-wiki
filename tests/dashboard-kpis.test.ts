import { describe, expect, it } from "vitest";
import {
  backlogFrom,
  computeKpis,
  funnelFrom,
  growthSeries,
  ingestCadence,
  mostCitedSources,
  needsReviewChurn,
  type PageSnapshot,
  provenanceBuckets,
  runsPerWeek,
  sourceRotBuckets,
  stalenessBuckets,
  statusCounts,
  typeCounts,
} from "../src/dashboard/kpis.ts";

/**
 * Pure KPI functions over a DashboardInput (issue #73): every fact is
 * one expectation, computed from fixture snapshots — no I/O anywhere
 * in this file.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** A page snapshot with every field overridable. */
function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    path: "concepts/a.md",
    title: "A",
    type: "concept",
    updated: "2026-08-25",
    status: "stable",
    sourcesCount: 2,
    sources: [],
    outbound: [],
    ...overrides,
  };
}

describe("stalenessBuckets", () => {
  it("counts a page updated 7 or fewer days ago as fresh", () => {
    const buckets = stalenessBuckets([page({ updated: "2026-08-31" })], NOW);

    expect(buckets.fresh).toBe(1);
  });

  it("counts a page updated 8 to 30 days ago as month", () => {
    const buckets = stalenessBuckets([page({ updated: "2026-08-10" })], NOW);

    expect(buckets.month).toBe(1);
  });

  it("counts a page updated 31 to 90 days ago as quarter", () => {
    const buckets = stalenessBuckets([page({ updated: "2026-07-01" })], NOW);

    expect(buckets.quarter).toBe(1);
  });

  it("counts a page updated more than 90 days ago as stale", () => {
    const buckets = stalenessBuckets([page({ updated: "2026-05-01" })], NOW);

    expect(buckets.stale).toBe(1);
  });

  it("counts a page updated exactly 30 days ago as month, not quarter", () => {
    const buckets = stalenessBuckets([page({ updated: "2026-08-02" })], NOW);

    expect(buckets.month).toBe(1);
  });

  it("counts a page updated exactly 90 days ago as quarter, not stale", () => {
    const buckets = stalenessBuckets([page({ updated: "2026-06-03" })], NOW);

    expect(buckets.quarter).toBe(1);
  });

  it("counts a page without an updated field as undated", () => {
    const buckets = stalenessBuckets([page({ updated: null })], NOW);

    expect(buckets.undated).toBe(1);
  });

  it("counts a page with an unparseable updated value as undated", () => {
    const buckets = stalenessBuckets([page({ updated: "banana" })], NOW);

    expect(buckets.undated).toBe(1);
  });

  it("sorts every page of a mixed set into exactly one bucket", () => {
    const buckets = stalenessBuckets(
      [
        page({ updated: "2026-09-01" }),
        page({ updated: "2026-08-20" }),
        page({ updated: "2026-06-20" }),
        page({ updated: "2025-01-01" }),
        page({ updated: null }),
      ],
      NOW,
    );

    expect(buckets).toEqual({
      fresh: 1,
      month: 1,
      quarter: 1,
      stale: 1,
      undated: 1,
    });
  });
});

describe("backlogFrom", () => {
  it("counts raw notes the ingest snapshot does not list", () => {
    const backlog = backlogFrom(
      ["Engineering/a.md", "Engineering/b.md", "Engineering/c.md"],
      ["Engineering/a.md", "Engineering/c.md"],
    );

    expect(backlog.count).toBe(1);
  });

  it("reports every raw note as pending when no snapshot exists", () => {
    const backlog = backlogFrom(["Engineering/a.md", "Engineering/b.md"], null);

    expect(backlog).toEqual({
      count: 2,
      rawTotal: 2,
      snapshotPresent: false,
    });
  });

  it("reports zero backlog for a fully ingested projection", () => {
    const backlog = backlogFrom(["Engineering/a.md"], ["Engineering/a.md"]);

    expect(backlog.count).toBe(0);
  });
});

describe("computeKpis link graph", () => {
  it("marks a page nothing links to as an orphan", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "a.md", outbound: ["b"] }),
        page({ path: "b.md", outbound: [] }),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.orphans).toEqual(["a.md"]);
  });

  it("does not count a resolved outbound link as dead", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "a.md", outbound: ["b"] }),
        page({ path: "b.md", outbound: [] }),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.deadLinks).toEqual([]);
  });

  it("reports an outbound link that resolves to no page as dead", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [page({ path: "a.md", outbound: ["Missing"] })],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.deadLinks).toEqual([{ source: "a.md", target: "Missing" }]);
  });

  it("resolves a link to a nested page by its page name", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "a.md", outbound: ["deep-page"] }),
        page({ path: "concepts/deep-page.md", title: "Deep page" }),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.orphans).toEqual(["a.md"]);
  });

  it("does not count the navigation root index.md as an orphan", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "index.md", outbound: [] }),
        page({ path: "orphan.md", outbound: [] }),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.orphans).toEqual(["orphan.md"]);
  });

  it("skips cross-wiki link targets in the internal graph", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [page({ path: "a.md", outbound: ["Other/elsewhere"] })],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.deadLinks).toEqual([]);
  });

  it("ranks hub pages by inbound link count, highest first", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "hub.md", outbound: [] }),
        page({ path: "mid.md", outbound: ["hub"] }),
        page({ path: "x.md", outbound: ["hub", "mid"] }),
        page({ path: "y.md", outbound: ["hub"] }),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.hubs).toEqual([
      { path: "hub.md", inbound: 3 },
      { path: "mid.md", inbound: 1 },
    ]);
  });

  it("caps the hub list at five pages", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "hub.md" }),
        ...[1, 2, 3, 4, 5, 6].map((n) =>
          page({ path: `p${n}.md`, outbound: [`hub`, `hub-${n}`] }),
        ),
        ...[1, 2, 3, 4, 5, 6].map((n) =>
          page({ path: `hub-${n}.md`, title: `Hub ${n}` }),
        ),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.hubs).toHaveLength(5);
  });
});

describe("typeCounts", () => {
  it("counts pages per frontmatter type, largest first", () => {
    const counts = typeCounts([
      page({ type: "source" }),
      page({ type: "source", path: "b.md" }),
      page({ type: "concept" }),
    ]);

    expect(counts).toEqual([
      { label: "source", count: 2 },
      { label: "concept", count: 1 },
    ]);
  });

  it("breaks count ties alphabetically by label", () => {
    const counts = typeCounts([
      page({ type: "source" }),
      page({ type: "concept" }),
    ]);

    expect(counts).toEqual([
      { label: "concept", count: 1 },
      { label: "source", count: 1 },
    ]);
  });
});

describe("statusCounts", () => {
  it("counts pages without a status under the unset label", () => {
    const counts = statusCounts([page({ status: null })]);

    expect(counts).toEqual([{ label: "unset", count: 1 }]);
  });

  it("counts needs-review pages like any other status", () => {
    const counts = statusCounts([
      page({ status: "needs-review" }),
      page({ status: "stable", path: "b.md" }),
    ]);

    expect(counts).toEqual([
      { label: "needs-review", count: 1 },
      { label: "stable", count: 1 },
    ]);
  });
});

describe("runsPerWeek", () => {
  it("counts pipeline commits in the week they landed", () => {
    const weeks = runsPerWeek(
      [
        { date: "2026-08-31", subject: "wiki-sync: 9 sources processed" },
        { date: "2026-08-25", subject: "wiki-sync: 1 source processed" },
      ],
      NOW,
    );

    expect(weeks[weeks.length - 1]?.count).toBe(1);
  });

  it("ignores commits that are not pipeline runs", () => {
    const weeks = runsPerWeek(
      [{ date: "2026-08-31", subject: "sweep: rename 133 pages" }],
      NOW,
    );

    expect(weeks.reduce((total, week) => total + week.count, 0)).toBe(0);
  });

  it("returns the trailing twelve weeks oldest first", () => {
    const weeks = runsPerWeek([], NOW);

    expect(weeks).toHaveLength(12);
  });

  it("labels each bucket with its Monday start date", () => {
    const weeks = runsPerWeek([], NOW);

    expect(weeks[weeks.length - 1]?.week).toBe("2026-08-31");
  });
});

describe("growthSeries", () => {
  it("accumulates every page added up to each week", () => {
    const series = growthSeries(
      [
        { path: "a.md", date: "2026-08-20" },
        { path: "b.md", date: "2026-08-27" },
        { path: "c.md", date: "2026-09-01" },
      ],
      NOW,
    );

    expect(series[series.length - 1]?.count).toBe(3);
    expect(series[series.length - 2]?.count).toBe(2);
  });

  it("counts an addition on a week boundary in that week", () => {
    const series = growthSeries([{ path: "a.md", date: "2026-08-31" }], NOW);

    expect(series[series.length - 1]?.count).toBe(1);
  });
});

describe("provenanceBuckets", () => {
  it("buckets pages by source count", () => {
    const buckets = provenanceBuckets([
      page({ sourcesCount: 0 }),
      page({ sourcesCount: 1, path: "b.md" }),
      page({ sourcesCount: 2, path: "c.md" }),
      page({ sourcesCount: 3, path: "d.md" }),
      page({ sourcesCount: 9, path: "e.md" }),
    ]);

    expect(buckets).toEqual({ zero: 1, single: 1, twoThree: 2, fourPlus: 1 });
  });
});

describe("funnelFrom", () => {
  it("counts filed queries from type query pages", () => {
    const funnel = funnelFrom(
      [page({ type: "query" }), page({ type: "concept" })],
      "2026-08-30T10:00:00.000Z",
    );

    expect(funnel.filedCount).toBe(1);
  });

  it("marks the funnel absent when last-query.md is missing", () => {
    const funnel = funnelFrom([page({ type: "query" })], null);

    expect(funnel.present).toBe(false);
  });

  it("carries the last run timestamp when the artifact exists", () => {
    const funnel = funnelFrom([], "2026-08-30T10:00:00.000Z");

    expect(funnel.lastRunAt).toBe("2026-08-30T10:00:00.000Z");
  });
});

describe("computeKpis totals", () => {
  it("reports the total page count", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [page(), page({ path: "b.md" })],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.totalPages).toBe(2);
  });

  it("reports the sync lag in days from the newest manifest timestamp", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: "2026-08-30T00:00:00.000Z",
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.syncLagDays).toBe(2);
  });

  it("reports null sync lag without a manifest timestamp", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.syncLagDays).toBeNull();
  });

  it("reports null sync lag for an unparseable manifest timestamp", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: "banana",
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.syncLagDays).toBeNull();
  });
});

describe("missingPages", () => {
  it("ranks dead-link targets by how many pages want them", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [
        page({ path: "a.md", outbound: ["Wanted", "Wanted"] }),
        page({ path: "b.md", outbound: ["Wanted"] }),
        page({ path: "c.md", outbound: ["Also-wanted"] }),
      ],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.missingPages).toEqual([
      { target: "Wanted", wantedBy: 3 },
      { target: "Also-wanted", wantedBy: 1 },
    ]);
  });

  it("keeps at most five missing pages", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [1, 2, 3, 4, 5, 6].map((n) =>
        page({ path: `p${n}.md`, outbound: [`Missing ${n}`] }),
      ),
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.missingPages).toHaveLength(5);
  });

  it("is empty when every link resolves", () => {
    const kpis = computeKpis({
      now: NOW,
      head: "abc1234",
      pages: [page({ path: "a.md", outbound: [] })],
      rawNoteKeys: [],
      ingestedKeys: [],
      lastSync: null,
      rawNoteSyncDates: [],
      statusFlips: [],
      commits: [],
      firstAdded: [],
      lastQuery: null,
    });

    expect(kpis.missingPages).toEqual([]);
  });
});

describe("sourceRotBuckets", () => {
  it("buckets raw notes by time since their content last changed", () => {
    const buckets = sourceRotBuckets(
      [
        { key: "V/new.md", lastSynced: "2026-08-30T00:00:00.000Z" },
        { key: "V/aging.md", lastSynced: "2026-07-15T00:00:00.000Z" },
        { key: "V/stale.md", lastSynced: "2026-05-01T00:00:00.000Z" },
      ],
      NOW,
    );

    expect(buckets).toEqual({ fresh: 1, aging: 1, stale: 1 });
  });

  it("counts a note last synced 31 days ago as aging", () => {
    const buckets = sourceRotBuckets(
      [{ key: "V/a.md", lastSynced: "2026-08-01T00:00:00.000Z" }],
      NOW,
    );

    expect(buckets.aging).toBe(1);
  });

  it("skips a note whose sync stamp is unparseable", () => {
    const buckets = sourceRotBuckets(
      [{ key: "V/bad.md", lastSynced: "banana" }],
      NOW,
    );

    expect(buckets).toEqual({ fresh: 0, aging: 0, stale: 0 });
  });

  it("counts a note last synced 91 days ago as stale", () => {
    const buckets = sourceRotBuckets(
      [{ key: "V/a.md", lastSynced: "2026-06-02T00:00:00.000Z" }],
      NOW,
    );

    expect(buckets.stale).toBe(1);
  });
});

describe("mostCitedSources", () => {
  it("ranks raw notes by how many pages cite them", () => {
    const cited = mostCitedSources([
      page({ sources: ["notes/Engineering/a.md", "notes/Engineering/b.md"] }),
      page({
        path: "b.md",
        sources: ["notes/Engineering/a.md", "[[a]]"],
      }),
    ]);

    expect(cited).toEqual([
      { entry: "notes/Engineering/a.md", citedBy: 2 },
      { entry: "[[a]]", citedBy: 1 },
      { entry: "notes/Engineering/b.md", citedBy: 1 },
    ]);
  });

  it("keeps at most five sources", () => {
    const cited = mostCitedSources([
      page({
        sources: [1, 2, 3, 4, 5, 6].map((n) => `notes/Engineering/s${n}.md`),
      }),
    ]);

    expect(cited).toHaveLength(5);
  });
});

describe("ingestCadence", () => {
  it("reports the mean days between ingest runs", () => {
    const cadence = ingestCadence([
      {
        date: "2026-08-30",
        subject: "wiki-sync: 1 source processed, 2 pages touched",
      },
      {
        date: "2026-08-28",
        subject: "wiki-sync: 2 sources processed, 3 pages touched",
      },
      {
        date: "2026-08-25",
        subject: "wiki-sync: 3 sources processed, 4 pages touched",
      },
    ]);

    expect(cadence).toBe(2.5);
  });

  it("is null without at least two runs", () => {
    expect(
      ingestCadence([{ date: "2026-08-30", subject: "wiki-sync: x" }]),
    ).toBeNull();
  });

  it("ignores commits that are not runs", () => {
    expect(
      ingestCadence([
        { date: "2026-08-30", subject: "sweep: rename pages" },
        { date: "2026-08-25", subject: "wiki-sync: x" },
      ]),
    ).toBeNull();
  });
});

describe("needsReviewChurn", () => {
  it("buckets status-flip commits per week over the trailing weeks", () => {
    const weeks = needsReviewChurn(
      [
        { date: "2026-08-31", subject: "anything" },
        { date: "2026-08-31", subject: "anything" },
        { date: "2026-08-20", subject: "anything" },
      ],
      NOW,
    );

    expect(weeks[weeks.length - 1]?.count).toBe(2);
    expect(weeks[weeks.length - 3]?.count).toBe(1);
  });

  it("returns the trailing twelve weeks oldest first", () => {
    const weeks = needsReviewChurn([], NOW);

    expect(weeks).toHaveLength(12);
  });

  it("ignores flips older than the trailing window", () => {
    const weeks = needsReviewChurn([{ date: "2026-01-01", subject: "x" }], NOW);

    expect(weeks.reduce((total, week) => total + week.count, 0)).toBe(0);
  });
});
