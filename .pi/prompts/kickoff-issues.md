---
description: Kick off GitHub issue work in parallel — one Herdr worktree and delegated agent per issue, each running the do-gh-issue skill
argument-hint: "[<issue-number> | <issue-URL> | label:<label> ...]"
---

You are the orchestrator, not the implementer. For every issue resolved below, create one Herdr worktree and launch one delegated agent that executes the `do-gh-issue` skill for that issue. Never run `do-gh-issue` yourself.

Spawn the agents as early as possible, and never earlier than safety allows: complete every host-side rule first (phases 1–2 — preconditions, issue resolution, collision check), then launch every agent back-to-back (phase 3). Nothing that is not a host-side rule — pickup confirmation, progress monitoring — may sit between the rules and the launches, or between two launches. The issues are independent: one agent's stall, block, or failure never delays or cancels another launch.

## 1. Preconditions

1. Verify you run inside Herdr: `test "${HERDR_ENV:-}" = 1`. If it fails, stop and tell the user to run this from a Herdr pane. If it passes, load the `herdr` skill before issuing any `herdr` command.
2. Resolve the repository and default branch: `gh repo view --json nameWithOwner,defaultBranchRef`. Every issue must belong to this repository; if a URL names a different one, stop and ask.
3. `git fetch origin <default-branch>` once.
4. Record your own pane ID (`$HERDR_PANE_ID`) — the delegated agents report their final outcomes back to this pane.

## 2. Resolve the issue set

Criteria supplied by the user (may be empty): $ARGUMENTS

- Bare number or `#N` → `gh issue view <N>`.
- Issue URL → `gh issue view <url>`.
- `label:<name>`, `tag:<name>`, or a phrase like "all issues labeled X" → `gh issue list --state open --label <name> --json number,title,url`.
- Keep only `OPEN` issues; record non-open ones as skipped with their state.
- Deduplicate by number; keep the user's order.
- No criteria → list open issues and ask the user to choose. Never pick yourself.
- An argument you cannot resolve unambiguously → ask. An empty set after resolution → report and create nothing.
- More than 8 issues resolved → show the list and confirm before creating anything.
- For each surviving issue derive its slug from the title: kebab-case, 3–5 words. Branch name: `issue-<N>-<slug>`.
- Snapshot collisions once: `herdr worktree list` plus `git branch --list "issue-<N>-*"` per issue. An issue whose worktree or branch already exists is skipped and recorded with the existing path — never reuse or clobber silently.

## 3. Launch every agent

For each issue that survived §2, in the user's order. The chain inside one issue is sequential — each step needs the previous step's ID — but never wait on one issue's pickup, progress, or outcome before starting the next:

1. Create and open the worktree, named after the issue, without stealing focus:

   ```sh
   herdr worktree create --cwd "$PWD" --branch "issue-<N>-<slug>" --base "origin/<default-branch>" --no-focus
   ```

   The worktree directory takes the branch name. Parse the new workspace, tab, and pane IDs from the JSON response; never guess them.

2. Start the delegated agent in the new pane:

   ```sh
   herdr agent start "issue-<N>" --kind pi --pane <pane-id>
   ```

3. Submit the kickoff prompt without `--wait` (the agent works long after this turn ends), then move straight to the next issue:

   ```sh
   herdr agent prompt "issue-<N>" "Read .agents/skills/do-gh-issue/SKILL.md and execute it end-to-end for issue #<N>: <url>. Two adjustments: (1) its step 9 is already done — you are in the worktree <worktree-path> on branch issue-<N>-<slug>, based on origin/<default-branch>; do not create another branch or worktree. (2) As your final action, report your outcome to the orchestrator: herdr agent prompt <host-pane-id> \"issue #<N>: <one line — PR URL, or the reason the run stopped>\". Report whether you finish, stop on a blocker, or fail."
   ```

If any step fails for an issue (name collision, dirty state, CLI error), record the issue as failed with the reason and continue with the rest immediately.

## 4. Confirm pickup

Only after the last kickoff prompt has been submitted — never before — confirm each launched agent picked up its work: `herdr agent wait "issue-<N>" --until working --timeout 60000`. On timeout or a `blocked` state, read the pane (`herdr agent read "issue-<N>" --source recent-unwrapped --lines 60`). If it shows a prompt awaiting input — trust confirmation, onboarding — surface it in the report; never answer prompts for the user. Otherwise record what you see. A stalled or blocked agent is reported, not acted on: it never delays or cancels the other agents.

## 5. Report

End with a Markdown table — one row per issue: number, title, result (launched / skipped / failed), worktree path, branch, agent name, workspace ID. Under it, list every skip or failure with its reason. Close with: live progress is in the Herdr sidebar; every agent reports its final outcome back to this pane and I relay it to you; ask me any time for a status check.
