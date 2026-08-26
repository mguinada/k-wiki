---
name: triage-issues
description: Triage a GitHub Projects board end to end — move every unblocked Backlog issue to Ready, move issues with open PRs to In progress, order the Ready lane top-down by the most logical implementation sequence (value first, friction avoided), and report a summary table with clickable issue titles, lane moves, brief summaries, and a priority-ordered parallel-safe-with column. Use when the user asks to triage issues, groom or refine the backlog, move unblocked issues to ready, reorder the Ready lane, or run board hygiene on the K-Wiki Kanban board (or any GitHub Projects board).
---

# triage-issues

**First action: load the `gh` skill** (read its `SKILL.md`, e.g.
`~/.pi/agent/skills/gh/SKILL.md`) — it prescribes the gh CLI
usage patterns this skill builds on: `--json` structured output, `--jq`
filtering, GraphQL fallback via `gh api graphql`, pagination limits, and
repo targeting. Use the gh CLI for every GitHub interaction in this run.

One run does four things, in order: **move** Backlog issues that are ready,
**place** PR-bearing issues, **sequence** the Ready lane, **report** the
summary table. Default board: K-Wiki Kanban (project 2, owner `mguinada`).
Parameterize owner/project number for any other board.

## Rules (the contract)

1. Only items **on the Backlog lane** move. Issues on any other lane are
   never touched, whatever their state.
2. Backlog issue with **no open blockers** and **no `research` label** →
   **Ready**.
3. Backlog issue with an **open PR** → **In progress** (overrides rule 2;
   verified via cross-referenced events, not title guessing).
4. Blocked (any formal `blockedBy` issue still open) → stays. Research
   (`research` label) → stays, even when unblocked.
5. The Ready lane is re-sequenced top-down every run; the sequence is the
   run's judgment, applied with position mutations, never left implicit.

## Command cheatsheet — read before any gh call

- **Every project command needs the keyring token**: prefix
  `env -u GITHUB_TOKEN gh …`. A `GITHUB_TOKEN` env var has `repo` scope
  only and fails project GraphQL with a scope error.
- `gh project item-edit` on current gh requires
  `--project-id <PVT_…>` in addition to `--id` / `--field-id` /
  `--single-select-option-id`.
- **`gh project item-list --format json` returns items in board-position
  order** (per lane). That is the read path for ordering and the verify
  path after every write.
- Position writes go through GraphQL (no CLI subcommand):

  ```sh
  env -u GITHUB_TOKEN gh api graphql -f query='
  mutation($p: ID!, $i: ID!, $a: ID) {
    updateProjectV2ItemPosition(input: {projectId: $p, itemId: $i, afterId: $a}) {
      clientMutationId
    }
  }' -f p="$PROJECT_ID" -f i="$ITEM_ID" -f a="$AFTER_ID"
  ```

  `afterId: null` = top of the item's lane. The argument is `afterId`
  (`after` is rejected).

- Resolve IDs fresh each run — never reuse IDs from a previous session:

  ```sh
  PROJECT_ID=$(env -u GITHUB_TOKEN gh project view 2 --owner mguinada --format json --jq .id)
  # Status field id + option ids (Ready, In progress):
  env -u GITHUB_TOKEN gh project field-list 2 --owner mguinada --format json
  ```

## Step 1 — Pull the full board state

```sh
env -u GITHUB_TOKEN gh project item-list 2 --owner mguinada --format json --limit 200
```

Collect: every Backlog-lane Issue (number, item id, title), plus the
current Ready-lane order. Gather central facts once, cheaply:

- Open issues: `gh issue list --state open --limit 100 --json number`
- Labels + formal blockers per issue:
  `gh issue view <n> --json labels,blockedBy`
- Open PR links (one GraphQL over cross-referenced events, repo-scoped):

  ```sh
  env -u GITHUB_TOKEN gh api graphql -f query='
  query {
    repository(owner: "mguinada", name: "k-wiki") {
      issues(first: 50, states: OPEN) {
        nodes {
          number
          timelineItems(first: 30, itemTypes: CROSS_REFERENCED_EVENT) {
            nodes { ... on CrossReferencedEvent { source { ... on PullRequest { number state } } } }
          }
        }
      }
    }
  }' --jq '.data.repository.issues.nodes[]
    | select(.timelineItems.nodes | map(select(.source.state == "OPEN")) | length > 0)
    | "#\(.number) <- PRs \([.timelineItems.nodes[] | select(.source.state == "OPEN") | .source.number])"'
  ```

## Step 2 — Fan out one subagent per Backlog issue

The user's standing requirement: **one delegate per Backlog issue**, each
independently verifying its own issue (no shared precomputed verdicts —
redundancy is the point). Launch them in one workflow with
`runs.all([...])`. Per-agent task template (fill `<n>` and `<item-id>`):

```
You manage the GitHub Projects board item for issue #<n> in mguinada/k-wiki. Follow exactly:
1. Open issue numbers:
   env -u GITHUB_TOKEN gh issue list --state open --limit 100 --json number --jq '.[].number'
2. This issue's labels and formal blockers:
   env -u GITHUB_TOKEN gh issue view <n> --json labels,blockedBy --jq '{labels: [.labels[].name], blockers: [.blockedBy.nodes[].number]}'
3. Decide, in this order:
   a. any blocker in the open list -> BLOCKED, no board change
   b. labels contain "research"   -> RESEARCH, no board change
   c. else -> move to Ready:
      env -u GITHUB_TOKEN gh project item-edit --project-id <PROJECT_ID> --id <item-id> \
        --field-id <STATUS_FIELD_ID> --single-select-option-id <READY_OPTION_ID>
      then verify by re-running item-list and confirming the item's status reads Ready.
4. Report EXACTLY one line:
   "#<n> | <BLOCKED(open: X,Y) | RESEARCH | MOVED-TO-READY(verified)> | <one short evidence clause>"
Rules: never edit the issue itself (no labels/body/close). The only write is step 3c.
If a command fails, report "#<n> | ERROR | <message>".
```

Known harness noise: delegates that only write via `gh` get flagged
"completed without making edits for an implementation task". That signal
is a file-edit heuristic — **ignore it**; the board re-list in Step 3 is
the ground truth. Central facts (PR links) from Step 1 are applied by the
orchestrator, not re-derived per agent — if a Backlog issue has an open
PR, the orchestrator moves it to In progress directly (rule 3) instead of
Ready.

## Step 3 — Verify against the board, not the reports

Re-run `item-list`, diff Backlog/Ready/In-progress membership against the
expected dispositions, and reconcile any mismatch by direct `item-edit`
(with `--project-id`). Only then is the move phase done.

## Step 4 — Sequence the Ready lane

Read every Ready issue's body (title + body + labels; the Relationships /
Dependencies / blocked-by sections carry the friction data). Order top-down
by the rubric below, then apply with `updateProjectV2ItemPosition`:
desired order `[e1, e2, …]` → move `e1` with `afterId: null`, then each
`e_k` with `afterId: <id of e_{k-1}>`. Re-list to verify the order took.

### Sequencing rubric — most logical implementation order

Sort by **value to the implementation, most valuable first**, tie-broken
by **friction avoided**:

1. **Correctness fixes** with live incident evidence (a defect observed in
   production data, not hypothetical).
2. **Blocker-clearing refactors** — an unblocked refactor that other
   Backlog issues formally wait on rises above same-milestone features.
3. **Cycle/automation completions** — work that makes every later change
   cheaper or verified by construction.
4. **Features** by milestone order.
5. **Conveniences and read-only additions** float last.

Friction rules that override raw value order:

- **Hot-file cluster**: several issues touching the same file in disjoint
  regions sequence back-to-back (fixes first, mechanical moves last) — one
  trivial rebase each, never interleaved development.
- A **heavier rework of a hot file** (e.g. a big extraction) lands *after*
  the small fixes in that file, not beside them.
- **Cross-repo pairs** (code repo vs data repo) never conflict — they can
  sit adjacent freely.

### Parallel-safe-with rubric (for the table column)

For every pair of Ready issues, read both bodies and classify:

| Verdict | Meaning |
|---|---|
| **safe** | Disjoint files or disjoint repos; merges clean |
| **low-risk** | Same file, disjoint regions; trivial rebase noise only |
| **avoid** | Merge-conflict-prone, hard blocking edge, or crossed context (shared domain semantics, both heavily reworking one file) |
| **caution** | No git conflict but operationally interleaved (timing coordination) |

The column lists **safe and low-risk partners only**, **in priority order
— the highest-priority parallel partner first**, exactly mirroring the
lane sequence. A higher-priority issue never lists a lower-priority
partner it conflicts with; if the top two conflict, neither lists the
other.

## Step 5 — Report

Produce exactly this table (all moved issues; markdown links on titles;
`From → To` lane names; one-line summaries; the parallel-safe column):

```markdown
| Issue | Lane move | Summary | Parallel-safe with |
|---|---|---|---|
| [#143 — Pair body-identical moves as renames](https://github.com/mguinada/k-wiki/issues/143) | Backlog → Ready | Ingest diff classifies frontmatter-only moves as renames, never expunge | **#14** (disjoint), low-risk: #15 |
```

Rules: title column = clickable `#<n> — <short title>` link; summaries
one clause each; parallel-safe entries bold for **safe**, `low-risk:`
prefix for low-risk, priority order (lane order) within the cell; issues
that stayed on Backlog are not rows, but the report closes with one line
each for *why* they stayed (blocked-by list or research).

Follow with a two-line footer: the applied Ready-lane order (numbers,
top-down) and any reconciliations made in Step 3.

## Out of scope

Never edit issues themselves (labels, bodies, assignments, close), never
move items on Done/In review/In progress/Ready lanes during the move phase
(the Ready *order* change in Step 4 is the only reorder), never prune
stale blocking edges unless the user asks.
