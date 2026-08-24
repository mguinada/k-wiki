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

## 3. Kick off — all issues, no waiting between launches

If a `subagent` tool is available, launch one `delegate` per issue in a single parallel fan-out (one `subagent` call, `workflowScript` + `async: true`, `isolation: none`, key `issue-<N>`); otherwise run the same three steps yourself, back-to-back. Per issue:

1. `herdr worktree create --cwd "$PWD" --branch "issue-<N>-<slug>" --base "origin/<default-branch>" --no-focus` — parse workspace/tab/pane IDs from the JSON, never guess.
2. `herdr agent start "issue-<N>" --kind pi --pane <pane-id>`
3. `herdr agent prompt "issue-<N>" "Run the do-gh-issue skill end-to-end for issue #<N>: <url>. You are already in worktree <path> on branch issue-<N>-<slug> from origin/<default-branch> — skip its branch/worktree step. Final action: herdr agent prompt <host-pane-id> 'issue #<N>: <PR URL, or reason stopped>'; if that fails, print the same line here."` — without `--wait`.

Confirm pickup only after the last kickoff: `herdr agent wait "issue-<N>" --until working --timeout 60000`; on timeout, read the pane and record — never answer prompts for the user.

## 4. Report

One table: number, title, result (launched / skipped / failed), worktree, branch, agent, workspace. List each skip or failure with its reason. Close: live progress is in the Herdr sidebar; each agent reports its outcome back to this pane; ask me any time for a status check.
