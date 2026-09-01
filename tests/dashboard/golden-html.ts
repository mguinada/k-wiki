/**
 * Golden dashboard HTML (generated data — do not edit by hand).
 *
 * Byte-exact expected output of `renderDashboard` for the cases from
 * `render-cases.ts` (base, structure-heavy, sparse). The render test
 * fails on any byte the template changes; when a change is
 * deliberate, regenerate this module by rendering each golden case
 * and rewriting the three exported literals, then review the diff
 * like any template change.
 *
 * Stored as TS string literals rather than .html fixtures because
 * the Stryker sandbox pipes copied files through its TypeScript
 * prepender, which would corrupt plain-HTML goldens.
 */

/** Golden output for the base case. */
export const GOLDEN_BASE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>k-wiki dashboard</title>
<style>
:root {
  --black: #000000; --ink: #595859; --mid: #8c8c8c;
  --mist: #d7d7d9; --paper: #f0f0f2; --white: #ffffff;
  --accent: #FF5E35;
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
<p class="stamp">generated 2026-09-01 12:00 UTC from abee7c4</p>
<main>
<section id="coverage"><h2>Coverage &amp; freshness</h2><div class="stat"><span class="stat-value">4</span><span class="stat-label">wiki pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Every content page under wiki/ (AGENTS.md and its meta template excluded).</span></span></span></div><div class="stat stat-accent"><span class="stat-value">1</span><span class="stat-label">un-ingested sources<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Raw notes present in raw/ but absent from the last ingest snapshot — waiting for the next wiki-ingest run.</span></span></span></div><div class="stat"><span class="stat-value">2d</span><span class="stat-label">since last sync<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since the newest last_synced stamp in raw/manifest.json — how far the projection trails the vault.</span></span></span></div><div class="card wide"><h3>Pages by type<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Frontmatter type of each page: source (one per raw note), concept, entity, comparison, query, topic.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">concept</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="concept: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">query</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="query: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">source</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="source: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">topic</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="topic: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Staleness — pages by age since update<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since each page's frontmatter updated date. &gt; 90 days (accent) means the page has not been touched in a quarter.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">≤ 7 days</th><td class="bar-count">2</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="≤ 7 days: 2"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">8–30 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="8–30 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">31–90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="31–90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">&gt; 90 days</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="&gt; 90 days: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="50" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">undated</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="undated: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="50" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Source rot — raw notes by content age<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since each raw note's content last changed (manifest last_synced; a note re-syncs only when its hash changes). &gt; 90 days is decaying source material.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">≤ 30 days</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="≤ 30 days: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">31–90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="31–90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">&gt; 90 days</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="&gt; 90 days: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--accent)"/></svg></td></tr></tbody></table></div><p class="note">3 raw notes total; backlog = raw notes absent from the last ingest snapshot.</p></section>
<section id="structure"><h2>Structure quality</h2><div class="stat stat-accent"><span class="stat-value">2</span><span class="stat-label">orphan pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Pages no other page links to (the navigation root index.md is exempt). Candidates for integration or deletion.</span></span></span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">dead links<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">[[wikilinks]] that resolve to no page — internal only; cross-wiki targets are validated by check-crosslinks.</span></span></span></div><div class="stat"><span class="stat-value">1</span><span class="stat-label">top in-degree<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Inbound links of the most-linked page — the wiki's gravitational center.</span></span></span></div><div class="card"><h3>Status<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Frontmatter status of each page: ingested, stable, filed, needs-review (accent). needs-review is unresolved review debt.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">filed</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="filed: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">needs-review</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="needs-review: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">stable</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="stable: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">unset</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="unset: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card"><h3>Hubs — most linked pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Top five pages by inbound [[wikilinks]].</span></span></h3><ul class="ticks"><li>concepts/agent-evals.md <span class="count">1</span></li><li>overview.md <span class="count">1</span></li></ul></div><div class="card"><h3>Missing pages — most wanted<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Dead-link targets ranked by how many pages cite them: the next pages to write, by demand.</span></span></h3><p class="note">no missing pages — every link resolves</p></div><div class="card"><h3>needs-review flips per week<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Commits that changed a status: needs-review line (either direction) — review-debt churn; steady zeros mean a stable review queue.</span></span></h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="1.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-15: 0</title></rect><rect x="9.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-22: 0</title></rect><rect x="18.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-29: 0</title></rect><rect x="26.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-06: 0</title></rect><rect x="34.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-13: 0</title></rect><rect x="43.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-20: 0</title></rect><rect x="51.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-27: 0</title></rect><rect x="59.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-03: 0</title></rect><rect x="68.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-10: 0</title></rect><rect x="76.56" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-17: 1</title></rect><rect x="84.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-24: 0</title></rect><rect x="93.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-31: 0</title></rect><text x="2" y="95" class="spark-label">2026-06-15</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-31</text></svg></div><div class="card wide"><div class="cols"><div><h3>Orphans</h3><ul class="ticks"><li>queries/how-to-eval.md</li><li>sources/beginner-roadmap.md</li></ul></div><div><h3>Dead links</h3><p class="note">no dead links</p></div></div></div></section>
<section id="activity"><h2>Activity</h2><div class="card wide"><h3>Ingest runs per week<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Commits whose subject starts wiki-sync or wiki-ingest, bucketed by the Monday of their week.</span></span></h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="1.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-15: 0</title></rect><rect x="9.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-22: 0</title></rect><rect x="18.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-29: 0</title></rect><rect x="26.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-06: 0</title></rect><rect x="34.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-13: 0</title></rect><rect x="43.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-20: 0</title></rect><rect x="51.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-27: 0</title></rect><rect x="59.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-03: 0</title></rect><rect x="68.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-10: 0</title></rect><rect x="76.56" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-17: 1</title></rect><rect x="84.90" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-24: 1</title></rect><rect x="93.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-31: 0</title></rect><text x="2" y="95" class="spark-label">2026-06-15</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-31</text></svg></div><div class="stat"><span class="stat-value">4.5</span><span class="stat-label">sources per run (avg)<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Mean N sources processed across pipeline commits — how much raw material a typical run digests.</span></span></span></div><div class="stat"><span class="stat-value">5.0</span><span class="stat-label">days between runs<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Mean gap between consecutive ingest commits — the pipeline heartbeat.</span></span></span></div><div class="stat"><span class="stat-value">4</span><span class="stat-label">pages added, cumulative<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Total pages ever added (git first-appearance), sampled weekly.</span></span></span></div><div class="card wide"><h3>Wiki growth — cumulative pages</h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="1.56" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-06-15: 1</title></rect><rect x="9.90" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-06-22: 1</title></rect><rect x="18.23" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-06-29: 1</title></rect><rect x="26.56" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-06: 1</title></rect><rect x="34.90" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-13: 1</title></rect><rect x="43.23" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-20: 1</title></rect><rect x="51.56" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-27: 1</title></rect><rect x="59.90" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-08-03: 1</title></rect><rect x="68.23" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-08-10: 1</title></rect><rect x="76.56" y="42.00" width="5.21" height="38.00" rx="1.5"><title>2026-08-17: 2</title></rect><rect x="84.90" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-24: 4</title></rect><rect x="93.23" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-31: 4</title></rect><text x="2" y="95" class="spark-label">2026-06-15</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-31</text></svg></div></section>
<section id="funnel"><h2>Query funnel</h2><div class="stat"><span class="stat-value">1</span><span class="stat-label">queries filed</span></div><div class="stat"><span class="stat-value">2026-08-30</span><span class="stat-label">last query run</span></div></section>
<section id="provenance"><h2>Provenance</h2><div class="stat stat-accent"><span class="stat-value">1</span><span class="stat-label">single-source pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Pages citing exactly one source (accent) — the unverified frontier: nothing cross-checks them.</span></span></span></div><div class="stat"><span class="stat-value">1</span><span class="stat-label">pages with 4+ sources</span></div><div class="card wide"><h3>Citation coverage — pages by source count<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">How many sources each page cites: single-source pages are the weakest provenance.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">0 sources</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="0 sources: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">1 source</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="1 source: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">2–3 sources</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="2–3 sources: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">4+ sources</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="4+ sources: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Most-cited sources<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Raw notes ranked by how many pages cite them — over-reliance on one source widens contamination blast radius.</span></span></h3><ul class="ticks"><li>notes/Engineering/a.md <span class="count">2</span></li><li>[[agent-evals]] <span class="count">1</span></li><li>notes/Engineering/evals.md <span class="count">1</span></li></ul></div></section>
</main>
<footer><span>~/Lab/k-wiki-data</span><span>generated 2026-09-01 12:00 UTC from abee7c4</span></footer>
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

/** Golden output for the structure-heavy case. */
export const GOLDEN_STRUCTURE_HEAVY = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>k-wiki dashboard</title>
<style>
:root {
  --black: #000000; --ink: #595859; --mid: #8c8c8c;
  --mist: #d7d7d9; --paper: #f0f0f2; --white: #ffffff;
  --accent: #FF5E35;
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
<p class="stamp">generated 2026-09-01 12:00 UTC from abee7c4</p>
<main>
<section id="coverage"><h2>Coverage &amp; freshness</h2><div class="stat"><span class="stat-value">4</span><span class="stat-label">wiki pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Every content page under wiki/ (AGENTS.md and its meta template excluded).</span></span></span></div><div class="stat stat-accent"><span class="stat-value">1</span><span class="stat-label">un-ingested sources<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Raw notes present in raw/ but absent from the last ingest snapshot — waiting for the next wiki-ingest run.</span></span></span></div><div class="stat"><span class="stat-value">2d</span><span class="stat-label">since last sync<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since the newest last_synced stamp in raw/manifest.json — how far the projection trails the vault.</span></span></span></div><div class="card wide"><h3>Pages by type<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Frontmatter type of each page: source (one per raw note), concept, entity, comparison, query, topic.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">concept</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="concept: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">query</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="query: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">source</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="source: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">topic</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="topic: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Staleness — pages by age since update<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since each page's frontmatter updated date. &gt; 90 days (accent) means the page has not been touched in a quarter.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">≤ 7 days</th><td class="bar-count">2</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="≤ 7 days: 2"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">8–30 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="8–30 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">31–90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="31–90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">&gt; 90 days</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="&gt; 90 days: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="50" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">undated</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="undated: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="50" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Source rot — raw notes by content age<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since each raw note's content last changed (manifest last_synced; a note re-syncs only when its hash changes). &gt; 90 days is decaying source material.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">≤ 30 days</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="≤ 30 days: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">31–90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="31–90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">&gt; 90 days</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="&gt; 90 days: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--accent)"/></svg></td></tr></tbody></table></div><p class="note">3 raw notes total; backlog = raw notes absent from the last ingest snapshot.</p></section>
<section id="structure"><h2>Structure quality</h2><div class="stat stat-accent"><span class="stat-value">13</span><span class="stat-label">orphan pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Pages no other page links to (the navigation root index.md is exempt). Candidates for integration or deletion.</span></span></span></div><div class="stat stat-accent"><span class="stat-value">2</span><span class="stat-label">dead links<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">[[wikilinks]] that resolve to no page — internal only; cross-wiki targets are validated by check-crosslinks.</span></span></span></div><div class="stat"><span class="stat-value">1</span><span class="stat-label">top in-degree<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Inbound links of the most-linked page — the wiki's gravitational center.</span></span></span></div><div class="card"><h3>Status<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Frontmatter status of each page: ingested, stable, filed, needs-review (accent). needs-review is unresolved review debt.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">filed</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="filed: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">needs-review</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="needs-review: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">stable</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="stable: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">unset</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="unset: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card"><h3>Hubs — most linked pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Top five pages by inbound [[wikilinks]].</span></span></h3><ul class="ticks"><li>concepts/agent-evals.md <span class="count">1</span></li><li>overview.md <span class="count">1</span></li></ul></div><div class="card"><h3>Missing pages — most wanted<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Dead-link targets ranked by how many pages cite them: the next pages to write, by demand.</span></span></h3><ul class="ticks"><li>eval-harness <span class="count">× 3</span></li><li>metrics <span class="count">× 1</span></li></ul></div><div class="card"><h3>needs-review flips per week<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Commits that changed a status: needs-review line (either direction) — review-debt churn; steady zeros mean a stable review queue.</span></span></h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="1.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-15: 0</title></rect><rect x="9.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-22: 0</title></rect><rect x="18.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-29: 0</title></rect><rect x="26.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-06: 0</title></rect><rect x="34.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-13: 0</title></rect><rect x="43.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-20: 0</title></rect><rect x="51.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-27: 0</title></rect><rect x="59.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-03: 0</title></rect><rect x="68.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-10: 0</title></rect><rect x="76.56" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-17: 1</title></rect><rect x="84.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-24: 0</title></rect><rect x="93.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-31: 0</title></rect><text x="2" y="95" class="spark-label">2026-06-15</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-31</text></svg></div><div class="card wide"><div class="cols"><div><h3>Orphans</h3><ul class="ticks"><li>concepts/a&lt;b&gt;&amp;&quot;c.md</li><li>concepts/one.md</li><li>concepts/two.md</li><li>concepts/three.md</li><li>concepts/four.md</li><li>concepts/five.md</li><li>concepts/six.md</li><li>concepts/seven.md</li><li>concepts/eight.md</li><li>concepts/nine.md</li><li>concepts/ten.md</li><li>concepts/eleven.md</li></ul><p class="note">+ 1 more</p></div><div><h3>Dead links</h3><ul class="ticks"><li>concepts/agent-evals.md → missing-page</li><li>sources/a&amp;b&lt;c&gt;.md → T&quot;&amp;g</li></ul></div></div></div></section>
<section id="activity"><h2>Activity</h2><div class="card wide"><h3>Ingest runs per week<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Commits whose subject starts wiki-sync or wiki-ingest, bucketed by the Monday of their week.</span></span></h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="1.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-15: 0</title></rect><rect x="9.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-22: 0</title></rect><rect x="18.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-06-29: 0</title></rect><rect x="26.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-06: 0</title></rect><rect x="34.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-13: 0</title></rect><rect x="43.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-20: 0</title></rect><rect x="51.56" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-07-27: 0</title></rect><rect x="59.90" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-03: 0</title></rect><rect x="68.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-10: 0</title></rect><rect x="76.56" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-17: 1</title></rect><rect x="84.90" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-24: 1</title></rect><rect x="93.23" y="78.00" width="5.21" height="2.00" rx="1.5"><title>2026-08-31: 0</title></rect><text x="2" y="95" class="spark-label">2026-06-15</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-31</text></svg></div><div class="stat"><span class="stat-value">4.5</span><span class="stat-label">sources per run (avg)<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Mean N sources processed across pipeline commits — how much raw material a typical run digests.</span></span></span></div><div class="stat"><span class="stat-value">5.0</span><span class="stat-label">days between runs<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Mean gap between consecutive ingest commits — the pipeline heartbeat.</span></span></span></div><div class="stat"><span class="stat-value">4</span><span class="stat-label">pages added, cumulative<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Total pages ever added (git first-appearance), sampled weekly.</span></span></span></div><div class="card wide"><h3>Wiki growth — cumulative pages</h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="1.56" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-06-15: 1</title></rect><rect x="9.90" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-06-22: 1</title></rect><rect x="18.23" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-06-29: 1</title></rect><rect x="26.56" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-06: 1</title></rect><rect x="34.90" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-13: 1</title></rect><rect x="43.23" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-20: 1</title></rect><rect x="51.56" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-07-27: 1</title></rect><rect x="59.90" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-08-03: 1</title></rect><rect x="68.23" y="61.00" width="5.21" height="19.00" rx="1.5"><title>2026-08-10: 1</title></rect><rect x="76.56" y="42.00" width="5.21" height="38.00" rx="1.5"><title>2026-08-17: 2</title></rect><rect x="84.90" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-24: 4</title></rect><rect x="93.23" y="4.00" width="5.21" height="76.00" rx="1.5"><title>2026-08-31: 4</title></rect><text x="2" y="95" class="spark-label">2026-06-15</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-31</text></svg></div></section>
<section id="funnel"><h2>Query funnel</h2><div class="stat"><span class="stat-value">1</span><span class="stat-label">queries filed</span></div><div class="stat"><span class="stat-value">2026-08-30</span><span class="stat-label">last query run</span></div></section>
<section id="provenance"><h2>Provenance</h2><div class="stat stat-accent"><span class="stat-value">1</span><span class="stat-label">single-source pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Pages citing exactly one source (accent) — the unverified frontier: nothing cross-checks them.</span></span></span></div><div class="stat"><span class="stat-value">1</span><span class="stat-label">pages with 4+ sources</span></div><div class="card wide"><h3>Citation coverage — pages by source count<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">How many sources each page cites: single-source pages are the weakest provenance.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">0 sources</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="0 sources: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">1 source</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="1 source: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">2–3 sources</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="2–3 sources: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">4+ sources</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="4+ sources: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Most-cited sources<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Raw notes ranked by how many pages cite them — over-reliance on one source widens contamination blast radius.</span></span></h3><ul class="ticks"><li>notes/Engineering/a.md <span class="count">2</span></li><li>[[agent-evals]] <span class="count">1</span></li><li>notes/Engineering/evals.md <span class="count">1</span></li></ul></div></section>
</main>
<footer><span>~/Lab/k-wiki-data</span><span>generated 2026-09-01 12:00 UTC from abee7c4</span></footer>
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

/** Golden output for the sparse case. */
export const GOLDEN_SPARSE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>k-wiki dashboard</title>
<style>
:root {
  --black: #000000; --ink: #595859; --mid: #8c8c8c;
  --mist: #d7d7d9; --paper: #f0f0f2; --white: #ffffff;
  --accent: #FF5E35;
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
<p class="stamp">generated 2026-09-01 12:00 UTC from no git history</p>
<main>
<section id="coverage"><h2>Coverage &amp; freshness</h2><div class="stat"><span class="stat-value">0</span><span class="stat-label">wiki pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Every content page under wiki/ (AGENTS.md and its meta template excluded).</span></span></span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">un-ingested sources<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Raw notes present in raw/ but absent from the last ingest snapshot — waiting for the next wiki-ingest run.</span></span></span></div><div class="stat"><span class="stat-value">—</span><span class="stat-label">since last sync<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since the newest last_synced stamp in raw/manifest.json — how far the projection trails the vault.</span></span></span></div><div class="card wide"><h3>Pages by type<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Frontmatter type of each page: source (one per raw note), concept, entity, comparison, query, topic.</span></span></h3><table class="bars"><tbody></tbody></table></div><div class="card wide"><h3>Staleness — pages by age since update<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since each page's frontmatter updated date. &gt; 90 days (accent) means the page has not been touched in a quarter.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">≤ 7 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="≤ 7 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">8–30 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="8–30 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">31–90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="31–90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">&gt; 90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="&gt; 90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">undated</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="undated: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Source rot — raw notes by content age<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Days since each raw note's content last changed (manifest last_synced; a note re-syncs only when its hash changes). &gt; 90 days is decaying source material.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">≤ 30 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="≤ 30 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">31–90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="31–90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">&gt; 90 days</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="&gt; 90 days: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--accent)"/></svg></td></tr></tbody></table></div><p class="note">0 raw notes total; no ingest snapshot found, so every note counts as un-ingested.</p></section>
<section id="structure"><h2>Structure quality</h2><div class="stat"><span class="stat-value">0</span><span class="stat-label">orphan pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Pages no other page links to (the navigation root index.md is exempt). Candidates for integration or deletion.</span></span></span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">dead links<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">[[wikilinks]] that resolve to no page — internal only; cross-wiki targets are validated by check-crosslinks.</span></span></span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">top in-degree<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Inbound links of the most-linked page — the wiki's gravitational center.</span></span></span></div><div class="card"><h3>Status<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Frontmatter status of each page: ingested, stable, filed, needs-review (accent). needs-review is unresolved review debt.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">stable</th><td class="bar-count">100</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="stable: 100"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">filed</th><td class="bar-count">1</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="filed: 1"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="2" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card"><h3>Hubs — most linked pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Top five pages by inbound [[wikilinks]].</span></span></h3><ul class="ticks"></ul></div><div class="card"><h3>Missing pages — most wanted<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Dead-link targets ranked by how many pages cite them: the next pages to write, by demand.</span></span></h3><p class="note">no missing pages — every link resolves</p></div><div class="card"><h3>needs-review flips per week<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Commits that changed a status: needs-review line (either direction) — review-debt churn; steady zeros mean a stable review queue.</span></span></h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="9.38" y="78.00" width="31.25" height="2.00" rx="1.5"><title>2026-06-08: 1</title></rect><rect x="59.38" y="4.00" width="31.25" height="76.00" rx="1.5"><title>2026-08-24: 100</title></rect><text x="2" y="95" class="spark-label">2026-06-08</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-24</text></svg></div><div class="card wide"><div class="cols"><div><h3>Orphans</h3><p class="note">no orphans — every page is linked</p></div><div><h3>Dead links</h3><p class="note">no dead links</p></div></div></div></section>
<section id="activity"><h2>Activity</h2><div class="card wide"><h3>Ingest runs per week<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Commits whose subject starts wiki-sync or wiki-ingest, bucketed by the Monday of their week.</span></span></h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><rect x="9.38" y="80.00" width="31.25" height="0.00" rx="1.5"><title>2026-06-08: 0</title></rect><rect x="59.38" y="80.00" width="31.25" height="0.00" rx="1.5"><title>2026-08-24: 0</title></rect><text x="2" y="95" class="spark-label">2026-06-08</text><text x="98" y="95" text-anchor="end" class="spark-label">2026-08-24</text></svg></div><div class="stat"><span class="stat-value">—</span><span class="stat-label">sources per run (avg)<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Mean N sources processed across pipeline commits — how much raw material a typical run digests.</span></span></span></div><div class="stat"><span class="stat-value">—</span><span class="stat-label">days between runs<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Mean gap between consecutive ingest commits — the pipeline heartbeat.</span></span></span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">pages added, cumulative<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Total pages ever added (git first-appearance), sampled weekly.</span></span></span></div><div class="card wide"><h3>Wiki growth — cumulative pages</h3><svg viewBox="0 0 100 100" class="spark" role="img" aria-label="weekly activity"><text x="2" y="95" class="spark-label"></text><text x="98" y="95" text-anchor="end" class="spark-label"></text></svg></div></section>

<section id="provenance"><h2>Provenance</h2><div class="stat"><span class="stat-value">0</span><span class="stat-label">single-source pages<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Pages citing exactly one source (accent) — the unverified frontier: nothing cross-checks them.</span></span></span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">pages with 4+ sources</span></div><div class="card wide"><h3>Citation coverage — pages by source count<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">How many sources each page cites: single-source pages are the weakest provenance.</span></span></h3><table class="bars"><tbody><tr class="bar-row"><th scope="row">0 sources</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="0 sources: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">1 source</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="1 source: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--accent)"/></svg></td></tr><tr class="bar-row"><th scope="row">2–3 sources</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="2–3 sources: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr><tr class="bar-row"><th scope="row">4+ sources</th><td class="bar-count">0</td><td class="bar-cell"><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="4+ sources: 0"><rect x="0" y="1" width="100" height="6" rx="3" fill="var(--track)"/><rect x="0" y="1" width="0" height="6" rx="3" fill="var(--bar)"/></svg></td></tr></tbody></table></div><div class="card wide"><h3>Most-cited sources<span class="info" tabindex="0" aria-label="explanation">i<span class="tip">Raw notes ranked by how many pages cite them — over-reliance on one source widens contamination blast radius.</span></span></h3><ul class="ticks"></ul></div></section>
</main>
<footer><span></span><span>generated 2026-09-01 12:00 UTC from no git history</span></footer>
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
