# Karpathy Wiki Instructions

## Mission

Maintain `wiki/` as a structured, high-quality knowledge base derived from
the source material in `raw/`.

The human-owned source vault is outside this repository and is authoritative.

## Ownership Rules

- NEVER modify the original Obsidian source vault.
- NEVER modify files under `raw/`.
- `raw/` is immutable input.
- You may create and modify files under `wiki/`.
- NEVER modify `wiki/AGENTS.md` — this contract is not editable during operations.
- `index.md` must remain current.
- `overview.md` must reflect the current synthesis.
- `log.md` is append-only.

## Source of Truth

Facts must ultimately be traceable to material in `raw/`.

Do not fabricate information.

A restated or derived claim carries the **original source's**
attribution, never a citation of an intermediate wiki page.
`sources` frontmatter lists only `type: source` pages, never
concept, entity, comparison, or query pages.

If a source is ambiguous, incomplete, or contradictory:
- state the uncertainty;
- preserve competing claims when appropriate;
- record the issue in `log.md`.

## Source Metadata

Source tags, filenames, folders, and frontmatter are hints, not authoritative
semantic information.

Infer meaning primarily from the actual source content.

When source metadata conflicts with source content, prefer the content.

The wiki may introduce canonical terminology, relationships, and categories
that do not exist in the source vault.

## Ingestion Workflow

For every new or changed source:

1. Read the source completely.
2. Identify concepts, entities, topics, comparisons, and relationships.
3. Find relevant existing wiki pages.
4. Create missing pages.
5. Update affected existing pages.
6. Add source attribution.
7. Add/update cross-links.
8. Update `index.md`.
9. Revise `overview.md` when the overall picture changes.
10. Append a concise entry to `log.md`.
11. Check for contradictions, duplicates, orphan pages, and unsupported claims.
12. Revisit any `status: needs-review` pages the new sources touch:
    corroborate → raise status and confidence; contradict → add or update
    a `CONTRADICTION` callout; unrelated → leave flagged.
13. Run `npm run check-links -- <wiki-dir>` from the code-repo checkout
    (the data repo does not ship the tool) and fix every broken
    `[[wikilink]]` it reports. In a second brain, also run
    `npm run check-crosslinks -- <wiki-dir> <domain-wiki-dir>
    [<domain-wiki-dir>…]` and fix every cross-wiki link it reports.

Create a new concept or entity page only when the term appears in more than
one source or is clearly central; avoid stub pages.

When two or more sources explicitly contrast named approaches, file a
comparison page (or extend an existing one).

Do not rewrite unrelated pages.

## Page Quality

Pages should be:
- concise;
- factual;
- structured;
- independently understandable;
- linked to related knowledge;
- explicit about uncertainty.

Avoid:
- unnecessary prose;
- duplicated information;
- unsupported claims;
- generic filler;
- summaries that add no value over the source.

Every page must link to at least two related pages.
Mark open questions with a `> **OPEN QUESTION**` callout and preserved
contradictions with a `> **CONTRADICTION**` callout.

### Confidence-min propagation

A wiki page's `confidence` may not exceed the lowest `confidence`
among the source pages its claims rest on. One low-confidence or
`needs-review` source caps the whole page at that level.

### Single-source corroboration lifecycle

A substantive claim page whose every claim rests on exactly one
source stays `status: needs-review` until a second independent
source corroborates it. When a later ingest adds a source touching
such a page, revisit it: corroborate → raise `status` and
`confidence`; contradict → add or update a `CONTRADICTION` callout;
unrelated → leave flagged.

## Naming

Use lowercase kebab-case filenames for concepts, comparisons, and queries.

Examples:

- `retrieval-augmented-generation.md`
- `vector-database.md`
- `rag-vs-fine-tuning.md`

Use stable, human-readable names for entities where appropriate.

## Obsidian Frontmatter

Every wiki page must use valid Obsidian-compatible YAML frontmatter.

Required fields:

- `title`
- `type`
- `created`
- `updated`
- `tags`

For pages derived from source material:

- `sources`
- `confidence`
- `status`

For source pages, where applicable:

- `source`
- `author`
- `published`
- `description`
- `origin`

`origin` records the raw projection path backing the source page
(`raw/notes/<vault>/<path>`), written at ingest time. Add it to any
source page that lacks it whenever the page is touched, and update it —
and any `sources` entry citing the old path — when its note is renamed;
it enables deterministic expungement.

Use ISO dates: `YYYY-MM-DD`.

Use Obsidian wikilinks for references to other notes.

Tags must use the canonical wiki vocabulary.

Do not put detailed knowledge, reasoning, evidence, or contradictions into frontmatter;
keep those in the Markdown body.

Do not modify source-vault metadata to make it conform to wiki metadata.

## Index

`wiki/index.md` is the navigation map of the wiki.

Update it whenever meaningful pages are created, renamed, or removed.

## Overview

`wiki/overview.md` is the short, evolving synthesis across all ingested material.

Revise it when new sources change the overall picture. Keep it brief; details
live on the individual pages.

## Log

`wiki/log.md` records meaningful ingestion operations.

Keep entries short and factual.

Start every entry with `## [YYYY-MM-DD] <operation> | <title>` so the log stays
parseable with standard tools.

## Queries

Answer questions against the wiki, not against `raw/` directly:

1. Read `index.md` to find relevant pages.
2. Read those pages; consult `overview.md` for broad questions.
3. Synthesize the answer with wikilink citations.
4. If the question is likely to recur and the answer synthesizes or
   reframes more than one page, offer to file it under `queries/` with
   `type: query` frontmatter, then update `index.md` and `log.md`.
   A verbatim restatement of a single page needs no filing. When
   borderline, offer and let the human decide — never silently skip;
   a declined filing states its reason.

In a second brain, read `wiki/second-brain/profile.md` before
answering and let it shape the answer: questions about the subject's
trajectory ("what did I try", "why did I choose") are answered from
the second-brain pages and the profile together, not from domain
pages alone.

If the wiki cannot answer a question, say so and suggest sources to ingest.

## Contradictions

Never silently resolve contradictory source material.

If sources disagree:
- preserve the disagreement;
- identify the relevant sources;
- explain the disagreement briefly;
- lower confidence when appropriate.

Mark each preserved contradiction in the page body with a
`> **CONTRADICTION**` callout.

## Regeneration

The wiki is derived data.

It must always be possible, in principle, to delete `wiki/` and regenerate it from
`raw/`.

Do not make the wiki depend on information that exists only in generated pages
unless that information is explicitly treated as a derived conclusion.

Exception: filed queries and human corrections form an accreted layer that
exists only in the wiki. Deleting `wiki/` loses that layer; git history is
its record. In a second brain the profile joins that layer.

Two files in `wiki/` are not derivable from `raw/`: this contract
(`wiki/AGENTS.md`) and `wiki/queries/`; a second brain adds a third,
`wiki/second-brain/profile.md`. A rebuild removes the wiki content
pages and preserves all of them.

Rebuild procedure:

1. Remove the wiki content pages: `index.md`, `overview.md`, `log.md`, and
   everything under `concepts/`, `entities/`, `sources/`, `comparisons/`,
   `queries/`, and — in a second brain — `second-brain/`. Keep
   `wiki/AGENTS.md`.
2. Run the rebuild prompt against `raw/`, following this contract.
3. Restore the accreted layer from git: `git restore wiki/queries/`, plus
   `wiki/second-brain/profile.md` in a second brain.
4. Spot-check the rebuilt pages against the pre-deletion versions
   (`git show HEAD:wiki/<path>`): same concepts covered, sources
   attributed, contradictions preserved. Wording may differ; LLM output
   is not byte-identical.

## Expungement

When a synced source note is deleted, the next run expunges its
influence: no claim, concept, entity, comparison, or filed query may
rest on material whose only support was the removed note, directly or
indirectly.

An expunge run may also carry added, edited, or renamed sources from
the same sync; they are ingested in the same run, never deferred.

For every affected page, re-derive it from its remaining sources — do
not surgically delete content:

- claims supported only by the removed note die;
- independently supported claims survive;
- confidence drops where support thinned;
- a `CONTRADICTION` callout that lost one side is dissolved, not
  preserved;
- a page left without sources, or demoted to a stub, is deleted.

Filed queries under `queries/` that cite the removed note are expunged
the same way; the layer itself is preserved.

Beyond the deterministic direct set (the removed note's source page,
every page citing it in `sources`, `index.md`, `overview.md`), search
the wiki full text for uncited mentions and follow `related` links and
body wikilinks in reverse.

Record the run in `log.md` as `## [YYYY-MM-DD] expunge | <title>`.

No tombstone pages: the wiki reflects the current `raw/`; the retraction
record lives in `log.md` and git history.

Threshold escape hatch: when the affected set exceeds roughly one third
of the wiki, execute the rebuild procedure instead of a surgical pass
(restore `queries/` from git afterwards, then expunge it) and say so in
the report.

Known residual risk: frontmatter tracing cannot prove the absence of
uncited influence. Mitigations: full-text search in the run, the
dead-provenance check, recurring lint, periodic rebuild.

## Residual Risk

The wiki is a closed-world system: it verifies consistency against
what it has already ingested, and closed-world consistency is not
truth. No mechanical check can prove a claim true.

The measures in this contract — confidence-min propagation,
no-derivative-citation, and the single-source corroboration lifecycle
— shrink the probability, spread rate, and detection latency of
bad-source contamination. They do not eliminate the risk.

Recovery from a confirmed bad source uses expungement (see above)
plus, if necessary, a full rebuild of `wiki/` from the current
`raw/`. Recovery is bounded and deterministic; prevention is not
perfect.

## Final Principle

Human knowledge lives in the source vault.

The LLM organizes and maintains the derived wiki.

Never reverse these responsibilities.

---

## Shared Invariants

- `raw/` is generated by sync; never hand-edit it.
- The source vault lives outside this repository; never touch it.

## Repository Split

The contents of `raw/` and `wiki/` are versioned by the data repository,
not the k-wiki code repository. The canonical copy of this contract lives
in the code repository; the copy that ships with the data repository is
derived.

## Multiple Source Vaults

This wiki currently has a single source vault. When multiple source
vaults are adopted, a human-approved change to this contract adds the
multi-vault rules here.

## Second Brains

A wiki whose source vault holds one subject's own material — project
notes, decisions, attempts, lessons, about a person, a career, or a
venture — is a **second brain**. It is a separate data repo with this
same contract; it is identified by the presence of
`wiki/second-brain/profile.md`.

### Profile layer

`wiki/second-brain/profile.md` is the memory of the subject the wiki
is about — a person, a career, a venture: current projects, goals,
communication style, standing preferences. It is the first file read
on every operation and the last considered when answering a question.

- Read it at the start of every ingestion and query.
- Update it when sources reveal a change: a new goal, a finished
  project, a revised preference. Keep the update small and dated.
- It is an accreted layer, not a derived page: it carries no `sources`
  and no `origin`, its frontmatter uses `type: profile`, and rebuilds
  preserve it.
- It states context, not certainty: mark stale entries as stale
  instead of deleting the history silently when the log already
  records the change.

### Second-brain page types

Second-brain material files under `wiki/second-brain/` with the same
rules as any derived page (`sources`, `origin`, confidence) and three
types:

- `project` — an ongoing effort: its goal, status, and the decisions
  and attempts that shaped it;
- `decision` — a choice made: the options considered, the rationale,
  and what later material says about the outcome;
- `attempt` — something tried: what was attempted, whether it worked,
  and the lesson to carry forward.

Use lowercase kebab-case names; anchor a page to its day when the day
matters (`attempt-fast-tests-2026-08-17.md`). A question such as "what
did I try that failed" is answered from these pages, not guessed.

### Cross-wiki links

A second brain may reference domain wikis, never the reverse:

- A wikilink target containing a `/` is a cross-wiki link —
  `[[<vault>/<page>]]` — where `<vault>` is a domain wiki's vault name
  (matched case-insensitively against that wiki's `raw/manifest.json`)
  and `<page>` a page of that wiki. Bare targets are internal;
  internal links never contain a slash. Several domain wikis may be
  linked from the same second brain.
- The link never resolves in this wiki; `check-crosslinks` validates
  it against the named domain wiki after every run.
- Domain wikis never reference second-brain material: they are link
  sinks — other wikis may point at them; they point at nothing. No
  page of any other wiki may link here, and this wiki's material
  never leaves this data repo.
- Only a second brain may use cross-wiki links; in any other wiki a
  slashed target is unresolvable and trips the ingest guardrails.
