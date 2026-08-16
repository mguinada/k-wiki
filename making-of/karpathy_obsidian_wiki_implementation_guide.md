# Karpathy-Style Wiki from an Obsidian Vault

A concise implementation guide for building an LLM-maintained wiki as a **derived Obsidian vault**, while keeping the original vault human-owned and self-managed. The default path is the simplest one — one vault, one wiki; Section 1 helps you decide whether you need more.

[TOC]

## 0. Target Architecture

```text
MyVault/                         k-wiki/
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

**Core rule:** `MyVault` is the source of truth. `k-wiki` is disposable derived data.

This does **not** violate the Karpathy-style wiki principles. It strengthens source immutability, provenance, separation of human/LLM ownership, and reproducibility.

---

## 1. Choosing Your Topology

The default path through this guide is the simplest topology: **one vault → one wiki**. Every other topology is an extension of it, decided at a single seam — the deterministic sync layer (Section 7). Everything downstream (`raw/` → ingest → `wiki/`) is topology-agnostic.

| Situation | Topology | Reading path |
|---|---|---|
| One vault, one knowledge domain | 1 vault → 1 wiki | Sections 2–22 as written (default) |
| Several vaults, overlapping domains, cross-vault synthesis is the point | N vaults → 1 wiki | Simple path + Scenario A deltas (Section 23) |
| Several vaults, disjoint domains, different audiences or privacy levels | N vaults → N wikis | One independent instance of the simple path each (Scenario B, Section 23) |
| One vault, mixed public/private material | 1 vault → N wikis | Same selection mechanism, inverted (Scenario C, Section 23) |

Rules of thumb:

- When in doubt, start with one vault → one wiki; it is the base case every other topology extends.
- Two questions decide the rest: Must any audience be kept away from some material? → separate wiki instances. Do you need notes from different vaults on the same wiki page? → one wiki.
- Topology is reversible: because `wiki/` is derived from `raw/`, you can merge or split later at the cost of re-ingestion only (Section 23).

---

## 2. Create Two Separate Vaults

Example:

```text
~/Obsidian/MyVault/     ← source vault (human-owned)
k-wiki/                 ← wiki root (this repository)
```

Open both as separate Obsidian vaults. `k-wiki` can live anywhere on disk; every instruction in this guide is relative to the `k-wiki` root.

One exception: a source vault that syncs via iCloud must live inside Obsidian's iCloud container, `~/Library/Mobile Documents/iCloud~md~obsidian/<VaultName>/`. Vault placement and transports are covered in Section 24.

Recommended ownership:

| Area | Owner | LLM writes? |
|---|---|---:|
| `MyVault/` | Human | No |
| `k-wiki/raw/` | Sync process | No |
| `k-wiki/wiki/` | LLM | Yes |
| `k-wiki/wiki/index.md` | LLM | Yes |
| `k-wiki/wiki/log.md` | LLM | Append-only |
| `k-wiki/AGENTS.md` | Human | Preferably no |
| `k-wiki/sync.json` | Human | No |

---

## 3. Decide Which Source Notes Enter the Wiki

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

## 4. Handle an Inconsistent Source Vault

Your source vault does **not** need perfectly consistent tags, filenames, links, or frontmatter before you build the wiki.

Treat source metadata as **hints**, not authoritative semantic information. The actual note content is the stronger signal. The agent-facing rules for this are defined in `AGENTS.md` (Section 9).

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

### Do not clean the source vault first

Do **not** make a global LLM rewrite of `MyVault/` the first step.

That would allow the LLM to modify your source of truth and would mix two different concerns:

```text
Source vault organization
        vs.
Knowledge extraction
```

Keep the source vault human-owned.

Instead, let the wiki understand the source vault as it is.

#### Metadata normalization as derived data

If the vault's metadata eventually proves problematic, add a derived normalization layer:

```text
MyVault/
    │
    │ deterministic sync
    ▼
k-wiki/raw/
    │
    │ LLM analysis
    ▼
k-wiki/normalized/
    │
    │ LLM ingest
    ▼
k-wiki/wiki/
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

### Recommended approach

Start with:

```text
MyVault → raw → LLM ingest → wiki
```

Do not add `normalized/` until you have evidence that source-vault organization is materially hurting ingestion quality.

The wiki should **understand your source vault rather than require your source vault to conform to the wiki**.

---

## 5. Create the Wiki Structure

```text
k-wiki/
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
├── sync.json            ← vault roots + publish target (Section 24)
├── making-of/            ← this guide
├── AGENTS.md
└── .git/
```

The exact taxonomy can evolve. Start small.

---

## 6. Make `raw/` Immutable

The synchronization pipeline is:

```text
MyVault → k-wiki/raw → k-wiki/wiki
```

Never:

```text
LLM → MyVault
LLM → raw/
```

`raw/` is the verification baseline. It should contain the latest synchronized representation of source notes, but the LLM must not edit it.

The original vault remains completely untouched by the wiki agent.

---

## 7. Automate Synchronization

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
Copy new/changed notes → k-wiki/raw/
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
k-wiki/raw/manifest.json
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

Syncing multiple vaults into one wiki? The manifest generalizes to a per-vault structure — see Section 23.

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

For vault placement, the sync configuration file, multi-device workflows, and publishing the wiki to phones and tablets, see Section 24.

---

## 8. Define the Wiki Schema and Obsidian Frontmatter

The wiki is an Obsidian vault, so use **Obsidian-compatible YAML frontmatter** rather than inventing a separate metadata format.

Start with these page types:

- `concept`
- `entity`
- `source`
- `comparison`
- `topic`

### Required wiki frontmatter

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

#### Source pages

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

Optional in multi-vault setups: `vault: <name>` records which source vault a source page originated from (Section 23).

#### Derived concept pages

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

#### Tags

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

#### Do not put everything in frontmatter

Frontmatter is the metadata/indexing layer, not the knowledge itself.

Put these in the Markdown body:

- explanations;
- evidence;
- contradictions;
- caveats;
- alternative interpretations;
- detailed relationships;
- derived conclusions.

#### Recommended metadata rules

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

## 9. `AGENTS.md`

Use this as the starting system/instruction file for the wiki agent. It consolidates all agent rules, including the source-metadata rules from Section 4.

For multi-vault wikis, also append the addendum in Section 23 (Scenario A).

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

## 10. Initial `index.md`

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

## 11. Initial `log.md`

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

## 12. Ingestion Prompt

Use this as the core prompt when processing changed sources:

```text
You are maintaining a structured knowledge wiki.

Read the changed source files under raw/ and update wiki/ accordingly.

Follow AGENTS.md exactly.

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

## 13. Incremental Update Prompt

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

## 14. Full/Rebuild Prompt

Use when rebuilding the wiki from scratch:

```text
Rebuild the knowledge wiki from all material under raw/.

Follow AGENTS.md.

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

## 15. Lint Prompt

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

## 16. Recommended Automation

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

## 17. Git

Initialize Git inside `k-wiki` (the repository root). Keep the checkout in a plain local folder — never inside a cloud-synced folder — and share it between Macs through a private remote (Section 24).

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

## 18. Retrieval

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

## 19. Source Quality

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

---

## 20. Important Design Principles

### Human source is authoritative

```text
MyVault = truth
k-wiki = derived representation
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

## 21. Recommended First Implementation

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

## 22. Final Architecture

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
                  │  k-wiki/raw/    │
                  │                 │
                  │ immutable input │
                  └────────┬────────┘
                           │
                         ingest
                           │
                           ▼
                  ┌─────────────────┐
                  │  k-wiki/wiki/   │
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

### Bottom line

Your requirements are compatible with the Karpathy-style wiki:

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

---

## 23. Scaling to Multiple Vaults and Multiple Wikis

All topologies share one seam: the deterministic sync layer. `raw/` is a projection of selected notes, not a vault mirror, so everything downstream of sync is vault-agnostic. The default path (one vault → one wiki) needs none of what follows.

### Scenario A: Multiple Vaults → One Wiki

Sync several vaults into the same `k-wiki`, namespacing each vault under `raw/notes/`:

```text
WorkVault      →  raw/notes/work/…
PersonalVault  →  raw/notes/personal/…
MoreVaults …   →  raw/notes/<vault>/…

raw/  →  ingest  →  wiki/
```

Deltas from the simple path:

1. **Namespace `raw/`.** Each vault syncs into its own subtree: `raw/notes/work/AI/RAG.md`, `raw/notes/personal/AI/RAG.md`. Never mix namespaces.
2. **Per-vault manifest.** Track roots and hashes separately:

```json
{
  "vaults": {
    "work": {
      "root": "/path/to/WorkVault",
      "notes": {
        "AI/RAG.md": { "hash": "abc123", "last_synced": "2026-08-16T15:00:00Z" }
      }
    },
    "personal": { "...": "..." }
  }
}
```

3. **Vault provenance.** Source pages record their origin with `vault: work`, so every claim stays traceable to the human context that produced it.
4. **Inter-vault contradictions are expected.** Notes written in different contexts can disagree without either being wrong. Record the disagreement with vault context; do not treat it as an ingestion error.
5. **AGENTS.md addendum.** Append:

```markdown
## Multiple Source Vaults

Sources originate from multiple vaults, recorded in the `vault` field of
source pages.

Each vault owns a separate namespace under raw/notes/. Never mix them.

When sources from different vaults disagree, preserve both claims with
their vault context instead of resolving silently.

The same provenance and confidence rules apply regardless of origin.
```

Caution: a merged wiki is only as publishable as its most private contributing vault. Keep sensitive material in a separate instance (Scenario B).

### Scenario B: Multiple Vaults → Multiple Wikis

No process changes. Each wiki is a full, independent `k-wiki` instance — its own sync manifest, `AGENTS.md`, git history, schedule, and publication decision:

```text
WorkVault      →  k-wiki-work/      (complete pipeline instance)
PersonalVault  →  k-wiki-personal/  (complete pipeline instance)
```

Folder names are illustrative; each instance is simply its own `k-wiki` root, and the process is root-relative. Each instance's manifest declares exactly one vault. You get physical isolation of privacy, audience, taxonomy, and history; you give up cross-wiki linking and synthesis.

### Scenario C: One Vault → Multiple Wikis

Invert the selection rule. Notes marked `wiki: public` sync to a publishable instance; notes marked `wiki: true` sync to the private one. Two manifests, two instances, one vault — the sync layer routes each selected note to exactly one wiki.

### Changing Your Mind Later

Topology is reversible because `wiki/` is derived from `raw/` alone:

```text
merge:  concatenate namespaced raw/ trees  →  rebuild one wiki
split:  partition raw/ by vault namespace   →  rebuild each wiki
```

The cost is re-ingestion compute, never information loss. The one exception is privacy: once sensitive notes are merged into a wiki and its git history, un-mixing requires history rewriting. Split first, merge later — not the reverse.

---

## 24. Devices and Sync

Sources get edited on every device; the wiki gets built on one Mac; the reading copy is wanted everywhere. These are two independent sync problems:

```text
R: repo sync   k-wiki itself between Macs           → git remote
W: wiki sync   reading copy on phones/tablets/Macs → mirror vault
```

### Three artifacts, three homes

| Artifact | Home | Rule |
|---|---|---|
| Source vaults | Wherever their sync method keeps them (iCloud: `~/Library/Mobile Documents/iCloud~md~obsidian/<VaultName>/`) | Transport constraint |
| `k-wiki` repo | A plain local folder, e.g. `~/Lab/k-wiki/` | `.git` must never live in service-synced storage |
| Mirror vault (optional) | Inside the chosen transport's folder, e.g. `…/iCloud~md~obsidian/KWiki/` | Disposable derived reading copy |

Never place the `k-wiki` checkout inside iCloud, Dropbox, or any synced folder: sync services race with git writes and corrupt repositories, and Obsidian's own guidance says never sync one vault through two services. The repo moves between machines only via `git push`/`git pull`. Scenario B/C instances follow the same rule — one checkout each, plain local folders.

### Sync configuration (`sync.json`)

All placement knowledge lives in one human-owned file at the `k-wiki` root:

```json
{
  "vaults": [
    { "name": "Documents",
      "root": "~/Library/Mobile Documents/iCloud~md~obsidian/Documents",
      "select": "wiki:true" }
  ],
  "publish": {
    "mirror": "~/Library/Mobile Documents/iCloud~md~obsidian/KWiki",
    "include": ["wiki/**"]
  }
}
```

- `sync.json` is configuration (what to sync, where to publish); `raw/manifest.json` is state (what has already been synced).
- The vault `name` is the `raw/notes/<name>/` namespace key and must match the vault folder name.
- `~` paths are username-independent, so one config works on every Mac.
- Transport is a config value: moving a vault from iCloud to Obsidian Sync, Syncthing, or a plain folder means updating one `root` line. Namespaces, manifests, and wiki history are untouched.

### Publish the mirror

Append one step to `wiki-sync`:

```text
sync → ingest → lint → publish (copy wiki/ → mirror vault) → git commit
```

The mirror is derived data, like the wiki itself: if the transport ever mangles it, re-copying heals it. Devices only read the mirror; edits belong upstream in the source vault.

### Choose the mirror transport

On iPhone/iPad, only iCloud and Obsidian Sync are officially supported vault transports (see References).

| Transport | iPhone/iPad | macOS | Other OSes | Notes |
|---|---|---|---|---|
| iCloud | ✅ | ✅ | Web only | Default for all-Apple fleets; free |
| Obsidian Sync | ✅ | ✅ | ✅ Win/Linux/Android | Switch here when non-Apple devices arrive; E2E-encrypted, version history |
| Syncthing | ❌ | ✅ | ✅ | No iOS support |
| Git + Working Copy | ⚠️ | ✅ | ✅ | Manual push/pull on iOS |
| Static web publish | ✅ browser | ✅ | ✅ | Complement, not replacement |

Never run two transports on the same mirror vault. Publishing two independent mirrors, each with exactly one service, is fine.

### Multiple Macs

1. Give each Mac its own checkout in the same plain location (e.g. `~/Lab/k-wiki/`) connected to one private git remote.
2. Exactly one Mac runs the scheduled pipeline; the others pull read-only.
3. The repo travels only via git — never by placing a checkout in a synced folder.

### Operating rules

1. One vault, one sync method — never point two services at the same vault.
2. Sources must be locally present at sync time: keep the iCloud container **Keep Downloaded** (macOS 15+) or disable **Optimize Mac Storage** (macOS ≤14).
3. Tolerate transport lag; do not solve it. Manifests make sync idempotent — a note still in flight lands on the next run.
4. Vault renames are pipeline events: folder name = vault name = namespace key. Update `sync.json` and re-sync deliberately.
5. Skip `.obsidian/`, `.trash/`, and `.DS_Store` when scanning.
6. iOS/iPadOS devices consume only; the pipeline runs on the Mac.
7. Near-real-time is bounded by pipeline cadence, not transport: schedule every 15–60 minutes, or trigger on file events (e.g. `fswatch` on the source vault).

---

## References

- [Original Post by Andrej Karpathy on the LLM Wiki Patterns](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [How to Build Karpathy's LLM Wiki: The Complete Guide to AI-Maintained Knowledge Bases](https://blog.starmorph.com/blog/karpathy-llm-wiki-knowledge-base-guide)
- [Andrej Karpathy’s LLM Wiki: Full Breakdown and How to Build Your Own](https://nandigamharikrishna.substack.com/p/andrej-karpathys-llm-wiki-full-breakdown)
- [Sync your notes across devices — Obsidian Help](https://help.obsidian.md/sync-notes)
