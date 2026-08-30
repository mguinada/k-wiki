---
name: do-gh-issue
description: "Implements one GitHub issue end-to-end: the issue is the primary contract. Discovers the issue's scope and shape, bootstraps Codegraph, assigns the requester, checks blockers, implements with TDD, runs quality gates and the refactor-change-set pass, then pushes through the no-mistakes gate from a separate Herdr pane, acceptance-tests the change on the topic branch before recommending merge, and hands off with a pre-merge acceptance report plus post-merge deployment steps. Use this skill whenever the user asks to implement, do, work on, take, finish, or complete an issue — e.g. 'do issue 5', 'implement #6', 'finish https://github.com/mguinada/k-wiki/issues/4' — or references an issue number/URL expecting changes. Also use when the user says 'pick up an issue' without naming one. Do NOT use for merely reading, triaging, labeling, commenting on, or closing an issue, or for creating a PR for already-committed work (that is the create-pr skill alone)."
---

# Do GitHub Issue

Implement exactly one GitHub issue, end-to-end. The issue is the primary
contract: its goal, scope, acceptance criteria, and out-of-scope list define
"done". This skill owns implementation; commits belong to the `git-commit`
skill; the PR opens via `create-pr`, then the branch goes through the
no-mistakes gate — driven from a separate Herdr pane so the pipeline never
blocks this agent — and once the gate is green the change is acceptance-tested
on the topic branch before the handoff recommends merge, so `main` never
receives a bug acceptance could have caught. Load the `no-mistakes` skill for the `axi` driving rules, the
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
12. Run the project's quality gates — typecheck, lint, full test suite, E2E tests where they exist — and fix failures; the work is not successful until the relevant checks pass. Then run the advisory checks the repository defines (in this repo: the dev-loop mutation run is optional — see AGENTS.md's mutation section; when run and it prints survivors, triage them per the repo's mutation-triage skill; they are advisory, recorded in the PR body, never blocking — CI files survivors into the rolling issue).
13. Re-check every acceptance criterion against the change honestly. Do not write the handoff yet — it comes last, after steps 14–18.
14. Commit the implementation via `git-commit` — before the refactor pass, so the refactor changes form their own commit on top.
15. Run the **refactor-change-set pass** on the finished implementation (the procedure of `.pi/prompts/refactor-change-set.md`): load the `refactor`, `typescript`, `design-pattern-adopter`, and `tdd` skills, then review the full change set (`git diff origin/<default-branch>`, uncommitted work included) for refactoring wins, TypeScript issues, applicable design patterns, and test gaps. Adopt only clear benefits; keep changes behavior-preserving; write or strengthen tests first. Re-run the quality gates. Record the adopted and rejected lists — the handoff needs them.
16. Commit the adopted refactor changes via `git-commit` as their own commit — only if the pass adopted something; never create an empty commit.
17. Open the PR, then push through the no-mistakes gate and drive it to an outcome. Run this whole step from the issue worktree's cwd (`$PWD`). The pane path requires Herdr — check `test "${HERDR_ENV:-}" = 1` first; if it fails, warn the user and drive the gate blocking in your own shell instead — push with the same base64 intent and skip push options, then `no-mistakes axi run --skip pr --yes` (non-interactive TOON; the TUI dashboard needs a real terminal pane). All pipeline work runs in a separate pane, never in this agent's own shell, so the user can prompt this agent while the pipeline runs:
    - Open the PR first with the `create-pr` skill — it pushes the branch to `origin` and opens the PR. Its body carries the pre-run summary (what changed, docs, verification, the refactor adopted/rejected lists) and an uncommented `Closes #<n>` line — not the final handoff, which step 19 writes. With the pr step skipped the gate never rewrites that body, and every gate fix commit it pushes lands in the open PR.
    - Verify the gate remote (`git remote get-url no-mistakes`); if missing, run `no-mistakes init` first.
    - Open a vertical split beside this pane — it runs the **TUI dashboard**, not TOON text, so the user watches every pipeline step live. Push with intent and skip as push options — the gate base64-**decodes** `no-mistakes.intent`, so the intent must be base64-encoded (plain text fails the hook: no pipeline starts); and passing any `-o` suppresses the repo's `push.pushoption`, so the skip rides explicitly too (the pr step must be skipped: it rewrites PR bodies, destroying `Closes #N` linkage). Wait for the pipeline start, then attach the dashboard:
      ```bash
      herdr pane split --current --direction right --cwd "$PWD" --no-focus
      herdr pane run <new-pane-id> "git push no-mistakes <branch-name> -o no-mistakes.intent=$(printf %s '<issue #<n> title>: <full issue body — goal, acceptance criteria, out-of-scope — verbatim but flattened to one line, newlines → semicolons — plus the implementation decisions and tradeoffs a diff-reviewer would not know>' | base64) -o no-mistakes.skip=pr"
      herdr pane wait-output <new-pane-id> --match "Pipeline started" --timeout 120000
      herdr pane run <new-pane-id> "no-mistakes attach"
      ```
      Read the new pane ID from `.result.pane.pane_id`. Never rely on no-mistakes inferring the intent from transcripts — slower, flakier, and the implementing session lives in a different worktree.
    - Drive the run from the dashboard in unattended mode. `y` is a **toggle** with no `axi status` exposure — the pane footer is the only state indicator (`y yolo` = off, `y end yolo` = on) — so send it only with verification, never blind: when `axi status` (own shell — the daemon's TOON, never the pane transcript, which repo content could spoof) reports the first step parked awaiting approval, read the footer (`herdr pane read <new-pane-id> --source recent-unwrapped --lines 3`); if it shows `y yolo`, send the key with `herdr pane send-keys <new-pane-id> y` (a `pane run` sends a shell command line the TUI never receives as a keypress — it cannot drive the dashboard) and confirm the footer now reads `end yolo`. Engaged yolo auto-resolves every subsequent gate — fixes actionable findings (ask-user included; consent granted by the user's instruction to run this skill unattended), approves fix-reviews and no-op gates — so after engagement only poll `axi status`; send no further keys. If a later poll shows a parked gate while the footer reads `y yolo` (off — e.g. the pane was recreated), repeat the verify-then-send-keys once. If the dashboard pane is gone, re-split, re-attach, and re-engage; blocking `axi respond --yes` from your own shell is the last resort. Loop `axi status` until the terminal `outcome:`.
    - Do **not** block this agent on the run. Check progress with short, non-blocking `axi status` calls between other steps; steps take minutes and a quiet run is working, not stalled. If the run is still going when nothing remains to do: end the turn with an interim handoff marked **pipeline pending**, naming the gate pane ID. On the next user prompt, re-check and finish the steps below once terminal.
    - Terminal state, confirmed via `no-mistakes axi status`: `outcome: checks-passed` or `passed` → gate done; the branch on `origin` now carries any gate fix commits. Bring them back into the worktree by the `branch_sync.next_action.code` that same call reports: `sync` → `no-mistakes axi sync`; `recover_custody` → `no-mistakes axi sync --recover`; `continue_active_run` → keep driving the run, make no local commits; `user_owned` or no sync offered → `git pull --ff-only origin <branch-name>`. `outcome: failed` or `cancelled` → follow the `no-mistakes` skill: sync the gate's changes the same way, fix, commit on the same branch, push from the pane again with the same `-o` options, re-attach (`no-mistakes attach`), and re-engage yolo per the verify-then-toggle protocol (never `no-mistakes rerun` — it cannot skip the pr step and is shim-blocked here). Never report done with the run parked at a gate or at a failed outcome.
18. Run the **acceptance-testing phase** on the topic branch — after the gate reports `checks-passed`/`passed`, before any merge recommendation. What gets exercised is the exact head proposed for merge, so a bug acceptance finds never reaches `main`. The phase generalizes the four-step sequence validated during issue #126 (live read-only checks → baseline → clone rehearsal → verdict); the concrete commands below are this repo's wiki instances of it. In order:
    - **Read-only live checks first.** Exercise the change against the real surfaces the automated suites do not cover — the live data repo, the real vault, operator workflows — preferring, in order: read-only modes (`--print`, dry-run defaults, `check-*`, `health`), synthetic fixtures the agent generates, and clones of operator-owned state. Never mutate operator-owned state during acceptance.
    - **Baseline before any write.** Capture a baseline of the relevant coherence checks before the change's write path runs anywhere, so any later failure is attributable to the change and not to pre-existing state.
    - **Dress rehearsal of every write path.** Rehearse each write path the change ships at least once on a clone or a dummy produced by the agent for testing — a temp `git clone` of the data repo, or a synthetic wiki from the repo's fixture generators (e.g. `generateFixtureVault` in `src/fixtures/generate.ts`). On the rehearsal copy verify idempotency (re-run the write; expect no further change), safety refusals (dirty tree, missing dirs), and audit trails.
    - **Verdict.** All green → the handoff (step 19) may recommend review and merge. Any failure → fix on the same branch, commit, re-run the gate (step 17 push protocol), and re-run this phase from the top. Never recommend merge on a red or partial acceptance run; a check that could not run counts as not green — name it and either run it or withhold the claim.

    Wiki-safety rules (fixed semantics — operator-owned content is never put at risk by the acceptance process itself):
    - The acceptance process must not commit or write the live wiki before it has checked the wiki's state with read-only checks and rehearsed the write path on a copy. A buggy run must not be able to damage wiki content.
    - Live-data writes during acceptance are forbidden unless the operator explicitly directs one; the real write belongs to post-merge deployment work, listed as a separate handoff section.
19. Write the final handoff as the last action — only after the refactor pass, the terminal pipeline outcome, and a green acceptance phase are all known. Note in it that the PR is ready for human review and merge — a claim conditional on the acceptance phase being green — and that with the pr step skipped the gate does not monitor CI. The handoff carries the acceptance results as a table (check → result). End the handoff with the **Post-merge deployment steps** block: only actions that genuinely cannot run pre-merge (data-repo operations that require merged `main` — e.g. the live write of a migration the phase rehearsed on a clone); anything runnable on the topic branch belongs to the acceptance phase the agent already ran, never to this block. After the handoff, offer to walk the user through the items interactively, step by step — **Step 1, Step 2, …**, one action per step, each with a concise but complete explanation (which filesystem path, which exact command, which git branch of the implementation it must run on, plus any other context the step needs), delivered as the user works through them; where the agent can run an operation itself, offer to do so.

## Handoff summary

```markdown
## Handoff — issue #<n>

- **What changed:** …
- **What docs changed:** …
- **What verification was run:** …

### Refactor-change-set

- **Adopted:** … (what changed and why)
- **Rejected:** … (what was skipped and why)

- **Pipeline:** `outcome: <checks-passed|passed|failed|cancelled>` — PR: <url> (on checks-passed/passed with acceptance green: ready for human review/merge — merge-ready only while the acceptance table below is green; the gate does not monitor CI)
  - Interim variant while the run is live: `- **Pipeline:** pending — gate pane <pane-id>; final handoff on the next prompt after the terminal outcome.`
- **Remaining risk or follow-up:** …
- **Blockers:** … (or "none — issue completed")

### Pre-merge acceptance results (run by the agent on the topic branch)

| Check | Result |
| --- | --- |
| <read-only live check / baseline / dress-rehearsal step> | <pass/fail + one-line evidence> |

A check that could not run counts as not green: name it under Remaining risk and withhold the merge-ready claim.

### Post-merge deployment steps

Only actions that genuinely cannot run pre-merge — data-repo operations that require merged `main` (e.g. the live write of a migration the acceptance phase rehearsed on a clone). One numbered step per action:

1. **Step 1 —** <action> (<filesystem path, exact command, git branch, and any further context: env vars, pane, worktree, data repo> — agent can run it: yes/no>)
2. **Step 2 —** …

If nothing genuinely requires merged `main`, state "none — nothing blocks on the merge beyond review itself".

Then offer: guide the user through these steps interactively, one at a time, and run the steps the agent can run on the user's go-ahead.
```
