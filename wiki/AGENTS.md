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
12. Run `npm run check-links -- <wiki-dir>` from the code-repo checkout
    (the data repo does not ship the tool) and fix every broken
    `[[wikilink]]` it reports.

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
its record.

Two files in `wiki/` are not derivable from `raw/`: this contract
(`wiki/AGENTS.md`) and `wiki/queries/`. A rebuild removes the wiki content
pages and preserves both.

Rebuild procedure:

1. Remove the wiki content pages: `index.md`, `overview.md`, `log.md`, and
   everything under `concepts/`, `entities/`, `sources/`, `comparisons/`,
   and `queries/`. Keep `wiki/AGENTS.md`.
2. Run the rebuild prompt against `raw/`, following this contract.
3. Restore the accreted layer from git: `git restore wiki/queries/`.
4. Spot-check the rebuilt pages against the pre-deletion versions
   (`git show HEAD:wiki/<path>`): same concepts covered, sources
   attributed, contradictions preserved. Wording may differ; LLM output
   is not byte-identical.

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
