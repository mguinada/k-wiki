---
name: do-gh-issue
description: "Implements one GitHub issue end-to-end: the issue is the primary contract. Discovers the issue's scope and shape, bootstraps Codegraph, assigns the requester, checks blockers, implements with TDD, runs quality gates, and hands off to PR creation. Use this skill whenever the user asks to implement, do, work on, take, finish, or complete an issue — e.g. 'do issue 5', 'implement #6', 'finish https://github.com/mguinada/k-wiki/issues/4' — or references an issue number/URL expecting changes. Also use when the user says 'pick up an issue' without naming one. Do NOT use for merely reading, triaging, labeling, commenting on, or closing an issue, or for creating a PR for already-committed work (that is the create-pr skill alone)."
---

# Do GitHub Issue

Implement exactly one GitHub issue, end-to-end. The issue is the primary
contract: its goal, scope, acceptance criteria, and out-of-scope list define
"done". This skill owns implementation only — commits belong to the
`git-commit` skill, push and PR to `create-pr`; load the `gh` skill for CLI
patterns.

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
10. Implement with TDD (Red-Green-Refactor), staying inside the issue's scope and acceptance criteria; when the issue affects public behavior, architecture, policy, deployment, service boundaries, trust boundaries, or operator workflow, update the documentation in the same change.
11. Run the project's quality gates — typecheck, lint, full test suite, E2E tests where they exist — and fix failures; the work is not successful until the relevant checks pass.
12. Re-check every acceptance criterion against the change honestly, write the handoff summary, then delegate the finish: `git-commit` for the commit, `create-pr` for push and PR.

## Handoff summary

```markdown
## Handoff — issue #<n>

- **What changed:** …
- **What docs changed:** …
- **What verification was run:** …
- **Remaining risk or follow-up:** …
- **Blockers:** … (or "none — issue completed")
```
