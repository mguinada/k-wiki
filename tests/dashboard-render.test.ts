import { describe, expect, it } from "vitest";
import { computeKpis, type DashboardInput } from "../src/dashboard/kpis.ts";
import { renderDashboard } from "../src/dashboard/render.ts";

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
        outbound: ["overview"],
      },
      {
        path: "sources/beginner-roadmap.md",
        title: "Beginner roadmap",
        type: "source",
        updated: "2026-05-01",
        status: "needs-review",
        sourcesCount: 1,
        outbound: [],
      },
      {
        path: "queries/how-to-eval.md",
        title: "How to eval",
        type: "query",
        updated: "2026-08-30",
        status: "filed",
        sourcesCount: 2,
        outbound: [],
      },
      {
        path: "overview.md",
        title: "Overview",
        type: "topic",
        updated: null,
        status: null,
        sourcesCount: 0,
        outbound: ["agent-evals"],
      },
    ],
    rawNoteKeys: ["Engineering/a.md", "Engineering/b.md", "Engineering/c.md"],
    ingestedKeys: ["Engineering/a.md", "Engineering/b.md"],
    lastSync: "2026-08-30T00:00:00.000Z",
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
  it("emits a complete HTML document", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("references no external resource", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:|file:|\/\/)/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("stamps the generation timestamp and data-repo HEAD", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("2026-09-01");
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
    expect(html).toContain("localStorage");
  });

  it("renders KPI values from the fixture data", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("1"); // backlog
    expect(html).toContain("needs-review");
    expect(html).toContain("concepts/agent-evals.md");
  });

  it("renders SVG bars, not images or scripts, for the charts", () => {
    const html = renderDashboard(fixtureKpis(), {
      generatedAt: NOW,
      head: "abee7c4",
      dataRoot: "~/Lab/k-wiki-data",
    });

    expect(html).toContain("<svg");
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
    expect(html).not.toContain("a<b>&c.md");
  });
});
