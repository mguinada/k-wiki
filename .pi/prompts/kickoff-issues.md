---
description: Kick off GitHub issue work in parallel — one Herdr worktree and delegated agent per issue, each running the do-gh-issue skill
argument-hint: "[<issue-number> | <issue-URL> | label:<label> ...]"
---

You are the orchestrator, not the implementer. For every issue resolved below, create one Herdr worktree and launch one delegated agent that executes the `do-gh-issue` skill for that issue. Never run `do-gh-issue` yourself.

## 1. Preconditions

1. Verify you run inside Herdr: `test "${HERDR_ENV:-}" = 1`. If it fails, stop and tell the user to run this from a Herdr pane. If it passes, load the `herdr` skill before issuing any `herdr` command.
2. Resolve the repository and default branch: `gh repo view --json nameWithOwner,defaultBranchRef`. Every issue must belong to this repository; if a URL names a different one, stop and ask.
3. `git fetch origin <default-branch>` once.

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

## 3. Per issue: worktree, agent, kickoff

For each resolved issue, in order:

1. Derive a slug from the issue title: kebab-case, 3–5 words.
2. If a worktree or branch for this issue already exists (`herdr worktree list`, branch `issue-<N>*`), skip it and record the existing path — never reuse or clobber silently.
3. Create and open the worktree, named after the issue, without stealing focus:

   ```sh
   herdr worktree create --cwd "$PWD" --branch "issue-<N>-<slug>" --base "origin/<default-branch>" --no-focus
   ```

   The worktree directory takes the branch name. Parse the new workspace, tab, and pane IDs from the JSON response; never guess them.
4. Start the delegated agent in the new pane:

   ```sh
   herdr agent start "issue-<N>" --kind pi --pane <pane-id>
   ```
5. Submit the kickoff prompt without `--wait` (the agent works long after this turn ends):

   ```sh
   herdr agent prompt "issue-<N>" "Read .agents/skills/do-gh-issue/SKILL.md and execute it end-to-end for issue #<N>: <url>. One adjustment: its step 9 is already done — you are in the worktree <worktree-path> on branch issue-<N>-<slug>, based on origin/<default-branch>. Do not create another branch or worktree."
   ```
6. Confirm pickup: `herdr agent wait "issue-<N>" --until working --timeout 60000`. On timeout or a `blocked` state, read the pane (`herdr agent read "issue-<N>" --source recent-unwrapped --lines 60`). If it shows a prompt awaiting input — trust confirmation, onboarding — surface it in the report; never answer prompts for the user. Otherwise record what you see and continue with the remaining issues.

If any step fails for an issue (name collision, dirty state, CLI error), record the issue as failed with the reason and continue with the rest.

## 4. Report

End with a Markdown table — one row per issue: number, title, result (launched / skipped / failed), worktree path, branch, agent name, workspace ID. Under it, list every skip or failure with its reason. Close with: live progress is in the Herdr sidebar; ask me any time for a status check.
