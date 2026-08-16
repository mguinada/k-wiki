---
name: do-gh-issue
description: "Implements one GitHub issue end-to-end: the issue is the primary contract. Discovers the issue's scope and shape, bootstraps Codegraph, assigns the requester, checks blockers, implements with TDD, runs quality gates, and hands off to PR creation. Use this skill whenever the user asks to implement, do, work on, take, finish, or complete an issue — e.g. 'do issue 5', 'implement #6', 'finish https://github.com/mguinada/k-wiki/issues/4' — or references an issue number/URL expecting changes. Also use when the user says 'pick up an issue' without naming one. Do NOT use for merely reading, triaging, labeling, commenting on, or closing an issue, or for creating a PR for already-committed work (that is the create-pr skill alone)."
---

# Do GitHub Issue

Implement exactly one GitHub issue, end-to-end. The issue is the primary
contract: its goal, scope, acceptance criteria, and out-of-scope list define
what "done" means. Your job is to discover the scope and shape of the work
from the issue — not to invent scope the issue does not authorize.

This skill owns the implementation pipeline only. Operations that follow it
are delegated to the skills that own them:

- Committing → `git-commit` skill
- Push / pull request → `create-pr` skill
- GitHub CLI usage patterns → `gh` skill (load it before heavy `gh` work)

## Workflow

### Step 0 — Resolve the target issue

- The user gives an issue number or a full issue URL. Extract the number and
  proceed.
- If the prompt names no issue, list open issues and ask the user to choose.
  Do not pick one yourself:

  ```bash
  gh issue list --limit 30
  ```

### Step 1 — Read the issue carefully

```bash
gh issue view <n> --json number,title,state,body,labels,assignees,blockedBy,blocking,parent,subIssues,url
```

Read the whole body: goal, background, scope checklist, implementation notes,
out-of-scope list, acceptance criteria, referenced docs. The out-of-scope list
binds you as strongly as the scope list does.

If the issue is not open (closed as done, or a duplicate), stop and tell the
user what you found.

### Step 2 — Bootstrap Codegraph before reading any docs or code

Do this before opening any related file. The index changes how you read the
codebase: symbol search, call paths, and impact analysis all go through it.

```bash
codegraph status .
```

- If status says the project is not initialized: `codegraph init .`, then
  confirm with `codegraph status .` again.
- If the index exists but is stale: `codegraph sync .` brings it up to date.

`codegraph init` writes a `.codegraph/` directory. If it is not already
ignored, add it to `.gitignore` as part of this bootstrap step — it is index
data, not source. Do not commit the directory itself.

### Step 3 — Assign the requesting user

```bash
gh issue edit <n> --add-assignee @me
```

This marks the issue as taken before you invest in it.

### Step 4 — Check blocked-by and related relationships

Primary source — the native relationships from Step 1:

```bash
gh issue view <n> --json blockedBy,blocking,parent,subIssues
gh issue view <n> --jq '{blockedBy: [.blockedBy.nodes[] | {number, state, title}], total: .blockedBy.totalCount}'
```

`blockedBy.nodes` is capped at 50; if `totalCount` exceeds the node count,
there are more blockers than you see — fetch them individually.

Fallback — not every repo fills in the native field. Scan the issue body for
text mentions such as `blocked by #123`, `blocked-by: #123`, or a "Blocked
by" line with issue URLs, then check each mentioned issue's state:

```bash
gh issue view <123> --json state,number,title
```

Read `parent`, `blocking`, and `subIssues` for context (an epic's shape, what
waits on this work) — they inform scope but do not block by themselves.

### Step 5 — Stop if blocked or constrained

If any blocker issue is still open, stop. Do not implement. Report:

- which issue blocks this one, with its state and title,
- what must land first, and
- the link to the blocker so the user can act.

The same applies to other unresolved constraints: a scope ambiguity that
changes what you would build, missing acceptance criteria, or a dependency
from Step 7 that the repo does not satisfy. Stop and ask. A wrong
implementation costs more than a question.

### Step 6 — Read the referenced docs and related code

- Read every doc the issue references (in this repo, typically sections of
  `making-of/karpathy_obsidian_wiki_implementation_guide.md`).
- Use Codegraph (`codegraph explore`, `query`, `node`, `impact`) to find and
  read the related code instead of grepping blind.
- Follow the `AGENTS.md` router: work touching `wiki/` falls under the
  `wiki/AGENTS.md` contract; pipeline work falls under the root contract.

### Step 7 — Confirm dependencies in the current repo state

Issues often assume prior work landed. Before implementing, verify the
assumptions: earlier issues in the chain merged and present in the tree,
required packages or config present, fixtures generated. If a dependency is
not satisfied, treat it as a blocker (Step 5).

### Step 8 — Implement end-to-end, within scope

Branch first. If you are on `main`/`master`, create a branch named
`<issue-number>-<slug>` — no prefixes, no suffixes (for issue 5:
`5-test-vault-fixtures`):

```bash
git checkout -b <n>-<slug>
```

If you already sit on a dedicated work branch for this issue (for example
inside a git worktree), use it. Never implement on `main`/`master`, and never
push or merge to `main`.

Then implement with TDD — Red-Green-Refactor. Write the failing test that
expresses the acceptance criteria, make it pass, refactor. Tests come before
implementation code, not after.

Stay inside the issue's scope and acceptance criteria. When the issue affects
public behavior, architecture, policy, deployment, service boundaries, trust
boundaries, or operator workflow, update the documentation in the same change
— a behavior change without its doc change is half a change.

### Step 9 — Run quality gates and E2E tests

Discover the project's gates (package.json scripts, CI config) and run them:
typecheck, lint, the full test suite — and E2E tests when they exist. TDD ran
tests incrementally; this step proves the whole change.

The work is not successful until the relevant checks pass. If a gate fails,
fix it before handing off.

### Step 10 — Verify, prepare the handoff, create the PR

Re-read the acceptance criteria and check each one against the change
honestly. Claims of success must match reality.

Prepare the handoff summary (template below). Then stage the changes and
delegate: invoke the `create-pr` skill — it owns commit, push, and PR. Do not
create the PR by hand; that workflow belongs to `create-pr`.

## Handoff summary

Use this template verbatim:

```markdown
## Handoff — issue #<n>

- **What changed:** …
- **What docs changed:** …
- **What verification was run:** …
- **Remaining risk or follow-up:** …
- **Blockers:** … (or "none — issue completed")
```

## Repository notes

- `raw/` is generated by sync; never hand-edit it. The source vault lives
  outside this repository; never touch it.
- `wiki/AGENTS.md` is never edited during wiki operations — schema changes
  are deliberate human-approved commits.
- One PR per issue. Never push or merge to `main`.
