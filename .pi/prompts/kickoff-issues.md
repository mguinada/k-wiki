---
description: Kick off GitHub issue work in parallel — one kickoff per issue, each invoking a fresh pi main agent in its own Herdr worktree to run the do-gh-issue skill
argument-hint: "[<issue-number> | <issue-URL> | label:<label> ...]"
---

Three roles, never merged:

- **You (host):** run the host-only rules (§1–§2), fan the kickoffs out (§3), collect the reports (§4). You never implement, and you never touch a worktree unless §3's fallback applies.
- **Kickoff performer (one per issue):** performs that issue's whole kickoff — creates the worktree, invokes pi in it (a fresh, independent main agent), submits the `do-gh-issue` work, confirms pickup — then reports one line and ends. Preferably a subagent (Path A); the host itself only if no subagent tool is available (Path B).
- **Main agent (fresh pi instance, one per worktree):** executes the `do-gh-issue` skill end-to-end, alone, for as long as it takes, and reports its final outcome back to your pane.

Spawn the kickoffs as early as possible, and never earlier than safety allows: every host-only rule (§1–§2 — preconditions, issue resolution, confirmation gates, collision snapshot) completes first, then all kickoffs start at once. One issue's stall, block, or failure never delays or cancels another.

## 1. Preconditions (host-only)

1. Verify you run inside Herdr: `test "${HERDR_ENV:-}" = 1`. If it fails, stop and tell the user to run this from a Herdr pane. If it passes, load the `herdr` skill before issuing any `herdr` command.
2. Resolve the repository and default branch: `gh repo view --json nameWithOwner,defaultBranchRef`. Every issue must belong to this repository; if a URL names a different one, stop and ask.
3. `git fetch origin <default-branch>` once.
4. Record your own pane ID (`$HERDR_PANE_ID`) — the main agents' final reports are pushed into your conversation through it.

## 2. Resolve the issue set (host-only)

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
- Snapshot collisions once: `herdr worktree list` plus `git branch --list "issue-<N>-*"` per issue. An issue whose worktree or branch already exists is skipped and recorded with the existing path — never reuse or clobber silently. This snapshot is what makes parallel kickoffs safe: every kickoff gets a branch no other agent will touch.

## 3. Kick off every issue at once

Determine the path first: you have a `subagent` tool and `subagent` with `action: "list"` answers with executable agents → **Path A**. No such tool, or the call errors → **Path B** — say which path you take.

### Path A — one kickoff subagent per issue (preferred)

Launch every kickoff in a single parallel fan-out: one `subagent` tool call with `workflowScript`, `async: true`, one `runs.run` per issue (key `issue-<N>`, agent `delegate`, `isolation: "none"` — the subagents must reach this Herdr session and repository; `timeoutMs: 300000`), then `runs.all`-style collection of their results. Launch all before waiting on any; never run a kickoff step yourself.

Each subagent sees only its task text, so the task is self-contained. Template (fill every placeholder):

> You are the kickoff agent for issue #<N> (<url>) in <nameWithOwner>. Create the worktree, start a fresh pi main agent in it, hand it the implementation work, confirm pickup, and report back. Steps:
>
> 1. `herdr worktree create --cwd "$PWD" --branch "issue-<N>-<slug>" --base "origin/<default-branch>" --no-focus` — the worktree directory takes the branch name. Parse the workspace, tab, and pane IDs from the JSON response; never guess them.
> 2. `herdr agent start "issue-<N>" --kind pi --pane <pane-id>` — this invokes pi in the worktree pane: the fresh main agent.
> 3. Submit the work without `--wait`:
>
>    `herdr agent prompt "issue-<N>" "Read .agents/skills/do-gh-issue/SKILL.md and execute it end-to-end for issue #<N>: <url>. Two adjustments: (1) its step 9 is already done — you are in the worktree <worktree-path> on branch issue-<N>-<slug>, based on origin/<default-branch>; do not create another branch or worktree. (2) As your final action, report your outcome to the host agent: herdr agent prompt <host-pane-id> \"issue #<N>: <PR URL, or the reason the run stopped>\" — if that command fails because the host pane no longer hosts an agent, print the same line in your own transcript instead. Report whether you finish, stop on a blocker, or fail."`
>
> 4. Confirm pickup: `herdr agent wait "issue-<N>" --until working --timeout 60000`. On timeout or a `blocked` state, read the pane (`herdr agent read "issue-<N>" --source recent-unwrapped --lines 60`) and record what you see — if it is a prompt awaiting input (trust confirmation, onboarding), record that. Never answer prompts for the user. Never touch another issue's worktree, pane, or agent.
> 5. Report back: return exactly one line — `#<N> | launched | <worktree-path> | issue-<N>-<slug> | issue-<N> | <workspace-id>` or `#<N> | failed | <reason>`. Your job ends at confirmed pickup; do not wait for the main agent to finish its work.

A subagent that fails or times out is recorded as failed for its issue only — no fallback kickoff for that issue, no effect on the others. When the fan-out returns, merge the lines and go to §4.

### Path B — host runs each kickoff itself (only without a subagent tool)

For each surviving issue, in the user's order, run the same five steps as the template above (steps 1–4; step 5 becomes your own bookkeeping line). Submit the kickoff prompt without `--wait` and move straight to the next issue — no wait, check, or confirmation may sit between two kickoffs. Only after the last kickoff, confirm pickups: per issue `herdr agent wait "issue-<N>" --until working --timeout 60000`; on timeout or `blocked`, read the pane and record what you see; never answer prompts for the user. A failure at any step records that issue as failed and the run continues with the rest.

## 4. Collect and report

Merge the kickoff results into a Markdown table — one row per issue: number, title, result (launched / skipped / failed), worktree path, branch, agent name, workspace ID; include §2's skips. Under the table, list every skip or failure with its reason. Close with: live progress is in the Herdr sidebar; each main agent reports its final outcome back to this pane and I relay it to you; ask me any time for a status check.
