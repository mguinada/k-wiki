# Mutation testing in CI

Mutation testing is an advisory signal, not a gate — and it is
**optional in the development loop** (issue #208). The authoritative
mutation signal lives in CI (`.github/workflows/ci.yml`), in three
shapes (#261): per-PR runs on pull requests labeled `mutation` (diff-
scoped vs `origin/main`, exactly the optional local run); a **nightly
windowed run** on `main` that mutates only the `src/` hunks changed in
the trailing 7 days (`MUTATION_WINDOW_DAYS`;
`src/quality/mutation-scope.ts` resolves the base SHA; a quiet window
files a synthetic empty report, never a red job); and the **chunked
code-wide full run via manual `workflow_dispatch` only** (#236) — the
exceptional audit / ledger-rewrite path, no longer scheduled. The
full run starts with a dry run of the whole unit suite in Stryker's
vitest worker-thread pool, so any test that is red on main — or
passes in vitest's default forks pool but cannot run in worker
threads, like `process.chdir()` (#193) — kills the run before a
report exists; the job log names the failing tests, and the run page
carries an error annotation while the job stays advisory-green
(#215). The full run is **chunked** because it once outgrew GitHub's
6 h per-job limit and was cancelled before any report existed:
`dev/mutation-chunk.ts` splits the mutate list into four
size-balanced, disjoint parallel chunk jobs (each runs the same
dry run first), and `dev/mutation-merge.ts` stitches the chunk
reports into the one `mutation-report` artifact — refusing
(`--expect`) to merge a partial picture, so a failed or cancelled
chunk still files no report and the #208 starvation signal survives.

After every nightly or dispatched run, the
`mutants-report` workflow (`.github/workflows/mutants-report.yml`)
merges the actionable mutants into one rolling issue labeled
`mutation` — "Mutation testing: actionable survivors" — kept on the
K-Wiki Kanban at Status = Ready. The issue body is a **merged
ledger**, never a replace snapshot: an entry leaves only via a
verified kill (Killed / Timeout) or a recorded adjudication, and
out-of-scope entries stay listed — a windowed nightly cannot wipe
what it did not cover; a dispatched full run from the default
branch reconciles the whole ledger (absence kills). Adjudications
live in the **equivalent-mutant registry** (#241),
`.mutants-registry.json` at the repo root: a committed JSON file of
settled mutants keyed by a refactor-resilient identity — sha over
the mutated span's exact code text, the mutator, the replacement
sabotage text, and the file's repo-relative path (occurrence
ordinal included so duplicate identical spans never share a key).
The filing filters recorded entries from the untriaged list and
counts them separately (`equivalent` and `artifact` buckets, never
merged — artifacts stay visible in their own section because they
are plausibly killable), so recording a mutant moves it between
counts and the total never shrinks silently. Entries are keyed
under span identities, not `file:line`: a full dispatch
reconciliation rewrites the ledger and reports registry prune
candidates (spans no longer generated); removal lands as a PR.
Recording an adjudication = the kill-work agent edits
`.mutants-registry.json` **in its PR** (`npm run mutation:survivors
-- --ids` prints the identity to record) — PR review is the
human-judgment gate; every entry carries its receipt (bucket,
one-line justification, PR link, date) and a receipt-less entry
fails the unit suite. Kill-work batches are spun from that issue as
normal agent work. Keep the rolling count tended: it is a dashboard
of debt, not a graveyard.

Policy boundaries: per-mutant adjudications (equivalent, artifact)
are recorded in `.mutants-registry.json` with their receipt — never
as inline suppressions. A `// Stryker disable` comment remains legal
only for the coarse case — a location that should never be mutated
at all — and still requires a written justification line in the PR
body; recording equivalent mutants stays a human judgment.
