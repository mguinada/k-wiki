# Karpathy-Style Wiki from an Obsidian Vault

A concise implementation guide for building an LLM-maintained wiki as a **derived Obsidian vault**, while keeping the original vault human-owned and self-managed.

[TOC]

## 0. Target Architecture

```text
MyVault/                         MyWiki/
Human source                    Derived machine knowledge
    │
    │ deterministic sync
    ▼
                                raw/        ← immutable source projection
                                  │
                                  │ LLM ingest
                                  ▼
                                wiki/       ← LLM-owned knowledge
                                  ├── index.md
                                  ├── log.md
                                  ├── concepts/
                                  ├── entities/
                                  ├── sources/
                                  └── comparisons/
```

**Core rule:** `MyVault` is the source of truth. `MyWiki` is disposable derived data.

This does **not** violate the Karpathy-style wiki principles. It strengthens source immutability, provenance, separation of human/LLM ownership, and reproducibility.

---

# 1. Create Two Separate Vaults

Example:

```text
~/Obsidian/MyVault/
~/Obsidian/MyWiki/
```

Open both as separate Obsidian vaults.

Recommended ownership:

| Area | Owner | LLM writes? |
|---|---|---:|
| `MyVault/` | Human | No |
| `MyWiki/raw/` | Sync process | No |
| `MyWiki/wiki/` | LLM | Yes |
| `MyWiki/index.md` | LLM | Yes |
| `MyWiki/log.md` | LLM | Append-only |
| `MyWiki/CLAUDE.md` | Human | Preferably no |

---

# 2. Decide Which Source Notes Enter the Wiki

Recommended: use frontmatter.

```yaml
---
wiki: true
---
```

Only notes with `wiki: true` are synchronized.

Example:

```markdown
---
wiki: true
---

# Retrieval-Augmented Generation

My notes about RAG...
```

Private/scratch notes simply omit the field or use:

```yaml
---
wiki: false
---
```

Do not synchronize sensitive/private material unless you explicitly intend to.

---

# 4. Handle an Inconsistent Source Vault

Your source vault does **not** need perfectly consistent tags, filenames, links, or frontmatter before you build the wiki.

Treat source metadata as **hints**, not authoritative semantic information. The actual note content is the stronger signal.

### Impact of source-vault messiness

| Problem | Likely wiki impact |
|---|---|
| Inconsistent/missing tags | Low–medium |
| Inconsistent frontmatter | Low–medium |
| Poor filenames | Low–medium |
| Duplicate/overlapping notes | High |
| Contradictory notes | High |
| Notes with little context | High |
| Missing links | Medium–high |
| Highly fragmented notes | Medium–high |

The main risk is not messy tags. It is **ambiguous, duplicated, contradictory, or context-poor knowledge**.

## Do not clean the source vault first

Do **not** make a global LLM rewrite of `MyVault/` the first step.

That would allow the LLM to modify your source of truth and would mix two different concerns:

```text
Source vault organization
        vs.
Knowledge extraction
```

Keep the source vault human-owned.

Instead, let the wiki understand the source vault as it is.

### Metadata normalization as derived data

If the vault's metadata eventually proves problematic, add a derived normalization layer:

```text
MyVault/
    │
    │ deterministic sync
    ▼
MyWiki/raw/
    │
    │ LLM analysis
    ▼
MyWiki/normalized/
    │
    │ LLM ingest
    ▼
MyWiki/wiki/
```

`normalized/` must also be derived data. Never use it to overwrite `MyVault/` automatically.

A normalization pass can propose:

- canonical tags;
- canonical topics;
- page types;
- related notes;
- possible duplicates;
- possible contradictions;
- source-quality assessments.

Prefer **proposals first**, rather than automatically changing the source vault.

Example:

```yaml
---
canonical_topic: retrieval-augmented-generation
suggested_tags:
  - llm
  - information-retrieval
  - embeddings
suggested_type: concept
related_notes:
  - embeddings.md
  - vector-databases.md
possible_duplicates:
  - retrieval.md
confidence: high
---
```

This lets you review the proposed organization without risking your source of truth.

## Add these rules to `AGENTS.md`

```text
## Source Metadata

Source tags, filenames, folders, and frontmatter are hints, not authoritative
semantic information.

Infer meaning primarily from the actual source content.

When source metadata conflicts with source content, prefer the content.

Do not modify source metadata.

The wiki may introduce canonical terminology, relationships, and categories
that do not exist in the source vault.

Do not force the source vault to conform to the wiki taxonomy.
```

## Recommended approach

Start with:

```text
MyVault → raw → LLM ingest → wiki
```

Do not add `normalized/` until you have evidence that source-vault organization is materially hurting ingestion quality.

The wiki should **understand your source vault rather than require your source vault to conform to the wiki**.

# 4. Create the Wiki Structure

```text
MyWiki/
├── raw/
│   └── notes/
│
├── wiki/
│   ├── index.md
│   ├── log.md
│   ├── concepts/
│   ├── entities/
│   ├── sources/
│   └── comparisons/
│
├── outputs/
│
├── CLAUDE.md
└── .git/
```

The exact taxonomy can evolve. Start small.

---

# 5. Make `raw/` Immutable

The synchronization pipeline is:

```text
MyVault → MyWiki/raw → MyWiki/wiki
```

Never:

```text
LLM → MyVault
LLM → raw/
```

`raw/` is the verification baseline. It should contain the latest synchronized representation of source notes, but the LLM must not edit it.

The original vault remains completely untouched by the wiki agent.

---

# 6. Automate Synchronization

Keep synchronization deterministic. Do **not** use an LLM to decide what changed.

Recommended flow:

```text
Scheduled job
    ↓
Scan MyVault
    ↓
Find wiki:true notes
    ↓
Compare hashes
    ↓
Copy new/changed notes → MyWiki/raw/
    ↓
Detect deleted notes
    ↓
Trigger LLM ingest for changed sources
    ↓
Run lint
    ↓
Git commit
```

On macOS, `launchd` plus a small Python/Ruby script is a good implementation.

Track hashes in something such as:

```text
MyWiki/raw/manifest.json
```

Example:

```json
{
  "AI/RAG.md": {
    "hash": "abc123",
    "last_synced": "2026-08-16T15:00:00Z"
  }
}
```

Keep **sync** and **ingest** as separate commands:

```text
sync-vault
    MyVault → raw/

wiki-ingest
    raw/ → wiki/

wiki-sync
    sync → ingest → lint → git commit
```

This separation is important.

---

# 7. Define the Wiki Schema and Obsidian Frontmatter

The wiki is an Obsidian vault, so use **Obsidian-compatible YAML frontmatter** rather than inventing a separate metadata format.

Start with these page types:

- `concept`
- `entity`
- `source`
- `comparison`
- `topic`

## Required wiki frontmatter

Every wiki page should use:

```yaml
---
title: "Retrieval-Augmented Generation"
type: concept

created: 2026-08-16
updated: 2026-08-16

tags:
  - "llm"
  - "retrieval"
  - "rag"

sources:
  - "[[RAG Notes]]"

related:
  - "[[embeddings]]"
  - "[[vector-database]]"

confidence: high
status: active

description: "A technique that augments LLM generation with retrieved external information."
---
```

Use ISO dates (`YYYY-MM-DD`) and Obsidian wikilinks for references to other notes.

### Source pages

A page representing an external source can use:

```yaml
---
title: "GPU Memory Math for LLMs (2026 Edition)"
type: source

source: "https://x.com/TheAhmadOsman/status/2040103488714068245"
author:
  - "[[@TheAhmadOsman]]"
published: 2026-04-03

created: 2026-08-16
updated: 2026-08-16

description: "How model weights, quantization, KV cache, and runtime overhead contribute to LLM memory requirements."

tags:
  - "llm"
  - "gpu"
  - "memory"

confidence: high
status: active
---
```

### Derived concept pages

Use `sources` (plural) because a wiki page may synthesize multiple sources:

```yaml
---
title: "LLM GPU Memory"
type: concept

sources:
  - "[[GPU Memory Math for LLMs (2026 Edition)]]"
  - "[[LLM Quantization]]"

created: 2026-08-16
updated: 2026-08-16

description: "How model weights, quantization, KV cache, activations, and runtime overhead contribute to LLM memory requirements."

tags:
  - "llm"
  - "gpu"
  - "memory"
  - "inference"

related:
  - "[[quantization]]"
  - "[[kv-cache]]"

confidence: high
status: active
---
```

### Tags

The source vault's tags are **not authoritative**. The wiki should use a controlled, canonical vocabulary.

For example, these source tags:

```text
#AI
#ai
#ArtificialIntelligence
#LLM
#llms
#large-language-models
```

can become:

```yaml
tags:
  - "ai"
  - "llm"
```

The LLM may normalize terminology in the **derived wiki**, but must never modify the source vault merely to make it conform to the wiki taxonomy.

### Do not put everything in frontmatter

Frontmatter is the metadata/indexing layer, not the knowledge itself.

Put these in the Markdown body:

- explanations;
- evidence;
- contradictions;
- caveats;
- alternative interpretations;
- detailed relationships;
- derived conclusions.

### Recommended metadata rules

1. Every substantive claim should be traceable to source material.
2. Never invent facts to fill gaps.
3. Preserve contradictions instead of silently choosing one.
4. Link related wiki pages.
5. Prefer updating existing pages over creating duplicates.
6. Keep pages concise and information-dense.
7. Record uncertainty explicitly.
8. Use canonical wiki tags rather than copying inconsistent source tags.
9. Use `sources` for provenance; use `source` for a source page's external origin.
10. Use `status: needs-review` when important information is uncertain or contradictory.

---

# 8. `CLAUDE.md`

Use this as the starting system/instruction file for the wiki agent.

```markdown
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
- `index.md` must remain current.
- `log.md` is append-only.

## Source of Truth

Facts must ultimately be traceable to material in `raw/`.

Do not fabricate information.

If a source is ambiguous, incomplete, or contradictory:
- state the uncertainty;
- preserve competing claims when appropriate;
- record the issue in `log.md`.

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
9. Append a concise entry to `log.md`.
10. Check for contradictions, duplicates, orphan pages, and unsupported claims.

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

## Naming

Use lowercase kebab-case filenames for concepts and comparisons.

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

## Log

`wiki/log.md` records meaningful ingestion operations.

Keep entries short and factual.

## Contradictions

Never silently resolve contradictory source material.

If sources disagree:
- preserve the disagreement;
- identify the relevant sources;
- explain the disagreement briefly;
- lower confidence when appropriate.

## Regeneration

The wiki is derived data.

It must always be possible, in principle, to delete `wiki/` and regenerate it from
`raw/`.

Do not make the wiki depend on information that exists only in generated pages
unless that information is explicitly treated as a derived conclusion.

## Final Principle

Human knowledge lives in the source vault.

The LLM organizes and maintains the derived wiki.

Never reverse these responsibilities.
```

---

# 9. Initial `index.md`

```markdown
# Wiki Index

## Concepts

<!-- Add concept pages here -->

## Entities

<!-- Add entity pages here -->

## Sources

<!-- Add source pages here -->

## Comparisons

<!-- Add comparison pages here -->
```

The agent should maintain this.

---

# 10. Initial `log.md`

```markdown
# Wiki Log

```

Keep it append-only.

Example entry:

```markdown
## 2026-08-16

### Ingest

Source: `raw/notes/AI/RAG.md`

Created:
- `concepts/retrieval-augmented-generation.md`

Updated:
- `concepts/vector-database.md`
- `concepts/embeddings.md`

Detected:
- No contradictions.
```

---

# 11. Ingestion Prompt

Use this as the core prompt when processing changed sources:

```text
You are maintaining a structured knowledge wiki.

Read the changed source files under raw/ and update wiki/ accordingly.

Follow CLAUDE.md exactly.

For each changed source:

1. Understand the complete source.
2. Identify concepts, entities, topics, comparisons, and relationships.
3. Inspect the existing wiki before creating pages.
4. Update existing pages when appropriate.
5. Create new pages only when justified.
6. Add source attribution to every affected page.
7. Add appropriate wikilinks.
8. Preserve contradictions and uncertainty.
9. Do not invent facts.
10. Update index.md.
11. Append a concise operation summary to log.md.

Do not modify raw/.
Do not modify the original source vault.
Do not rewrite unrelated wiki pages.

At the end, report:
- sources processed;
- pages created;
- pages updated;
- contradictions detected;
- unresolved questions.
```

---

# 12. Incremental Update Prompt

For an existing wiki when one or more notes changed:

```text
Process only the source files changed since the previous ingestion.

First inspect the existing wiki pages related to those sources.

Determine whether the changes require:
- new pages;
- updates;
- relationship/link changes;
- removal of obsolete claims;
- contradiction handling.

Make the smallest set of changes necessary.

Do not regenerate unrelated pages.

Update index.md and log.md.
```

---

# 13. Full/Rebuild Prompt

Use when rebuilding the wiki from scratch:

```text
Rebuild the knowledge wiki from all material under raw/.

Follow CLAUDE.md.

Process sources in logical batches.

Build:
- concepts;
- entities;
- sources;
- comparisons;
- relationships;
- index.md;
- log.md.

Avoid duplicate pages.

Every substantive claim must be traceable to source material.

Preserve uncertainty and contradictions.

Do not modify raw/.

The resulting wiki must be understandable without reading every raw source.
```

---

# 14. Lint Prompt

Run after ingestion:

```text
Audit the wiki for quality problems.

Check for:

1. Unsupported claims.
2. Missing source attribution.
3. Contradictory claims.
4. Duplicate pages.
5. Orphan pages.
6. Broken wikilinks.
7. Missing or invalid Obsidian frontmatter.
8. Missing required frontmatter fields.
9. Non-canonical or inconsistent wiki tags.
10. Stale or obsolete claims.
11. Incorrect page types.
12. Missing important relationships.
13. Index entries missing from the wiki.
14. Wiki pages that contain excessive filler.

Do not make speculative corrections.

Fix clear mechanical problems automatically.
Report ambiguous problems instead of guessing.

Append significant findings to log.md.
```

---

# 15. Recommended Automation

Eventually make one command perform:

```text
wiki-sync
   │
   ├── 1. Synchronize MyVault → raw/
   │
   ├── 2. Determine changed/deleted sources
   │
   ├── 3. Run incremental ingest
   │
   ├── 4. Run lint
   │
   ├── 5. Git diff
   │
   └── 6. Commit changes
```

Suggested schedule:

- hourly if the vault changes frequently;
- every 6 hours for normal use;
- daily if the wiki is mostly reference material.

Start manually until the pipeline is reliable, then schedule it.

---

# 16. Git

Initialize Git inside `MyWiki`.

Recommended workflow:

```bash
git status
git diff
git add wiki/
git commit -m "Update wiki"
```

Automation can commit successful ingestion runs.

Git gives you:
- history;
- auditability;
- rollback;
- visibility into LLM changes.

Never put secrets or private source material into a remote repository unless you explicitly intend to.

---

# 17. Retrieval

Do **not** start with a vector database.

Start with:

```text
Markdown
+
index.md
+
wikilinks
+
LLM
```

Only introduce semantic/hybrid retrieval when the wiki becomes large enough that normal navigation and context loading are insufficient.

QMD or another hybrid BM25/vector/reranking solution can be added later.

---

# 18. Source Quality

During ingestion, the LLM should distinguish **content quality** from **metadata quality**.

A note can have excellent technical information while having poor tags or structure. Conversely, a beautifully tagged note can contain vague or unreliable information.

Optionally record derived source-quality information such as:

```yaml
source_quality:
  completeness: high
  context: medium
  coherence: low
  duplication_risk: medium
```

Use this to influence confidence, contradiction handling, and review priorities.

Do not let poor metadata alone reduce the confidence of otherwise well-supported content.

# 18. Important Design Principles

### Human source is authoritative

```text
MyVault = truth
MyWiki = derived representation
```

### The wiki is disposable

You should theoretically be able to:

```text
delete wiki/
→ ingest raw/
→ recreate wiki/
```

### Raw data is immutable

```text
raw/ = evidence
wiki/ = interpretation/organization
```

### Sync is deterministic

The sync mechanism should not require an LLM.

### Ingest is intelligent

The LLM decides how source material changes the knowledge structure.

### Preserve provenance

Claims should point back to source files.

### Preserve contradictions

Do not force false consistency.

### Minimize unnecessary changes

Only update pages affected by new/changed information.

---

# 19. Recommended First Implementation

Do not implement the whole system at once.

Build this vertical slice first:

```text
1. Select one source note.
2. Mark it wiki:true.
3. Sync it to raw/.
4. Run the ingestion prompt.
5. Create one or more wiki pages with valid Obsidian frontmatter.
6. Add source attribution and canonical tags.
7. Update index.md.
8. Update log.md.
9. Run lint, including frontmatter/tag validation.
10. Inspect git diff.
```

Then test:

```text
Change source note
      ↓
sync
      ↓
ingest
      ↓
existing wiki page updated
      ↓
new relationship created
      ↓
index/log updated
```

Only after this works reliably should you automate the schedule.

---

# 20. Final Architecture

The complete system should eventually look like:

```text
                         HUMAN
                           │
                           ▼
                  ┌─────────────────┐
                  │    MyVault      │
                  │                 │
                  │ source of truth │
                  └────────┬────────┘
                           │
                     deterministic
                         sync
                           │
                           ▼
                  ┌─────────────────┐
                  │  MyWiki/raw/    │
                  │                 │
                  │ immutable input │
                  └────────┬────────┘
                           │
                         ingest
                           │
                           ▼
                  ┌─────────────────┐
                  │  MyWiki/wiki/   │
                  │                 │
                  │ LLM-maintained  │
                  │ knowledge base  │
                  └────────┬────────┘
                           │
                     lint / query
                           │
                           ▼
                          LLM
```

## Bottom line

Your two requirements are compatible with the Karpathy-style wiki:

1. **Keep the original Obsidian vault separate and human-owned.**
2. **Periodically synchronize selected notes into an immutable `raw/` layer.**
3. **Let the LLM maintain only the derived `wiki/` layer.**
4. **Automate synchronization deterministically.**
5. **Use Git for rollback and auditability.**
6. **Start with Markdown and links; add semantic retrieval only when needed.**
7. **Make the wiki reproducible from the source material.**

The most important invariant is:

```text
Human → source vault
Sync → raw
LLM → wiki
```

Never let that direction reverse.



# References

- [Original Post by Andrej Karpathy on the LLM Wiki Patterns](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 
- [How to Build Karpathy's LLM Wiki: The Complete Guide to AI-Maintained Knowledge Bases](https://blog.starmorph.com/blog/karpathy-llm-wiki-knowledge-base-guide)

- [Andrej Karpathy’s LLM Wiki: Full Breakdown and How to Build Your Own](https://nandigamharikrishna.substack.com/p/andrej-karpathys-llm-wiki-full-breakdown)
