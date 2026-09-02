import { buildPageIndex, crossWikiTarget } from "../wiki/wiki-links.ts";

/**
 * Pure KPI computation for the static dashboard (issue #73): every
 * function takes fixture-friendly data and returns plain numbers —
 * no I/O, fully unit-tested. Collection (reading the data repo) lives
 * in collect.ts; the HTML template lives in render.ts.
 */

/** One wiki page as the dashboard sees it. */
export interface PageSnapshot {
  /** Wiki-relative path, e.g. `concepts/agent-evals.md`. */
  readonly path: string;
  /** Frontmatter `title`; falls back to the file name. */
  readonly title: string;
  /** Frontmatter `type`; `unset` when absent. */
  readonly type: string;
  /** Frontmatter `updated` (`YYYY-MM-DD`); null when absent. */
  readonly updated: string | null;
  /** Frontmatter `status`; null when absent. */
  readonly status: string | null;
  /** Number of `sources` entries. */
  readonly sourcesCount: number;
  /** `sources` entries as written (wikilinks still bracketed). */
  readonly sources: readonly string[];
  /** Wikilink page names this page links to. */
  readonly outbound: readonly string[];
}

/** One data-repo commit fact, already parsed from the git log. */
export interface CommitFact {
  /** Commit date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly subject: string;
}

/** A wiki page's first appearance in git history. */
export interface AdditionFact {
  readonly path: string;
  /** First-add commit date, `YYYY-MM-DD`. */
  readonly date: string;
}

/** Everything the KPIs are computed from — pure data, no I/O. */
export interface DashboardInput {
  readonly now: Date;
  /** Data-repo HEAD short sha; empty string when git could not tell. */
  readonly head: string;
  readonly pages: readonly PageSnapshot[];
  /** `<vault>/<vault-relative path>` of every raw note file. */
  readonly rawNoteKeys: readonly string[];
  /** Snapshot keys of ingested sources; null when no snapshot exists. */
  readonly ingestedKeys: readonly string[] | null;
  /** Newest `last_synced` of the raw manifest; null when absent. */
  readonly lastSync: string | null;
  /** Every raw note with its own `last_synced` (content-change age). */
  readonly rawNoteSyncDates: readonly {
    readonly key: string;
    readonly lastSynced: string;
  }[];
  /** Data-repo commits, newest first, subjects included. */
  readonly commits: readonly CommitFact[];
  /** Commits that changed a `status: needs-review` line in wiki/,
   *  newest first (git log -G; both directions of the flip). */
  readonly statusFlips: readonly CommitFact[];
  /** First-add facts for wiki pages, from git history. */
  readonly firstAdded: readonly AdditionFact[];
  /** Timestamp recorded in outputs/last-query.md; null when absent. */
  readonly lastQuery: string | null;
}

/** One labeled count, rendered as a bar. */
export interface KpiBar {
  readonly label: string;
  readonly count: number;
}

export interface StalenessBuckets {
  /** Updated within the last 7 days. */
  readonly fresh: number;
  /** 8–30 days. */
  readonly month: number;
  /** 31–90 days. */
  readonly quarter: number;
  /** Older than 90 days. */
  readonly stale: number;
  /** No `updated` field. */
  readonly undated: number;
}

/** One week bucket; `week` is the Monday it starts on, `YYYY-MM-DD`. */
export interface WeekPoint {
  readonly week: string;
  readonly count: number;
}

/** Days between two `YYYY-MM-DD` dates (UTC), floor; NaN when invalid. */
function ageInDays(updated: string, now: Date): number {
  const then = Date.parse(`${updated}T00:00:00.000Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);

  return (today - then) / 86_400_000;
}

/** Bucket pages by age since their last `updated` date. */
export function stalenessBuckets(
  pages: readonly PageSnapshot[],
  now: Date,
): StalenessBuckets {
  const buckets = { fresh: 0, month: 0, quarter: 0, stale: 0, undated: 0 };

  for (const page of pages) {
    if (page.updated === null) {
      buckets.undated++;

      continue;
    }

    const age = ageInDays(page.updated, now);

    if (!Number.isFinite(age)) {
      buckets.undated++;

      continue;
    }

    if (age <= 7) {
      buckets.fresh++;
    } else if (age <= 30) {
      buckets.month++;
    } else if (age <= 90) {
      buckets.quarter++;
    } else {
      buckets.stale++;
    }
  }

  return buckets;
}

/** Un-ingested backlog: raw notes the ingest snapshot does not list. */
export function backlogFrom(
  rawNoteKeys: readonly string[],
  ingestedKeys: readonly string[] | null,
): { count: number; rawTotal: number; snapshotPresent: boolean } {
  if (ingestedKeys === null) {
    return {
      count: rawNoteKeys.length,
      rawTotal: rawNoteKeys.length,
      snapshotPresent: false,
    };
  }

  const ingested = new Set(ingestedKeys);

  return {
    count: rawNoteKeys.filter((key) => !ingested.has(key)).length,
    rawTotal: rawNoteKeys.length,
    snapshotPresent: true,
  };
}

// computeKpis: the page-name index reuses buildPageIndex, so link
// resolution matches check-links exactly.

/** Sort (key, count) entries by count desc, then key asc — the
 *  deterministic order — keeping the top N. */
function topCounts(
  counts: ReadonlyMap<string, number>,
  topN: number,
): { key: string; count: number }[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort(
      (a, b) =>
        b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, topN);
}

/** Sort bars by count desc, then label asc — the deterministic order. */
function sortedBars(counts: Map<string, number>): KpiBar[] {
  return topCounts(counts, Number.POSITIVE_INFINITY).map(({ key, count }) => ({
    label: key,
    count,
  }));
}

/** Count pages by a per-page label, as sorted bars. */
function countPagesBy(
  pages: readonly PageSnapshot[],
  labelOf: (page: PageSnapshot) => string,
): KpiBar[] {
  const counts = new Map<string, number>();

  for (const page of pages) {
    const label = labelOf(page);

    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return sortedBars(counts);
}

/** Count pages per frontmatter `type`. */
export function typeCounts(pages: readonly PageSnapshot[]): KpiBar[] {
  return countPagesBy(pages, (page) => page.type);
}

/** Count pages per frontmatter `status`; null becomes `unset`. */
export function statusCounts(pages: readonly PageSnapshot[]): KpiBar[] {
  return countPagesBy(pages, (page) => page.status ?? "unset");
}

/** The Monday of the week containing `date`, `YYYY-MM-DD`. */
function mondayOf(date: Date): string {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const shift = (day.getUTCDay() + 6) % 7;

  day.setUTCDate(day.getUTCDate() - shift);

  return day.toISOString().slice(0, 10);
}

/** The trailing `weeks` Monday-start weeks ending with now's week. */
function trailingWeeks(now: Date, weeks: number): string[] {
  const last = mondayOf(now);

  return Array.from({ length: weeks }, (_, i) => {
    const monday = new Date(`${last}T00:00:00.000Z`);

    monday.setUTCDate(monday.getUTCDate() - (weeks - 1 - i) * 7);

    return monday.toISOString().slice(0, 10);
  });
}

/** A commit is an ingest run when its subject says so. */
function isIngestRun(subject: string): boolean {
  return /^(wiki-sync|wiki-ingest)\b/.test(subject);
}

/** Commit facts per week, oldest first over the trailing weeks; only
 *  facts passing `keep` are counted. */
function factsPerWeek(
  facts: readonly CommitFact[],
  now: Date,
  keep: (fact: CommitFact) => boolean,
  weeks: number,
): WeekPoint[] {
  const index = new Map(trailingWeeks(now, weeks).map((week) => [week, 0]));

  for (const fact of facts) {
    if (!keep(fact)) {
      continue;
    }

    const monday = mondayOf(new Date(`${fact.date}T00:00:00.000Z`));

    if (index.has(monday)) {
      index.set(monday, (index.get(monday) ?? 0) + 1);
    }
  }

  return [...index.entries()].map(([week, count]) => ({ week, count }));
}

/** Ingest runs per week over the trailing twelve weeks, oldest first. */
export function runsPerWeek(
  commits: readonly CommitFact[],
  now: Date,
  weeks = 12,
): WeekPoint[] {
  return factsPerWeek(commits, now, (fact) => isIngestRun(fact.subject), weeks);
}

/** Mean sources per ingest run over commits that report a count. */
export function sourcesPerRun(commits: readonly CommitFact[]): number | null {
  const counts = commits
    .filter((commit) => isIngestRun(commit.subject))
    .map((commit) => /(\d+) sources? processed/.exec(commit.subject)?.[1])
    .filter((count): count is string => count !== undefined)
    .map(Number);

  if (counts.length === 0) {
    return null;
  }

  return counts.reduce((total, count) => total + count, 0) / counts.length;
}

/** Cumulative pages added, sampled at each of the trailing weeks. */
export function growthSeries(
  additions: readonly AdditionFact[],
  now: Date,
  weeks = 12,
): WeekPoint[] {
  const weekStarts = trailingWeeks(now, weeks);

  return weekStarts.map((week) => {
    const end = new Date(`${week}T00:00:00.000Z`);

    end.setUTCDate(end.getUTCDate() + 6);

    const through = end.toISOString().slice(0, 10);

    return {
      week,
      count: additions.filter((addition) => addition.date <= through).length,
    };
  });
}

/** Pages by source count: 0, 1, 2–3, 4+. */
export function provenanceBuckets(pages: readonly PageSnapshot[]): {
  zero: number;
  single: number;
  twoThree: number;
  fourPlus: number;
} {
  const buckets = { zero: 0, single: 0, twoThree: 0, fourPlus: 0 };

  for (const page of pages) {
    if (page.sourcesCount === 0) {
      buckets.zero++;
    } else if (page.sourcesCount === 1) {
      buckets.single++;
    } else if (page.sourcesCount <= 3) {
      buckets.twoThree++;
    } else {
      buckets.fourPlus++;
    }
  }

  return buckets;
}

/** The query funnel: filed count plus the last run, when known. */
export function funnelFrom(
  pages: readonly PageSnapshot[],
  lastQuery: string | null,
): { present: boolean; filedCount: number; lastRunAt: string | null } {
  return {
    present: lastQuery !== null,
    filedCount: pages.filter((page) => page.type === "query").length,
    lastRunAt: lastQuery,
  };
}

/** Raw notes by time since their content last changed (the manifest
 *  rewrites `last_synced` only when the hash changes): ≤ 30 days
 *  fresh, 31–90 aging, > 90 stale. */
export function sourceRotBuckets(
  syncDates: readonly { key: string; lastSynced: string }[],
  now: Date,
): { fresh: number; aging: number; stale: number } {
  const buckets = { fresh: 0, aging: 0, stale: 0 };

  for (const note of syncDates) {
    const age = ageInDays(note.lastSynced.slice(0, 10), now);

    if (!Number.isFinite(age)) {
      continue;
    }

    if (age <= 30) {
      buckets.fresh++;
    } else if (age <= 90) {
      buckets.aging++;
    } else {
      buckets.stale++;
    }
  }

  return buckets;
}

/** Raw notes ranked by how many pages cite them (a `sources`
 *  in-degree; contamination blast radius, issue #79). */
export function mostCitedSources(
  pages: readonly PageSnapshot[],
  topN = 5,
): { entry: string; citedBy: number }[] {
  const counts = new Map<string, number>();

  for (const page of pages) {
    for (const entry of page.sources) {
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
  }

  return topCounts(counts, topN).map(({ key, count }) => ({
    entry: key,
    citedBy: count,
  }));
}

/** The dead-link targets most wanted: how many links point at each
 *  missing page. */
function missingPages(
  deadLinks: readonly { source: string; target: string }[],
): { target: string; wantedBy: number }[] {
  const counts = new Map<string, number>();

  for (const link of deadLinks) {
    counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
  }

  return topCounts(counts, 5).map(({ key, count }) => ({
    target: key,
    wantedBy: count,
  }));
}

/** Mean days between ingest runs; null without at least two. */
export function ingestCadence(commits: readonly CommitFact[]): number | null {
  const dates = commits
    .filter((commit) => isIngestRun(commit.subject))
    .map((commit) => Date.parse(`${commit.date}T00:00:00.000Z`))
    .filter((ms) => Number.isFinite(ms));

  if (dates.length < 2) {
    return null;
  }

  const gaps = dates.slice(1).map((ms, i) => Math.abs(ms - (dates[i] ?? ms)));

  return gaps.reduce((total, gap) => total + gap, 0) / gaps.length / 86_400_000;
}

/** Status-flip commits per week (both directions of the flip —
 *  `git log -G` matches any change to a matching line), oldest
 *  first over the trailing twelve weeks. */
export function needsReviewChurn(
  statusFlips: readonly CommitFact[],
  now: Date,
  weeks = 12,
): WeekPoint[] {
  return factsPerWeek(statusFlips, now, () => true, weeks);
}

/** Every KPI the dashboard renders, from one input. */
export interface DashboardKpis {
  readonly totalPages: number;
  readonly backlog: {
    readonly count: number;
    readonly rawTotal: number;
    readonly snapshotPresent: boolean;
  };
  readonly typeCounts: readonly KpiBar[];
  readonly staleness: StalenessBuckets;
  readonly syncLagDays: number | null;
  readonly orphans: readonly string[];
  readonly deadLinks: readonly { source: string; target: string }[];
  readonly hubs: readonly { path: string; inbound: number }[];
  readonly statusCounts: readonly KpiBar[];
  /** Dead-link targets ranked by demand; the next pages to write. */
  readonly missingPages: readonly { target: string; wantedBy: number }[];
  /** Raw notes by content age: fresh ≤ 30d, aging 31–90d, stale > 90d. */
  readonly sourceRot: { fresh: number; aging: number; stale: number };
  /** Most-cited `sources` entries (contamination blast radius). */
  readonly mostCited: readonly { entry: string; citedBy: number }[];
  /** Mean days between ingest runs; null without at least two. */
  readonly cadenceDays: number | null;
  /** `status: needs-review` flips per week, oldest first. */
  readonly needsReviewChurn: readonly WeekPoint[];
  readonly runsPerWeek: readonly WeekPoint[];
  readonly sourcesPerRun: number | null;
  readonly growth: readonly WeekPoint[];
  readonly provenance: {
    readonly zero: number;
    readonly single: number;
    readonly twoThree: number;
    readonly fourPlus: number;
  };
  readonly funnel: {
    readonly present: boolean;
    readonly filedCount: number;
    readonly lastRunAt: string | null;
  };
}

/** The wiki's navigation root: linked structurally (the file list,
 *  the mirror's landing page), never by [[wikilinks]] — an orphan
 *  signal on it is noise, so it is exempt (issue #73 review). */
const NAVIGATION_ROOT = "index.md";

/** Compute every KPI from one input (issue #73's KPI menu). */
export function computeKpis(input: DashboardInput): DashboardKpis {
  const nameToPath = buildPageIndex(input.pages.map((page) => page.path));
  const inbound = new Map<string, number>(
    input.pages.map((page) => [page.path, 0] as const),
  );
  const deadLinks: { source: string; target: string }[] = [];

  for (const page of input.pages) {
    for (const target of page.outbound) {
      if (crossWikiTarget(target) !== undefined) {
        continue;
      }

      const resolved = nameToPath.get(target);

      if (resolved === undefined) {
        deadLinks.push({ source: page.path, target });

        continue;
      }

      inbound.set(resolved, (inbound.get(resolved) ?? 0) + 1);
    }
  }

  const syncLagDays =
    input.lastSync === null
      ? null
      : Math.floor(ageInDays(input.lastSync.slice(0, 10), input.now));

  return {
    totalPages: input.pages.length,
    backlog: backlogFrom(input.rawNoteKeys, input.ingestedKeys),
    typeCounts: typeCounts(input.pages),
    staleness: stalenessBuckets(input.pages, input.now),
    syncLagDays:
      syncLagDays !== null && Number.isFinite(syncLagDays) ? syncLagDays : null,
    orphans: input.pages
      .filter(
        (page) =>
          page.path !== NAVIGATION_ROOT && (inbound.get(page.path) ?? 0) === 0,
      )
      .map((page) => page.path)
      .sort(),
    deadLinks,
    hubs: input.pages
      .map((page) => ({
        path: page.path,
        inbound: inbound.get(page.path) ?? 0,
      }))
      .filter((hub) => hub.inbound > 0)
      .sort(
        (a, b) =>
          b.inbound - a.inbound ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      )
      .slice(0, 5),
    statusCounts: statusCounts(input.pages),
    missingPages: missingPages(deadLinks),
    sourceRot: sourceRotBuckets(input.rawNoteSyncDates, input.now),
    mostCited: mostCitedSources(input.pages),
    cadenceDays: ingestCadence(input.commits),
    needsReviewChurn: needsReviewChurn(input.statusFlips, input.now),
    runsPerWeek: runsPerWeek(input.commits, input.now),
    sourcesPerRun: sourcesPerRun(input.commits),
    growth: growthSeries(input.firstAdded, input.now),
    provenance: provenanceBuckets(input.pages),
    funnel: funnelFrom(input.pages, input.lastQuery),
  };
}
