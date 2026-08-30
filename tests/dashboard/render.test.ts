import { describe, expect, it } from "vitest";
import { computeKpis, type DashboardInput } from "../../src/dashboard/kpis.ts";
import { renderDashboard } from "../../src/dashboard/render.ts";

/**
 * The renderer's contract (issue #73): one self-contained HTML file —
 * inline CSS, inline SVG, near-zero JS, dark and light themes from the
 * reference palette with the #FF5E35 accent — that opens offline via
 * file://. Everything is asserted against fixture KPIs.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** A small, fully populated KPI set for rendering assertions. */
function fixtureKpis() {
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

describe("renderDashboard", () => {
  it("starts the document with a DOCTYPE", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("ends the document with a closing html tag", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("references no external resource", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:|file:|\/\/)/i);
  });

  it("links no external stylesheet", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).not.toMatch(/<link\b/i);
  });

  it("imports no external css", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).not.toMatch(/@import/i);
  });

  it("stamps the generation date", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("2026-09-01");
  });

  it("stamps the data-repo HEAD", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("abee7c4");
  });

  it("uses every reference palette color as a CSS variable", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    for (const hex of [
      "#000000",
      "#595859",
      "#8c8c8c",
      "#d7d7d9",
      "#f0f0f2",
      "#ffffff",
      "#ff5e35",
    ]) {
      expect(html.toLowerCase()).toContain(hex);
    }
  });

  it("follows the system color scheme by default", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("prefers-color-scheme");
  });

  it("carries a visible theme toggle that overrides the preference", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toMatch(/<button[^>]*id="theme-toggle"/);
  });

  it("overrides the preference through localStorage", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("localStorage");
  });

  it("renders KPI values from the fixture data", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain(
      '<span class="stat-value">1</span><span class="stat-label">un-ingested sources',
    );
  });

  it("marks KPIs that need review", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("needs-review");
  });

  it("lists the orphan page path", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("concepts/agent-evals.md");
  });

  it("renders SVG bars, not images or scripts, for the charts", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("<svg");
  });

  it("renders no chart images", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).not.toMatch(/<img\b/i);
  });

  it("hides the query funnel when no last-query artifact exists", () => {
    const kpis = fixtureKpis();

    const html = renderDashboard(
      {
        ...kpis,
        funnel: { ...kpis.funnel, present: false, lastRunAt: null },
      },
      { generatedAt: NOW, head: "abee7c4", dataRoot: "~/Lab/k-wiki-data" },
    );

    expect(html).not.toContain("Query funnel");
  });

  it("shows the query funnel when the last-query artifact exists", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("Query funnel");
  });

  it("escapes HTML metacharacters in page paths and titles", () => {
    const kpis = fixtureKpis();
    const poisoned = {
      ...kpis,
      orphans: ["concepts/a<b>&c.md"],
    };

    const html = renderDashboard(poisoned, {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("a&lt;b&gt;&amp;c.md");
  });

  it("emits no unescaped orphan path", () => {
    const kpis = fixtureKpis();
    const poisoned = {
      ...kpis,
      orphans: ["concepts/a<b>&c.md"],
    };

    const html = renderDashboard(poisoned, {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).not.toContain("a<b>&c.md");
  });

  it("lists dead links as source-to-target pairs when any exist", () => {
    const kpis = fixtureKpis();
    const withDeadLinks = {
      ...kpis,
      deadLinks: [
        { source: "concepts/agent-evals.md", target: "missing-page" },
      ],
    };

    const html = renderDashboard(withDeadLinks, {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("concepts/agent-evals.md → missing-page");
  });

  it("escapes HTML metacharacters in dead-link pairs", () => {
    const kpis = fixtureKpis();
    const poisoned = {
      ...kpis,
      deadLinks: [{ source: "concepts/a<b>&c.md", target: "T&g" }],
    };

    const html = renderDashboard(poisoned, {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("a&lt;b&gt;&amp;c.md → T&amp;g");
  });
});

describe("renderDashboard glossary and added KPIs", () => {
  it("renders an info icon with a CSS-only hover popup next to KPI titles", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain('class="info"');
  });

  it("renders the tip popup next to the icon", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain('class="tip"');
  });

  it("shows the tip on hover", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain(".info:hover .tip");
  });

  it("shows the tip on keyboard focus", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain(".info:focus-visible .tip");
  });

  it("carries a concise explanation for every glossary tip", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    const tips = [...html.matchAll(/<span class="tip">([^<]+)<\/span>/g)];

    expect(tips.length).toBeGreaterThanOrEqual(8);
  });

  it("explains every glossary tip", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    const tips = [...html.matchAll(/<span class="tip">([^<]+)<\/span>/g)];

    for (const tip of tips) {
      expect((tip[1] ?? "").length).toBeGreaterThan(10);
    }
  });

  it("renders the missing-pages card with wanted-by counts", () => {
    const kpis = fixtureKpis();
    const html = renderDashboard(
      { ...kpis, missingPages: [{ target: "eval-harness", wantedBy: 3 }] },
      { generatedAt: NOW, head: "abee7c4", dataRoot: "~/Lab/k-wiki-data" },
    );

    expect(html).toContain("Missing pages");
  });

  it("lists the missing page target", () => {
    const kpis = fixtureKpis();
    const html = renderDashboard(
      { ...kpis, missingPages: [{ target: "eval-harness", wantedBy: 3 }] },
      { generatedAt: NOW, head: "abee7c4", dataRoot: "~/Lab/k-wiki-data" },
    );

    expect(html).toContain("eval-harness");
  });

  it("renders the source-rot buckets", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("Source rot");
  });

  it("renders the 31–90-day source-rot bucket", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("31–90 days");
  });

  it("renders the most-cited sources card", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("Most-cited");
  });

  it("lists the most-cited source path", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("notes/Engineering/evals.md");
  });

  it("renders the ingest cadence stat", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("days between runs");
  });

  it("renders the needs-review churn sparkline", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("needs-review flips");
  });
});

describe("renderDashboard funnel section and stamp details", () => {
  it("stamps the generation date and wall-clock time as day and HH:MM UTC", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("generated 2026-09-01 12:00 UTC from abee7c4");
  });

  it("says 'no git history' in the stamp when HEAD is empty", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("from no git history");
  });

  it("leaves no content between the activity and provenance sections when no query run exists", () => {
    const kpis = fixtureKpis();

    const html = renderDashboard(
      {
        ...kpis,
        funnel: { ...kpis.funnel, present: false, lastRunAt: null },
      },
      { generatedAt: NOW, head: "abee7c4", dataRoot: "~/Lab/k-wiki-data" },
    );

    expect(html).toContain('</section>\n\n<section id="provenance"');
  });

  it("gives the query funnel section its funnel id when a run exists", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain('<section id="funnel">');
  });

  it("renders the filed-query count stat with its label", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain(
      '<span class="stat-value">1</span><span class="stat-label">queries filed',
    );
  });

  it("renders an em dash for the last query run when the run timestamp is absent", () => {
    const kpis = fixtureKpis();

    const html = renderDashboard(
      {
        ...kpis,
        funnel: { present: true, filedCount: 1, lastRunAt: null },
      },
      { generatedAt: NOW, head: "abee7c4", dataRoot: "~/Lab/k-wiki-data" },
    );

    expect(html).toContain(
      '<span class="stat-value">—</span><span class="stat-label">last query run',
    );
  });

  it("truncates the last query run timestamp to its day", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain(
      '<span class="stat-value">2026-08-30</span><span class="stat-label">last query run',
    );
  });
});
