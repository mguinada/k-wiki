import type { DashboardKpis, KpiBar, WeekPoint } from "./kpis.ts";

/**
 * The dashboard template (issue #73): one self-contained HTML page —
 * inline CSS, inline SVG bars, one toggle script — that opens offline
 * via file://. Design: editorial instrument panel on the reference
 * grayscale palette with #FF5E35 as the single accent. The chrome
 * stays quiet; the KPIs are the content.
 */

/** The reference palette (grayscale ramp) plus the accent. */
const PALETTE = {
  black: "#000000",
  ink: "#595859",
  mid: "#8c8c8c",
  mist: "#d7d7d9",
  paper: "#f0f0f2",
  white: "#ffffff",
  accent: "#FF5E35",
} as const;

export interface DashboardMeta {
  /** When the dashboard was generated. */
  readonly generatedAt: Date;
  /** Data-repo HEAD short sha. */
  readonly head: string;
  /** The data repo the KPIs were read from (display only). */
  readonly dataRoot: string;
}

/** Escape text for HTML body content and attribute values. */
function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** One horizontal bar row: label, count, and an SVG bar. */
function barRow(
  label: string,
  count: number,
  max: number,
  options: { accent?: boolean } = {},
): string {
  const width = max === 0 ? 0 : Math.max(2, Math.round((count / max) * 100));
  const fill = options.accent === true ? "var(--accent)" : "var(--bar)";

  return (
    `<tr class="bar-row"><th scope="row">${esc(label)}</th>` +
    `<td class="bar-count">${count}</td>` +
    `<td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" ` +
    `role="img" aria-label="${esc(label)}: ${count}"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/>` +
    `<rect x="0" y="1" width="${width}" height="6" rx="3" fill="${fill}"/></svg></td></tr>`
  );
}

/** A whole bar table from KpiBars; the accent flag picks one row. */
function barTable(
  bars: readonly KpiBar[],
  options: { accentLabel?: string } = {},
): string {
  const max = bars.reduce((top, bar) => Math.max(top, bar.count), 0);

  return `<table class="bars"><tbody>${bars
    .map((bar) =>
      barRow(bar.label, bar.count, max, {
        accent: bar.label === options.accentLabel,
      }),
    )
    .join("")}</tbody></table>`;
}

/** A vertical sparkline of weekly counts as inline SVG columns. */
function sparkline(points: readonly WeekPoint[]): string {
  const max = points.reduce((top, point) => Math.max(top, point.count), 0);
  const n = points.length;
  const barWidth = 100 / (n * 1.6);
  const gap = barWidth * 0.6;

  const rects = points
    .map((point, i) => {
      const height = max === 0 ? 0 : Math.max(2, (point.count / max) * 76);
      const x = (i * (barWidth + gap) + gap / 2).toFixed(2);

      return `<rect x="${x}" y="${(80 - height).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" rx="1.5"><title>${esc(point.week)}: ${point.count}</title></rect>`;
    })
    .join("");

  const labels = [
    `<text x="2" y="95" class="spark-label">${esc(points[0]?.week ?? "")}</text>`,
    `<text x="98" y="95" text-anchor="end" class="spark-label">${esc(points[n - 1]?.week ?? "")}</text>`,
  ].join("");

  return `<svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity">${rects}${labels}</svg>`;
}

/** The glossary affordance: a circled i that reveals its tip on
 *  hover or keyboard focus — pure CSS, no script. */
function infoTip(tip: string): string {
  return `<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">${esc(tip)}</span></span>`;
}

/** The stat card: one number, one label, optional accent and tip. */
function stat(value: string, label: string, accent = false, tip = ""): string {
  const cls = accent ? "stat stat-accent" : "stat";

  return `<div class="${cls}"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}${tip === "" ? "" : infoTip(tip)}</span></div>`;
}

/** A card title with an optional glossary tip. */
function cardTitle(title: string, tip = ""): string {
  return `<h3>${esc(title)}${tip === "" ? "" : infoTip(tip)}</h3>`;
}

function section(id: string, title: string, body: string, note = ""): string {
  return `<section id="${id}"><h2>${esc(title)}</h2>${body}${note === "" ? "" : `<p class="note">${esc(note)}</p>`}</section>`;
}

/** The full page. Pure: KPIs in, HTML string out. */
export function renderDashboard(
  kpis: DashboardKpis,
  meta: DashboardMeta,
): string {
  const generated = meta.generatedAt.toISOString();
  const stamp = `generated ${generated.slice(0, 10)} ${generated.slice(11, 16)} UTC from ${esc(meta.head === "" ? "no git history" : meta.head)}`;

  const coverage = section(
    "coverage",
    "Coverage & freshness",
    `${stat(String(kpis.totalPages), "wiki pages", false, "Every content page under wiki/ (AGENTS.md and its meta template excluded).")}` +
      `${stat(String(kpis.backlog.count), "un-ingested sources", kpis.backlog.count > 0, "Raw notes present in raw/ but absent from the last ingest snapshot — waiting for the next wiki-ingest run.")}` +
      `${stat(kpis.syncLagDays === null ? "—" : `${kpis.syncLagDays}d`, "since last sync", false, "Days since the newest last_synced stamp in raw/manifest.json — how far the projection trails the vault.")}` +
      `<div class="card wide">${cardTitle("Pages by type", "Frontmatter type of each page: source (one per raw note), concept, entity, comparison, query, topic.")}${barTable(kpis.typeCounts)}</div>` +
      `<div class="card wide">${cardTitle("Staleness — pages by age since update", "Days since each page's frontmatter updated date. > 90 days (accent) means the page has not been touched in a quarter.")}` +
      barTable(
        [
          { label: "≤ 7 days", count: kpis.staleness.fresh },
          { label: "8–30 days", count: kpis.staleness.month },
          { label: "31–90 days", count: kpis.staleness.quarter },
          { label: "> 90 days", count: kpis.staleness.stale },
          { label: "undated", count: kpis.staleness.undated },
        ],
        { accentLabel: "> 90 days" },
      ) +
      `</div>` +
      `<div class="card wide">${cardTitle("Source rot — raw notes by content age", "Days since each raw note's content last changed (manifest last_synced; a note re-syncs only when its hash changes). > 90 days is decaying source material.")}` +
      barTable(
        [
          { label: "≤ 30 days", count: kpis.sourceRot.fresh },
          { label: "31–90 days", count: kpis.sourceRot.aging },
          { label: "> 90 days", count: kpis.sourceRot.stale },
        ],
        { accentLabel: "> 90 days" },
      ) +
      `</div>`,
    kpis.backlog.snapshotPresent
      ? `${kpis.backlog.rawTotal} raw notes total; backlog = raw notes absent from the last ingest snapshot.`
      : `${kpis.backlog.rawTotal} raw notes total; no ingest snapshot found, so every note counts as un-ingested.`,
  );

  const orphansList =
    kpis.orphans.length === 0
      ? `<p class="note">no orphans — every page is linked</p>`
      : `<ul class="ticks">${kpis.orphans
          .slice(0, 12)
          .map((path) => `<li>${esc(path)}</li>`)
          .join("")}</ul>` +
        (kpis.orphans.length > 12
          ? `<p class="note">+ ${kpis.orphans.length - 12} more</p>`
          : "");

  const deadList =
    kpis.deadLinks.length === 0
      ? `<p class="note">no dead links</p>`
      : `<ul class="ticks">${kpis.deadLinks
          .slice(0, 12)
          .map((link) => `<li>${esc(link.source)} → ${esc(link.target)}</li>`)
          .join("")}</ul>`;

  const missingList =
    kpis.missingPages.length === 0
      ? `<p class="note">no missing pages — every link resolves</p>`
      : `<ul class="ticks">${kpis.missingPages
          .map(
            (page) =>
              `<li>${esc(page.target)} <span class="count">× ${page.wantedBy}</span></li>`,
          )
          .join("")}</ul>`;

  const structure = section(
    "structure",
    "Structure quality",
    `${stat(String(kpis.orphans.length), "orphan pages", kpis.orphans.length > 0, "Pages no other page links to (the navigation root index.md is exempt). Candidates for integration or deletion.")}` +
      `${stat(String(kpis.deadLinks.length), "dead links", kpis.deadLinks.length > 0, "[[wikilinks]] that resolve to no page — internal only; cross-wiki targets are validated by check-crosslinks.")}` +
      `${stat(kpis.hubs[0] ? String(kpis.hubs[0].inbound) : "0", "top in-degree", false, "Inbound links of the most-linked page — the wiki's gravitational center.")}` +
      `<div class="card">${cardTitle("Status", "Frontmatter status of each page: ingested, stable, filed, needs-review (accent). needs-review is unresolved review debt.")}${barTable(kpis.statusCounts, { accentLabel: "needs-review" })}</div>` +
      `<div class="card">${cardTitle("Hubs — most linked pages", "Top five pages by inbound [[wikilinks]].")}<ul class="ticks">${kpis.hubs
        .map(
          (hub) =>
            `<li>${esc(hub.path)} <span class="count">${hub.inbound}</span></li>`,
        )
        .join("")}</ul></div>` +
      `<div class="card">${cardTitle("Missing pages — most wanted", "Dead-link targets ranked by how many pages cite them: the next pages to write, by demand.")}${missingList}</div>` +
      `<div class="card">${cardTitle("needs-review flips per week", "Commits that changed a status: needs-review line (either direction) — review-debt churn; steady zeros mean a stable review queue.")}${sparkline(kpis.needsReviewChurn)}</div>` +
      `<div class="card wide"><div class="cols"><div>${cardTitle("Orphans")}${orphansList}</div><div>${cardTitle("Dead links")}${deadList}</div></div></div>`,
  );

  const avgSources =
    kpis.sourcesPerRun === null ? "—" : kpis.sourcesPerRun.toFixed(1);

  const activity = section(
    "activity",
    "Activity",
    `<div class="card wide">${cardTitle("Ingest runs per week", "Commits whose subject starts wiki-sync or wiki-ingest, bucketed by the Monday of their week.")}${sparkline(kpis.runsPerWeek)}</div>` +
      `${stat(avgSources, "sources per run (avg)", false, "Mean N sources processed across pipeline commits — how much raw material a typical run digests.")}` +
      `${stat(kpis.cadenceDays === null ? "—" : kpis.cadenceDays.toFixed(1), "days between runs", false, "Mean gap between consecutive ingest commits — the pipeline heartbeat.")}` +
      `${stat(String(kpis.growth[kpis.growth.length - 1]?.count ?? 0), "pages added, cumulative", false, "Total pages ever added (git first-appearance), sampled weekly.")}` +
      `<div class="card wide">${cardTitle("Wiki growth — cumulative pages")}${sparkline(kpis.growth)}</div>`,
  );

  const funnel =
    kpis.funnel.present === false
      ? ""
      : section(
          "funnel",
          "Query funnel",
          `${stat(String(kpis.funnel.filedCount), "queries filed")}` +
            `${stat(
              kpis.funnel.lastRunAt === null
                ? "—"
                : kpis.funnel.lastRunAt.slice(0, 10),
              "last query run",
            )}`,
        );

  const provenance = section(
    "provenance",
    "Provenance",
    `${stat(String(kpis.provenance.single), "single-source pages", kpis.provenance.single > 0, "Pages citing exactly one source (accent) — the unverified frontier: nothing cross-checks them.")}` +
      `${stat(String(kpis.provenance.fourPlus), "pages with 4+ sources")}` +
      `<div class="card wide">${cardTitle("Citation coverage — pages by source count", "How many sources each page cites: single-source pages are the weakest provenance.")}` +
      barTable(
        [
          { label: "0 sources", count: kpis.provenance.zero },
          { label: "1 source", count: kpis.provenance.single },
          { label: "2–3 sources", count: kpis.provenance.twoThree },
          { label: "4+ sources", count: kpis.provenance.fourPlus },
        ],
        { accentLabel: "1 source" },
      ) +
      `</div>` +
      `<div class="card wide">${cardTitle("Most-cited sources", "Raw notes ranked by how many pages cite them — over-reliance on one source widens contamination blast radius.")}<ul class="ticks">${kpis.mostCited
        .map(
          (source) =>
            `<li>${esc(source.entry)} <span class="count">${source.citedBy}</span></li>`,
        )
        .join("")}</ul></div>`,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>k-wiki dashboard</title>
<style>
:root {
  --black: ${PALETTE.black}; --ink: ${PALETTE.ink}; --mid: ${PALETTE.mid};
  --mist: ${PALETTE.mist}; --paper: ${PALETTE.paper}; --white: ${PALETTE.white};
  --accent: ${PALETTE.accent};
  --bg: var(--white); --fg: var(--black); --soft: var(--ink);
  --line: var(--mist); --card: var(--paper); --track: var(--mist); --bar: var(--ink);
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: var(--black); --fg: var(--white); --soft: var(--mist);
    --line: #2b2b2c; --card: #101010; --track: #262626; --bar: var(--mist);
  }
}
:root[data-theme="dark"] {
  --bg: var(--black); --fg: var(--white); --soft: var(--mist);
  --line: #2b2b2c; --card: #101010; --track: #262626; --bar: var(--mist);
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: var(--serif); font-size: 16px; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 920px; margin: 0 auto; padding: 4rem 1.5rem 5rem; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.15rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; margin: 0; }
h1 em { font-style: normal; color: var(--accent); }
.stamp { font-family: var(--mono); font-size: 0.7rem; color: var(--soft); }
main > section { margin-top: 3.5rem; }
h2 { font-size: 0.8rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--soft); border-bottom: 1px solid var(--line); padding-bottom: 0.5rem; }
h3 { font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--soft); margin: 0 0 0.75rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 1rem; margin-top: 1.25rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 1.25rem 1.25rem 1rem; margin-top: 1rem; }
.card.wide { grid-column: 1 / -1; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
.stat { display: flex; flex-direction: column; gap: 0.25rem; padding: 1rem 1.1rem; background: var(--card); border: 1px solid var(--line); border-radius: 6px; margin-top: 1.25rem; }
.stat-value { font-family: var(--mono); font-size: 1.9rem; line-height: 1.1; }
.stat-label { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--soft); }
.stat-accent .stat-value { color: var(--accent); }
table.bars { width: 100%; border-collapse: collapse; }
.bar-row th { text-align: left; font-weight: 400; font-size: 0.85rem; white-space: nowrap; padding: 0.3rem 0; }
.bar-count { font-family: var(--mono); font-size: 0.8rem; text-align: right; padding: 0.3rem 0.75rem; color: var(--soft); }
.bar-cell { width: 62%; }
.bar-cell svg { display: block; width: 100%; height: 8px; }
ul.ticks { list-style: none; margin: 0; padding: 0; font-family: var(--mono); font-size: 0.75rem; }
ul.ticks li { padding: 0.2rem 0; border-bottom: 1px dotted var(--line); }
ul.ticks li:last-child { border-bottom: none; }
.count { color: var(--soft); }
.note { font-size: 0.75rem; color: var(--soft); font-style: italic; }
.info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 0.95em; height: 0.95em; margin-left: 0.4em; border-radius: 50%; background: var(--mid); color: var(--bg); font-family: var(--mono); font-style: italic; font-size: 0.9em; line-height: 1; cursor: help; }
.info .tip { display: none; position: absolute; left: 50%; transform: translateX(-50%); bottom: 1.7em; width: 17em; max-width: 60vw; background: var(--fg); color: var(--bg); padding: 0.6em 0.75em; border-radius: 6px; font-family: var(--mono); font-style: normal; font-size: 0.68rem; line-height: 1.5; text-align: left; z-index: 5; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
.info:hover .tip, .info:focus-visible .tip { display: block; }
.info:focus-visible { outline: 2px solid var(--accent); }
.spark { display: block; width: 100%; max-height: 9rem; }
.spark rect { fill: var(--bar); }
.spark rect:last-of-type { fill: var(--accent); }
.spark-label { font-family: var(--mono); font-size: 6px; fill: var(--soft); }
#theme-toggle {
  font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase;
  background: none; border: 1px solid var(--line); color: var(--soft);
  border-radius: 999px; padding: 0.35rem 0.9rem; cursor: pointer;
}
#theme-toggle:hover { border-color: var(--accent); color: var(--accent); }
footer { margin-top: 4rem; border-top: 1px solid var(--line); padding-top: 1rem; font-family: var(--mono); font-size: 0.7rem; color: var(--soft); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
@media (max-width: 640px) { .cols { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>k-wiki <em>·</em> dashboard</h1>
<div><button id="theme-toggle" type="button" aria-label="Toggle color theme">theme</button></div>
</header>
<p class="stamp">${stamp}</p>
<main>
${coverage}
${structure}
${activity}
${funnel}
${provenance}
</main>
<footer><span>${esc(meta.dataRoot)}</span><span>${stamp}</span></footer>
</div>
<script>
(function () {
  var root = document.documentElement;
  var saved = null;

  try { saved = localStorage.getItem("dashboard-theme"); } catch (e) {}

  if (saved === "dark" || saved === "light") {
    root.setAttribute("data-theme", saved);
  }

  document.getElementById("theme-toggle").addEventListener("click", function () {
    var dark = root.getAttribute("data-theme") === "dark" ||
      (root.getAttribute("data-theme") === null &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);

    var next = dark ? "light" : "dark";

    root.setAttribute("data-theme", next);

    try { localStorage.setItem("dashboard-theme", next); } catch (e) {}
  });
})();
</script>
</body>
</html>
`;
}
