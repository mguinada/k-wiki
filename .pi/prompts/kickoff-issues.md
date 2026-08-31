---
description: Kick off GitHub issue work in parallel — one fresh pi main agent per issue, in its own Herdr worktree, running the do-gh-issue skill
argument-hint: "[<issue-number> | <issue-URL> | label:<label> | top:<N> by <criterion> ...]"
---

You (host) only resolve issues and launch agents. Each fresh pi main agent implements its issue alone via the `do-gh-issue` skill — the skill already gates on blockers, so the kickoff never re-checks them.

## 1. Preconditions

1. `test "${HERDR_ENV:-}" = 1` or stop: tell the user to run this from a Herdr pane. Load the `herdr` skill.
2. Resolve repo and default branch (`gh repo view --json nameWithOwner,defaultBranchRef`); a URL naming another repo → stop and ask. `git fetch origin <default-branch>`.
3. Record `$HERDR_PANE_ID` — the address agents report outcomes to.

## 2. Resolve issues

Criteria: $ARGUMENTS

- `#N` / number / URL → `gh issue view`; `label:<x>` → `gh issue list --state open --label <x> --json number,title,url`.
- `top:<N> by <criterion>` (e.g. `top:3 by value`) → `gh issue list --state open --json number,title,labels,body`; score every issue against `<criterion>` — mechanical when the criterion maps to a label signal (e.g. priority labels), judged otherwise; propose the top N in a table (number, title, one-line reason each, plus the cut line — best issue excluded and why); wait for confirmation. Confirmed → those N proceed in ranked order; declined or timeout → stop, launch nothing.
- Keep OPEN issues only (record non-open as skipped); dedupe; keep the user's order.
- No criteria → list open issues and ask — never pick yourself. Unresolvable argument → ask. Empty set → report, create nothing. More than 8 → confirm first.
- Branch `issue-<N>-<slug>` (kebab-case, 3–5 words). Snapshot collisions once (`herdr worktree list` + `git branch --list "issue-<N>-*"`); existing → skip and record, never clobber.
- **Classify each resolved issue** (dual-path kickoff, issue #238): the issue whose title is exactly `Mutation testing: actionable survivors` — the `ROLLING_TITLE` constant of `.github/workflows/mutants-report.yml`, the auto-filed rolling mutation report — is **rolling**; every other issue is **regular**. If `ROLLING_TITLE` ever changes, this match string changes in the same PR. The paths differ in the step-3 prompt only; every other mechanic is identical.

## 3. Kick off — all issues, no waiting between launches

With two or more issues and a `subagent` tool available, launch one `delegate` per issue in a single parallel fan-out (one `subagent` call, `workflowScript` + `async: true`, `isolation: none`, key `issue-<N>`); with exactly one issue — or no `subagent` tool — run the same three steps yourself, back-to-back (at N=1 the delegate only adds a failure mode: a hung child stalls a ~10s procedure, with no parallelism payoff). Per issue — **both paths, identical machinery** (worktree named after the issue, agent `issue-<N>`, branch prefix `issue-<N>-`):

1. `herdr worktree create --cwd "$PWD" --branch "issue-<N>-<slug>" --base "origin/<default-branch>" --no-focus` — parse workspace/tab/pane IDs from the JSON, never guess. For a rolling issue the slug is `survivor-kill` (e.g. `issue-<N>-survivor-kill`): the branch is a harvest pass, not an implementation of the issue.
2. `herdr agent start "issue-<N>" --kind pi --pane <pane-id>`
3. `herdr agent prompt "issue-<N>" "<path-specific opening> You are already in worktree <path> on branch issue-<N>-<slug> from origin/<default-branch> — skip the skill's branch/worktree step. Report twice: herdr agent prompt <host-pane-id> 'issue #<N>: <PR URL>' as soon as the PR opens (the pipeline may still be running), and one final line after your handoff: 'issue #<N>: <outcome>, <PR URL>'; if either report fails, print the same line in your own pane."` — without `--wait`. The path-specific opening:
   - **regular:** `/do-gh-issue #<N>: <url>.`
   - **rolling:** `Load the mutation-triage skill. Kill the survivors listed in issue #<N> (rolling mutation report, label `mutation`). Do not close the issue; it is a living report. Record equivalent mutants with a justification line in the PR body instead of hunting them.`
   The worktree clause and the twice-report clause are shared verbatim by both paths.

Confirm pickup only after the last kickoff: `herdr agent wait "issue-<N>" --until working --timeout 60000`; on timeout, read the pane and record — never answer prompts for the user.

## 4. Report

One table: number, title, result (launched / skipped / failed), worktree, branch, agent, workspace. List each skip or failure with its reason. Close: live progress is in the Herdr sidebar; each agent reports its outcome back to this pane; each agent also opens its own gate pane and runs a validating pipeline that pushes to origin — expect up to N extra panes and N concurrent no-mistakes runs; ask me any time for a status check.

For a **rolling** launch, the final outcome line the agent reports reads `issue #<N>: survivors killed X/Y (Z recorded equivalent), <PR URL>` — "implemented" and "closed" are the wrong nouns for a harvest pass, and the issue must remain open.
