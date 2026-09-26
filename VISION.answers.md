# k-wiki vision - author answers (durable calibration)

One line per verdict, recorded verbatim from the review board (2026-08-21).
Keep this file next to VISION.md; it is the calibration record.

## Verdicts

- **H-1 Ask the mirror - In vision.** "Yes, I want to study opportunities to have me being able to issue a query via iPhone or iPad. The mirror is not the ideal medium to accomplish this. It's just a stepping stone. But in truth, I still have to evaluate feasibility to issue queries from portable devices."
- **H-2 Unattended auto-commit - Conditional.** "Git will always provide an historical view on the evolution of the wiki. For now, we'll have to rely on that. If we see that there was some kind of drift or imprecision in the wiki, we may have to analyze it." Freeform follow-up: "Maybe we'll think about having a reviewer agent that looks into this."
- **H-3 Semantic search ahead of the trigger - In vision.** (no notes)
- **H-4 A Notion source adapter - Conditional.** "I might want to add Notion Export, but on demand. I don't want everything that I have in Ocean to end up in the wiki"
- **H-5 One shared team wiki - Conditional.** "This might be an interesting scenario, but for now it's not exactly in the horizon. Nonetheless, I don't want to close the door to this."
- **H-6 Guardrail toggles per instance - Conditional.** "This we should be able to set that flag per wiki, not across all wikis"
- **H-7 Lint auto-fix - Conditional.** "We might want to add adversarial review in the future"
- **H-8 Mutation testing as a blocking gate - Off mission.** (no notes)
- **H-9 Query falls back to raw/ - Conditional.** "Eventually we should disclaim to the user that the query answer is based on the raw notes, and therefore passive of verification"
- **H-10 SQLite manifest at scale - In vision.** "That's quite interesting evolution that we might want to resort to."

## Changelog

- H-1 In vision -> Scope now reads the mirror as a private reading copy, and queries from portable devices as wanted but unproven; the mirror is a stepping stone, not the destination.
- H-2 Conditional -> The diff section accepts unattended commits with the data repo history as the audit; drift or imprecision triggers analysis, possibly by a reviewer agent (freeform note folded in); the pre-review phrasing "does not ship" was removed.
- H-3 In vision -> Deferral line now reads "passing a trigger is permission to build, not an obligation"; Scope adds hybrid search as an accepted evolution when index-first lookup stops keeping up.
- H-4 Conditional -> Privacy section adds: a new source type arrives on demand with explicit selection; bulk import of an external workspace is never the default.
- H-5 Conditional -> Scope softens "not a team knowledge base" to one-operator-today with the door open, merge irreversibility still respected.
- H-6 Conditional -> Enforcement floor line rewritten: the floor is set per instance by its operator; an agent never holds the switches to its own guardrails.
- H-7 Conditional -> Scripts-enforce section adds: lint reports rather than rewrites; auto-fix waits for a review mechanism that can challenge its judgments.
- H-8 Off mission -> Small-surface section adds: mutation testing stays advisory, a signal never a gate.
- H-9 Conditional -> Scope adds: a query may fall back to `raw/` when the wiki cannot answer, and the answer must say so - it rests on raw notes and awaits verification.
- H-10 In vision -> Flow section adds: internal artifacts such as the manifest may trade diff-readability for scale; `raw/` and `wiki/` stay text and diffable.

## Post-board corrections (2026-08-25, evidence pass against the repo)

Not board verdicts - a contradiction pass run against the shipped repo after the board closed. The verdicts above are unchanged.

- Flow line corrected: the derived pages regenerate at any time; the accreted layer - filed queries, human corrections, the second-brain profile - is preserved, never regenerated. No verdict backed "whole wiki"; `wiki/AGENTS.md` (Regeneration) and guide §14a define the preserved layer.
- H-7 lint line corrected (lossy fold): the verdict said "might want... in the future", but the fold wrote lint as report-only while `prompts/lint.md` (guide §17) ships mechanical auto-fix inside guardrails. Vision now states shipped behavior; adversarial review stays deferred with a trigger - cycle diffs outgrowing the operator's review - and report-only by design (agent recommendation, applied on the author's instruction).
- H-9 raw-fallback line corrected (lossy fold): the verdict said "eventually... disclaim", but the fold wrote present-tense permission. Vision now states the shipped rule (`wiki/AGENTS.md` Queries: say so and suggest sources to ingest) and marks a `raw/` fallback as an accepted evolution carrying the H-9 disclaimer. No trigger recorded; the author did not name one.

### Reviewer-fleet pass (2026-08-25, same day)

Three fresh-context reviewers (consistency, architecture, adversarial) audited the corrected vision against the contracts, guide, and code. Fixes applied on the author's instruction:

- Config-privacy line scoped to the contracts' rule: a private instance's config is never committed; ignored `sync-*.json`/`settings-*.yml` do the enforcing (guide §18 rule 2, README operator rules). The old absolute line condemned the tracked default `sync.json`/`settings.yml`, which are publishable-repo files by design.
- "Every safety property that matters is checked mechanically" narrowed to catastrophic failure classes (`src/ingest/guardrails.ts` scope note), and the closed-world caveat added: no mechanical check proves a claim true; confidence-min, corroboration, expungement, and human diff review carry the residual risk (`wiki/AGENTS.md` Residual Risk, guide §22).
- Guardrail scope corrected to pipeline-invoked runs; operator-driven rebuild relies on human spot-checks (`wiki/AGENTS.md` Regeneration step 4) - `prompts/rebuild.md` and `prompts/comparison-harvest.md` have no wrapper.
- Enforcement-floor line re-marked as evolution (H-6 was Conditional; no settings key ships - `src/ingest/wiki-ingest.ts` parses command/model/reasoning/provider/isolate/secondBrain.domains only); the agent-never-holds-the-switches half is verified true.
- Review-mechanism line re-tensed to deferred (no reviewer agent ships; agent recommendation carrying the trigger, author-approved).
- "Every run" narrowed to "every cycle" (query runs end with an answer, not a digest+diff; README: digest plus `git log -1`).
- Dry-run line scoped to vaults (`sync-vault --dry-run` ships; `sync-repo` has none).
- Mirror line marked planned (open issue #15; `publish` config parsed but unused).
- `raw/` fallback hardened from "accepted evolution" to "stays forbidden until the contract changes" (adversarial finding: no trigger + present-tense phrasing read as permission against `wiki/AGENTS.md` Queries).
- Added: expungement line (Flow; `wiki/AGENTS.md` Expungement) and plain-local-folder placement rule (Privacy; guide §26).
