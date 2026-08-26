---
name: do-gh-issue-v2
description: "EXPERIMENTAL variant of do-gh-issue — copy under iteration; prefer the original do-gh-issue skill. Use this skill only when explicitly requested by name (do-gh-issue-v2 / 'the experimental issue skill')."
---

# Do GitHub Issue

Implement exactly one GitHub issue, end-to-end. The issue is the primary
contract: its goal, scope, acceptance criteria, and out-of-scope list define
"done". This skill owns implementation; commits belong to the `git-commit`
skill, and push and PR go through the no-mistakes gate — driven from a
separate Herdr pane so the pipeline never blocks this agent — then the PR via
`create-pr`. Load the `no-mistakes` skill for the `axi` driving rules, the
`herdr` skill for pane commands, the `gh` skill for CLI patterns; this repo's
gating specifics are in `docs/no-mistakes.md`.

## Workflow

1. Resolve the target issue from the prompt (number or URL); if the prompt names none, list open issues and ask the user to choose — never pick one yourself.
2. Read the issue in full — goal, scope checklist, acceptance criteria, implementation notes, out-of-scope list, referenced docs. If the issue is not open, stop and say so.
3. Check blockers: the native `blockedBy` relationship first, then "blocked by #N" mentions in the issue body; resolve each blocker's state.
4. Stop and report if anything is unresolved — an open blocker, or a scope ambiguity that changes what you would build. Name what blocks, its state and link, and what must land first. Take nothing when stopping: no assignment, no branch.
5. Bootstrap Codegraph before reading any docs or code: check `codegraph status .`, init or sync as needed, and keep `.codegraph/` gitignored.
6. Assign the requesting user to the issue (`--add-assignee @me`) once past the gate — claiming early prevents parallel agents from duplicating the work.
7. Read the referenced docs and the related code, using Codegraph (`explore`, `node`, `impact`) rather than blind search, and following the repository's own `AGENTS.md` instructions where they apply.
8. Confirm the issue's assumed dependencies are satisfied in the current tree (prior issues merged, packages, fixtures); a missing dependency is a blocker.
9. Fetch the repository's default branch and create the working branch and worktree from `origin/<default-branch>` — never from the branch currently checked out. Branch name: `<issue-number>-<slug>`, no prefixes or suffixes.
10. Set the issue's GitHub Projects **Status** to `In progress` — the run is now committed to implementing. Resolve every ID at runtime: find the project containing the issue (`gh project list --owner`, then `gh project item-list <n> --owner <owner>`), read the Status single-select field and its options (`gh project field-list <n> --owner <owner>`), match the option `In progress` case-insensitively, and write it with `gh project item-edit --project-id <p> --id <item> --field-id <status> --single-select-option-id <option>`. Fail open: if the status cannot be read or set (missing `project`/`read:project` token scope, issue not on a board, no matching option), print one warning naming the cause and continue — board state never aborts the implementation.
11. Implement with TDD (Red-Green-Refactor), staying inside the issue's scope and acceptance criteria; when the issue affects public behavior, architecture, policy, deployment, service boundaries, trust boundaries, or operator workflow, update the documentation in the same change.
12. Run the project's quality gates — typecheck, lint, full test suite, E2E tests where they exist — and fix failures; the work is not successful until the relevant checks pass. Then run the advisory checks the repository defines (in this repo: `npm run mutation:changed` before handoff — triage printed survivors per the repo's mutation-triage skill; they are advisory, recorded in the PR body, never blocking).
13. Re-check every acceptance criterion against the change honestly. Do not write the handoff yet — it comes last, after steps 14–17.
14. Commit the implementation via `git-commit` — before the refactor pass, so the refactor changes form their own commit on top.
15. Run the **refactor-change-set pass** on the finished implementation (the procedure of `.pi/prompts/refactor-change-set.md`): load the `refactor`, `typescript`, `design-pattern-adopter`, and `tdd` skills, then review the full change set (`git diff origin/<default-branch>`, uncommitted work included) for refactoring wins, TypeScript issues, applicable design patterns, and test gaps. Adopt only clear benefits; keep changes behavior-preserving; write or strengthen tests first. Re-run the quality gates. Record the adopted and rejected lists — the handoff needs them.
16. Commit the adopted refactor changes via `git-commit` as their own commit — only if the pass adopted something; never create an empty commit.
17. Open the PR, then push through the no-mistakes gate and drive it to an outcome. All pipeline work runs in a separate pane, never in this agent's own shell, so the user can prompt this agent while the pipeline runs:
    - Open the PR first with the `create-pr` skill — it pushes the branch to `origin` and opens the PR whose body carries the handoff summary and `Closes #<n>`. With the pr step skipped the gate never rewrites that body, and every gate fix commit it pushes lands in the open PR.
    - Verify the gate remote (`git remote get-url no-mistakes`); if missing, run `no-mistakes init` first.
    - Open a vertical split beside this pane and push from it — the push itself starts the pipeline non-blocking:
      ```bash
      herdr pane split --current --direction right --cwd "$PWD" --no-focus
      herdr pane run <new-pane-id> "git push no-mistakes <branch-name>"
      ```
      Read the new pane ID from `.result.pane.pane_id`.
    - Drive the run from that same pane in yolo mode — this attaches to the push-started run and auto-resolves every gate (ask-user findings included; that standing consent is granted by this skill). Always pass `--skip pr`: `axi run --intent` suppresses the repo's `push.pushoption` skip, and the pr step rewrites PR bodies, destroying `Closes #N` linkage:
      ```bash
      herdr pane run <new-pane-id> "no-mistakes axi run --intent \"<the issue's goal, in the user's terms>\" --skip pr --yes"
      ```
    - Do **not** block this agent on the run. Check progress with short, non-blocking reads — `herdr pane read <new-pane-id> --source recent-unwrapped --lines 120` — between other steps; steps take minutes and a quiet pane is working, not stalled. If the run is still going when nothing remains to do, end the turn naming the pane ID; write the final handoff once the pane shows `outcome:`.
    - `outcome: checks-passed` or `passed` → gate done; the branch on `origin` now carries any gate fix commits, so pull them back into the worktree: if `no-mistakes axi status` reports `branch_sync.next_action.code: sync`, run `no-mistakes axi sync` (the guarded fast-forward pull); otherwise `git pull --ff-only origin <branch-name>`. `failed` or `cancelled` → follow the `no-mistakes` skill: pull the gate's changes the same way, fix, commit on the same branch, push from the pane again, start a fresh `axi run` (never `no-mistakes rerun` — it cannot skip the pr step and is shim-blocked here). Never leave the run parked at a gate or at a failed outcome.
18. Write the handoff summary as the final action — only after the refactor pass and the pipeline outcome are both known.

## Handoff summary

```markdown
## Handoff — issue #<n>

- **What changed:** …
- **What docs changed:** …
- **What verification was run:** …

### Refactor-change-set

- **Adopted:** … (what changed and why)
- **Rejected:** … (what was skipped and why)

- **Pipeline:** `outcome: <checks-passed|passed|failed>` — PR: <url, opened before gating>
- **Remaining risk or follow-up:** …
- **Blockers:** … (or "none — issue completed")
```
