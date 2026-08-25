# Vision

`k-wiki` exists so that one person's notes become a maintained, interlinked knowledge base without that person doing the maintaining.
It serves a single operator per instance: the owner of a source vault or repository who wants compiled knowledge, not another chore.
It owns exactly one thing: the pipeline that turns sources into a reviewed wiki - sync, ingest, checks, one commit.

## The flow runs one way

The human owns the source vault; no pipeline step ever writes to it.
`raw/` is a deterministic projection of the sources with no LLM in the path.
`wiki/` is derived from `raw/` alone; the derived pages regenerate at any time, and the accreted layer - filed queries, human corrections, the second-brain profile - is preserved, never regenerated.
Deleting a source purges its influence: no claim, concept, or filed query rests on removed material; the wiki reflects the current `raw/`.
Everything derived is disposable and versioned in a data repo, auditable by diff.
`raw/` and `wiki/` stay text and diffable forever; internal artifacts such as the manifest may trade diff-readability for scale, for example a SQLite index, when the vault demands it.
A change that lets influence flow back - the agent editing sources, wiki edits reaching the vault - is wrong by definition.

## Scripts enforce, prose suggests

Every catastrophic failure class is checked mechanically, never entrusted to the agent's good behavior.
Guardrails run after every pipeline-invoked agent run and auto-revert anything that trips; operator-driven runs such as rebuild rely on human spot-checks.
Deterministic checkers - links, provenance, fidelity, crosslinks - are permanent backstops, not one-time audits.
No mechanical check proves a claim true: confidence-min propagation, the corroboration lifecycle, and expungement shrink contamination risk, and human diff review stays the final detector.
Identity and trust markers sit outside anything an agent run can write.
An operator-settable, per-instance enforcement floor is an accepted evolution; an agent never holds the switches to its own guardrails.
Lint fixes clear mechanical problems automatically inside the guardrails and reports the rest; auto-fix beyond mechanical fixes waits for a review mechanism that can challenge its judgments.
The review mechanism stays deferred until cycle diffs outgrow the operator's review, and it challenges by report rather than rewrite.

## Determinism where determinism works

Sync, filing, backfill, and checks are plain code that spends zero tokens.
Code never guesses at a judgment call: ambiguous cases are reported for the human to decide.
The LLM appears only where judgment is genuinely needed - deriving and linting pages, answering questions.

## The diff is the review surface

Every cycle ends with a digest and a data-repo commit that together tell its whole story.
The data repo holds `raw/` and `wiki/` side by side so source and derivation are reviewed as one change.
Unattended runs may commit on their own; the data repo's history is the audit.
Drift or imprecision in the wiki triggers analysis, possibly by a dedicated reviewer agent.

## Privacy is structural

Personal material lives in the data repo, never in the code repo; the repository boundary does the enforcing.
Both repositories live in plain local folders, never inside cloud-synced storage, and move between machines only by git.
New or reconfigured vaults get a dry run first, because the failure direction of selection is a leak, not a loss.
A new source type arrives on demand with explicit selection; bulk import of an external workspace is never the default.
Merging sensitive material into a wiki is irreversible; split first, merge later.
A private instance's configuration - vault paths, model choice - is never committed; the ignored `sync-*.json` and `settings-*.yml` variants do the enforcing.

## Small surface, deferred on purpose

A feature lands as the narrowest mechanism that closes a proven gap.
Orchestrators chain proven pieces and add no capability of their own.
Deferred ideas carry explicit reconsideration triggers; passing a trigger is permission to build, not an obligation.
Mutation testing stays advisory: runtime and machine variance make it a signal, never a gate.
Behavior, tests, help text, and documentation land in the same change.

## Scope

k-wiki is not a note-taking app and does not replace Obsidian.
It serves one operator per instance today; a shared team wiki is not on the horizon, and the door stays open only with the merge-irreversibility rule respected.
The planned mirror is a private reading copy, not a publishing platform.
Answering queries from portable devices is wanted and still to be proven feasible; the mirror is a stepping stone toward it, not the destination.
It is not a search engine, but hybrid search is an accepted evolution when index-first lookup stops keeping up.
A query the wiki cannot answer says so and suggests the sources to ingest; a `raw/` fallback stays forbidden until the contract changes, and its answers would have to say they rest on raw notes and await verification.
The wiki contract (`wiki/AGENTS.md`) changes only through human-approved commits.

A change aligns when it keeps the flow one-way, replaces a proven risk with a mechanical check, stays deterministic where code suffices, and lands with its tests, help, and docs.
A change should be resisted when it moves trust from code into prompt wording, lets the agent configure or waive its own guardrails, lets derived data or configuration drift back toward sources, or puts personal material one mistake away from a public remote.
