---
description: Kick off GitHub issue work in parallel — one kickoff per issue, each invoking a fresh pi main agent in its own Herdr worktree to run the do-gh-issue skill
argument-hint: "[<issue-number> | <issue-URL> | label:<label> ...]"
---

Three roles, never merged: **you (host)** run the host-only rules (§1–§2), fan the kickoffs out (§3), and collect the reports (§4) — never implement, never touch a worktree unless the §3 fallback applies. **Kickoff performer (one per issue)** runs that issue's whole kickoff — worktree, fresh pi main agent, work submission, pickup confirmation — then reports one line and ends; preferably a subagent (Path A), the host itself only without a subagent tool (Path B). **Main agent (fresh pi, one per worktree)** executes the `do-gh-issue` skill end-to-end alone and pushes its final outcome back to your pane.

Kick off as early as possible, never earlier than safety allows: §1–§2 complete first, then all kickoffs start at once. One issue's stall, block, or failure never delays or cancels another.

## 1. Preconditions (host-only)

1. Verify Herdr: `test "${HERDR_ENV:-}" = 1`. On failure stop and tell the user to run this from a Herdr pane; on success load the `herdr` skill before any `herdr` command.
2. Resolve repo and default branch: `gh repo view --json nameWithOwner,defaultBranchRef`. A URL naming a different repository → stop and ask.
3. `git fetch origin <default-branch>` once.
4. Record your own pane ID (`$HERDR_PANE_ID`) — the address the main agents report their outcomes to.

## 2. Resolve the issue set (host-only)

Criteria supplied by the user (may be empty): $ARGUMENTS

- Bare number or `#N` → `gh issue view <N>`; issue URL → `gh issue view <url>`; `label:<name>`, `tag:<name>`, or "all issues labeled X" → `gh issue list --state open --label <name> --json number,title,url`.
- Keep only `OPEN` issues (record non-open ones as skipped, with state); deduplicate by number; keep the user's order.
- No criteria → list open issues and ask the user to choose — never pick yourself. An argument you cannot resolve unambiguously → ask. An empty set after resolution → report and create nothing.
- More than 8 issues resolved → show the list and confirm before creating anything.
- Per surviving issue derive the slug (kebab-case, 3–5 words); branch name `issue-<N>-<slug>`.
- Snapshot collisions once: `herdr worktree list` plus `git branch --list "issue-<N>-*"` per issue. An existing worktree or branch → skip that issue, record the existing path — never reuse or clobber. (This snapshot is what makes the parallel fan-out safe.)

## 3. Kick off every issue at once

Determine the path first — `subagent` tool present and `action: "list"` answers with executable agents → **Path A**; no tool or the call errors → **Path B**. Say which path you take.

### Path A — one kickoff subagent per issue (preferred)

Launch every kickoff in a single parallel fan-out — one `subagent` call (`workflowScript`, `async: true`), one `runs.run` per issue (key `issue-<N>`, agent `delegate`, `isolation: "none"` — the subagents must reach this Herdr session and repository — `timeoutMs: 300000`) — all launched before any is awaited; never run a kickoff step yourself.

Each subagent sees only its task text, so the task is self-contained. Template (fill every placeholder):

> You are the kickoff agent for issue #<N> (<url>) in <nameWithOwner>. Create the worktree, start a fresh pi main agent in it, hand it the implementation work, confirm pickup, and report back. Steps:
>
> 1. `herdr worktree create --cwd "$PWD" --branch "issue-<N>-<slug>" --base "origin/<default-branch>" --no-focus` — the worktree directory takes the branch name. Parse the workspace, tab, and pane IDs from the JSON response; never guess them.
> 2. `herdr agent start "issue-<N>" --kind pi --pane <pane-id>` — this invokes pi in the worktree pane: the fresh main agent.
> 3. Submit the work without `--wait`:
>
>    `herdr agent prompt "issue-<N>" "Read .agents/skills/do-gh-issue/SKILL.md and execute it end-to-end for issue #<N>: <url>. Two adjustments: (1) its step 9 is already done — you are in the worktree <worktree-path> on branch issue-<N>-<slug>, based on origin/<default-branch>; do not create another branch or worktree. (2) As your final action, report to the host agent: herdr agent prompt <host-pane-id> \"issue #<N>: <PR URL, or the reason the run stopped>\" — if that fails, print the same line in your own transcript. Report whether you finish, stop on a blocker, or fail."`
>
> 4. Confirm pickup: `herdr agent wait "issue-<N>" --until working --timeout 60000`. On timeout or `blocked`, read the pane (`herdr agent read "issue-<N>" --source recent-unwrapped --lines 60`) and record what you see — a prompt awaiting input (trust confirmation, onboarding) is recorded, never answered. Never touch another issue's worktree, pane, or agent.
> 5. Report exactly one line — `#<N> | launched | <worktree-path> | issue-<N>-<slug> | issue-<N> | <workspace-id>` or `#<N> | failed | <reason>`. Your job ends at confirmed pickup; do not wait for the main agent.

A subagent that fails or times out is failed for its issue only — no fallback kickoff, no effect on the others. When the fan-out returns, merge the lines and go to §4.

### Path B — host runs each kickoff itself (only without a subagent tool)

For each surviving issue, in the user's order, run the template's steps 1–4 yourself (step 5 becomes your bookkeeping line). Submit the kickoff prompt without `--wait` and move straight to the next issue — no wait, check, or confirmation between kickoffs. Only after the last kickoff, confirm pickups: per issue `herdr agent wait "issue-<N>" --until working --timeout 60000`; on timeout or `blocked`, read the pane and record; never answer prompts for the user. A failure at any step records that issue as failed and the run continues.

## 4. Collect and report

Merge the kickoff results into a Markdown table — one row per issue: number, title, result (launched / skipped / failed), worktree path, branch, agent name, workspace ID; include §2's skips. Under it, list every skip or failure with its reason. Close with: live progress is in the Herdr sidebar; each main agent reports its final outcome back to this pane and I relay it to you; ask me any time for a status check.
