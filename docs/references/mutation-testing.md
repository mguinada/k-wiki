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
verified kill (Killed / Timeout) or a later adjudication, and
out-of-scope entries stay listed — a windowed nightly cannot wipe
what it did not cover; a dispatched full run from the default
branch reconciles the whole ledger (absence kills). Equivalents
recorded in PR bodies re-file
nightly until the equivalent-mutant registry (#241) lands — known,
bounded, and the pressure to run #241 next. Kill-work batches are
spun from that issue as normal agent work. Keep the rolling count
tended: it is a dashboard of debt, not a graveyard.
