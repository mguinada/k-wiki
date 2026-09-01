---
name: campaign-ops
description: "Operates the src/ refactor campaign's two operator workflows over the epic issue (#242, mguinada/k-wiki): the projection audit (epic's slice map, wiring, and per-issue recording vs actual GitHub state) and the slice-checkpoint rollup (refreshing the epic's rollup table from the live refactor-metrics instrument). Use when the user asks to audit the campaign, check campaign progress or projection health, run a slice checkpoint, refresh or fill the campaign rollup table, or close out / wind down the campaign — also for 'is the campaign on track', 'update the epic rollup', 'checkpoint slice D/A/B/C'. Do NOT use for implementing a campaign sub-issue (that is do-gh-issue) or for code changes."
---

# Campaign Ops

Data source of record: epic **#242** in `mguinada/k-wiki` — its slice
map, wiring table, frozen baseline, and rollup table are the campaign's
projection. Live counter source: `npm run refactor-metrics -- --json`
(prints all counters fresh; the epic's doc-time baseline values are
informational by contract — the instrument's fresh output always wins).

## Projection audit

1. `gh issue view 242` for the projection; `gh issue list` / `gh issue
   view <n>` for every sub-issue's actual state (#243–#260); `gh pr
   list --state merged --search "<issue title fragment>"` or
   `gh issue view <n> --json timeline` for the merged-PR link of each
   closed one.
2. Verify three invariants and report every violation, one line each:
   - **Slice map vs state:** a slice is complete only when all its
     sub-issues are closed (D = #243–#247, A = #248–#253, B = #254–#257,
     C = #258–#260). Slices may land out of order — a closed issue
     inside an open slice is not itself a violation, but name it.
   - **Wiring vs blockers:** every `blocked by` edge in the epic
     resolves to a closed issue before its dependent is in progress.
   - **Per-issue recording:** every closed sub-issue has a last merged
     PR whose body carries its metric card.
3. Deliverable: a per-issue table (issue, title, state, merged PR)
   plus a violations list. Read-only — this audit never edits GitHub.

## Slice-checkpoint rollup

Run when a slice closes (all its sub-issues merged):

1. `npm run refactor-metrics -- --json` — fresh counters.
2. Open findings P1/P2 from GitHub: `gh issue list --label <labels>`
   restricted to the campaign's findings issues (whatever label set
   the epic's findings stream uses; if none exists, omit the row and
   say so).
3. Fill the rollup table's next empty column (After D → After A →
   After B → After C) in the epic body with the fresh values — edit
   via `gh issue edit 242 --body-file` preserving every other table
   and row byte-for-byte; never rewrite baseline or earlier columns.
4. Post a checkpoint comment on #242 naming the slice, the counters,
   and the merged PRs that closed it.
