# SQLite as a Future Evolution: Research and Ideation

Status: research record. Nothing here is decided or scheduled. This note
follows the guide §27 pattern: options, triggers, and the reasons to do
nothing today.

Date: 2026-08-26. Evidence: measurements against the live data repo
(177 raw notes, 170 wiki pages, 1,342 wikilinks, 42 KB manifest) and the
open issue list (#113, #124, #126, #73, #78, #76).

## 1. The question

Can SQLite make the pipeline faster, or improve any other part of the
operation — sync, ingest routing, checks, query, dashboard — as the wiki
grows?

## 2. Measured baseline: performance is not the problem

Every deterministic stage is a full walk today, and every full walk is
cheap at current scale. Measured on the live data repo (this machine,
Node 22.23.1):

| Operation | What it walks | Wall time |
|---|---|---|
| `check-links` | All wiki pages, all wikilinks | ~0.1 s |
| `check-fidelity` | All pages + origin files | ~0.2 s |
| `check-provenance` | All pages + raw tree | ~0.3 s |
| `health` | All raw notes, re-hashed (SHA-256) | ~0.4 s |

The pipeline's real cost is the LLM run: one ingest is minutes
(`--timeout 3600` is a documented case, #113). The deterministic layer
is three orders of magnitude cheaper than the agent run. A database
that speeds the deterministic layer by 10× saves nothing the operator
can feel.

Two further facts close the "faster sync" argument:

- Sync cost is SHA-256 over the bytes of every matched file. A database
  cannot avoid reading the bytes; content hashing is the correctness
  mechanism. The only possible speedup — an mtime/size cache that skips
  re-hashing — is unsafe under iCloud transport, where mtimes lie. The
  guide already chose correctness here (§26, "tolerate transport lag";
  idempotent manifests).
- The manifest is a designed review surface: sorted keys, JSON, small
  git diffs. Replacing it with a binary database removes the diff
  review property and gains milliseconds. That trade is negative.

**Conclusion: at current and 10× scale, SQLite solves no problem that
exists.** The interesting question is not speed. It is what SQLite can
add that the file tree cannot express well.

## 3. The invariant: materialized view, never system of record

Any SQLite artifact in this pipeline must hold exactly one role:

```
files are truth; the database is a disposable materialized view
```

Concretely, any `.db` in the pipeline:

- is derived from `raw/` + `wiki/` alone, and is regenerable from them
  at any time by a full rebuild;
- lives beside the other per-checkout derived state (gitignored, like
  `outputs/last-ingested-manifest.json`), never in git history;
- is never agent-writable (the guardrail whitelist stays
  markdown-only);
- is never a migration target for `raw/manifest.json`, `wiki/*.md`,
  `wiki/log.md`, or `outputs/runs/*.md` — those are the audit and
  review surfaces, and they stay text.

This is the same trust model as `wiki/` itself (§22: disposable,
derived). A database that fails this test — a cache whose drift from the
files cannot be detected, or a store the pipeline reads but cannot
rebuild — is rejected on architecture, not preference.

One corollary: a persisted cache introduced before its scale trigger
adds a new failure class (file-vs-db drift; the health check would need
to validate the cache too) with zero measurable win. The guide's own §27
discipline applies to databases the same as to every other option:
trigger first, build second.

## 4. Where SQLite genuinely fits (tiered, with triggers)

### 4.1 Retrieval substrate when the #78 gate fires — the strongest fit

Guide §20/§27 defer retrieval until ~100 sources plus quality
degradation. When that trigger fires, §27 names `qmd` (BM25 + vector +
rerank). There is a lighter first step: `node:sqlite` FTS5.

- **Zero new dependencies.** `node:sqlite` ships in Node ≥ 22.5; this
  repo requires ≥ 22.18. Verified on 22.23.1: `DatabaseSync` works,
  FTS5 is compiled in, SQLite 3.51.3. No server, no index process, no
  native module — consistent with a repo whose only runtime dependency
  is `picocolors`.
- **BM25 ranking over wiki + raw.** One FTS5 table over page titles,
  frontmatter, and bodies; `MATCH` with `bm25()` ranking gives the
  candidate set that `index.md` navigation gives today, but bounded by
  relevance instead of by index length.
- **It slots into #78's own design.** Signals 2–4 of the gate (ingest
  misses, "cannot answer" while a relevant page exists, `index.md`
  exceeding context budget) are all retrieval failures; FTS5
  pre-retrieval addresses exactly those. `wiki-query` gains a
  deterministic pre-step: match → top-k candidate pages → the agent
  reads a bounded, cited candidate set.
- **Vector search stays optional.** If semantic matching is later
  needed, `sqlite-vec` extends the same file; FTS5-first is the
  YAGNI-correct order, and `qmd` remains the escape hatch if
  reranking quality disappoints.

Sketch (trigger-fired, not built):

```
outputs/index.db          ← gitignored, disposable, full-rebuild-on-ingest
CREATE VIRTUAL TABLE pages USING fts5(path, title, body, frontmatter);
```

At 170 pages a full rebuild is a sub-second walk — no incremental
invalidation machinery, ever, until a measured need appears.

### 4.2 Deterministic expunge seed (§14a phase 1)

Today expungement's phase-1 full-text search — "find pages that use the
removed note's distinctive terms" — is agent judgment. The seed that is
deterministic covers only frontmatter (`origin`, `sources`). FTS5 makes
the full-text half deterministic too: the removed note's distinctive
terms become a `MATCH` query, and the hits join the seed set. Same
index as 4.1 — one artifact, two consumers, both disposable.

### 4.3 Coverage probes (#113-class recovery, hardening)

The missing-concepts incident (#113) showed the cost of a file-tree
question that has no cheap file-tree answer: "which concepts do ≥ 2 raw
sources name, but no page covers?" With FTS5 over both trees, that
becomes one deterministic query (term frequency in raw bodies vs page
existence). This does not replace the agent's judgment about what
deserves a page; it gives the lint digest a mechanical "unfiled
multi-source concept" list to check the agent against — the same
form/guardrail philosophy as confidence-min propagation (§22).

### 4.4 Dashboard compute (#73) — maybe

The dashboard issue forbids new persisted state; an ephemeral,
regenerated database complies (it is disposable by 4.1's rule). SQL
`GROUP BY` over a links table is arguably simpler than hand-rolled
aggregation for the graph-shaped KPIs (orphans, in-degree hubs,
source-count distributions). But ~10 KPIs over 170 pages is also fine
as pure functions. Decision: build the dashboard with pure functions;
switch to SQL only if the KPI code grows joins the function layer
cannot express cleanly. The load step would be shared with 4.1 either
way.

### 4.5 Link-graph store at scale — later

Five tools re-walk the wiki per cycle (sync diff, ingest seed, lint,
checks, dashboard). At 170 pages this is irrelevant. At thousands of
pages, or when second-brain federation (#96 domains) multiplies walks
across wikis, a persistent link-graph with content-hash-keyed
invalidation could pay. Trigger: cycle wall time becomes
walk-dominated, not agent-dominated. Until then, per-run in-memory
rebuild is the simpler correct thing.

## 5. Where SQLite must not go

| Candidate | Verdict | Reason |
|---|---|---|
| Replace `raw/manifest.json` | No | Git-diff review is a designed property; JSON+sorted keys is the review surface (§8, §19) |
| Store the wiki (`wiki/*.md` → DB) | No | The wiki is an Obsidian vault, human-readable, disposable-derived — the core premise (§22) |
| Store `wiki/log.md`, digests | No | Append-only audit artifacts; text is the contract |
| Sync-state cache (mtime skip) | No | Unsafe under iCloud mtime lies; correctness already chosen over speed (§26) |
| Early retrieval index now | No | §20/#78 trigger not fired; premature cache adds drift risk with no win |
| Multi-wiki instance catalog | No | Config files + `--raw-dir` identity suffice (#124); speculative |

## 6. Risk notes on `node:sqlite`

- It prints an `ExperimentalWarning` on 22.x. The surface this design
  uses (`DatabaseSync`, prepared statements, FTS5) has been stable in
  the API since 22.5, and the usage is small. If a future Node release
  breaks it, `better-sqlite3` is the fallback — at the cost of a native
  dependency, which is why FTS5-via-stdlib is tried first.
- `DatabaseSync` is synchronous. At this pipeline's scale that is a
  feature (single-threaded CLI, sub-second operations); it would be a
  defect only in a server, which this project deliberately is not
  (#73 chose static, read-only, local).

## 7. Recommendation

1. **Do nothing now.** No schema, no index, no dependency. Record this
   note as the §27-style entry point.
2. **When #78's gate fires**, build 4.1 (FTS5 index, disposable,
   gitignored, full-rebuild) as the retrieval substrate, and fold in
   4.2 (expunge seed) from the same artifact.
3. **Consider 4.3** with the next #113-class incident; it needs no
   infrastructure beyond 4.1.
4. Re-read §3 before any first commit that introduces a `.db` file: if
   it cannot be deleted and rebuilt from the file trees in one command,
   the design is wrong.
