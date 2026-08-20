# k-wiki

An LLM-maintained knowledge wiki, derived from a human-owned Obsidian vault.

`k-wiki` implements the [Karpathy-style LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: a personal Obsidian vault remains the human-owned source of truth. Notes sync into an immutable `raw/` projection unless they opt out with `wiki: false`; an LLM agent then builds and maintains a structured, interlinked wiki under `wiki/`. Both trees are disposable derived data — versioned in a separate data repo placed by `sync.json`'s `dataRoot` (guide §19), auditable by diff, and publishable to all devices as a read-only mirror. This repository holds the pipeline and the directory skeleton only; the contents of `raw/` and `wiki/` are gitignored here.

## Core invariant

```text
Human → source vault
Sync  → raw/
LLM   → wiki/
```

Never let that direction reverse.

## Status

Stage 1 implementation is underway; code lands sequentially through the [Stage 1 epic (#2)](https://github.com/mguinada/k-wiki/issues/2).

## In this repository

| Path | What it is |
|---|---|
| `making-of/karpathy_obsidian_wiki_implementation_guide.md` | The implementation guide — spec of record, including the target repository layout (§6) |
| `AGENTS.md` / `wiki/AGENTS.md` | The two agent contexts ([issue #3](https://github.com/mguinada/k-wiki/issues/3)) |

## Working in this repo (humans and agents)

This repository hosts two agent contexts with deliberately different permissions:

- **Wiki operations** (ingest, lint, query) follow `wiki/AGENTS.md`.
- **Pipeline development** (scripts, config, tests) follows the root `AGENTS.md`.

See [Two Agent Contexts](making-of/karpathy_obsidian_wiki_implementation_guide.md#1-two-agent-contexts) in the guide before doing either.

## The pipeline

One cycle, vault to reviewed wiki — each step a repo command:

```text
Obsidian vault            sync-vault                wiki-ingest               review & commit
(human-owned,   ──►  raw/ projection  ──►  wiki/ updated by  ──►  read the digest,   ──►  git diff +
 outside repo)       (deterministic,       the agent (LLM,          then the git diff       commit in the
                      no LLM)               per settings.yml,        in the data repo        data repo
                                            contract wiki/AGENTS.md)
```

1. **Sync** — `npm run sync-vault`: project every vault note not
   blocked by `wiki: false` into `raw/` and update `raw/manifest.json`
   ([details](#running-the-sync)).
2. **Ingest** — `npm run wiki-ingest`: diff the manifest against the
   last successful ingest, run the agent over the changed sources, and
   write the digest ([details](#running-the-wiki-agent-wiki-ingest)).
3. **Review** — read the digest (`outputs/runs/<timestamp>.md`, also on
   stdout), then the `git diff` it summarizes, in the data repo.
4. **Commit** — commit the data repo, so the next digest covers only
   its own run.

`raw/` and `wiki/` contents live in the data repo at `sync.json`'s
`dataRoot`; this repo holds the pipeline and the skeleton only.
Today steps 1–4 are separate commands (issue #13 will chain them,
#12 adds guardrails, #14 scheduling).

## Tooling

The pipeline is TypeScript on Node.js (ESM). Node ≥ 22.18 runs the `.ts`
sources directly, so there is no build step — install dependencies with
`npm install` and run the commands below.

| Command | Tool | Purpose |
|---|---|---|
| `npm run typecheck` | tsc | Type-check `src/` and `tests/` without emitting code |
| `npm run lint` | Biome | Lint and verify formatting across the repo |
| `npm run format` | Biome | Rewrite files to the canonical format — the fix command for lint findings, not a gate |
| `npm test` | vitest | Run the unit test suite |
| `npm run test:coverage` | vitest | Run the unit tests and fail below the 90% coverage thresholds — what CI runs |
| `npm run e2e` | vitest | Run the end-to-end suite (`tests/e2e/`): real CLI child processes — sync-vault through a full vault lifecycle (first run, no-op re-run, edit, delete, block flip, multi-vault) against the synthetic fixture vault in temp workspaces under `.e2e-tmp/` (gitignored), plus wiki-ingest through first-run, incremental, skip, failure, and timeout runs against a stub agent in temp data repos |
| `npm run health [-- <raw-dir>]` | health CLI | Check the coherence of a `raw/` projection (default: the repo's `raw/`): every `raw/notes/<vault>/` file matches its `manifest.json` sha-256, with no orphans and no missing entries; read-only, no vault access; exit 0 = coherent (including healthy-empty), exit 1 = one line per problem |
| `npm run check-links [-- <wiki-dir>]` | wikilink checker | Check that every `[[wikilink]]` under `wiki/` (default) resolves to an existing page by file name; exit 0 = all links resolve, exit 1 = one `file:line -> [[link]]` line per broken link |
| `npm run fixtures -- <dir>` | fixture generator | Write the synthetic Obsidian test vault to `<dir>/Documents` |
| `npm run sync-vault -- [--dry-run] [<sync.json>] [<raw-dir>]` | sync CLI | Ingest every note not blocked by the vault's exclusion rule into `raw/notes/` (deterministic, no LLM; [details below](#running-the-sync)) |
| `npm run wiki-ingest -- [-h \| --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]` | ingest wrapper | Run the wiki agent headless over the sources that changed since the last ingest and write the per-run digest (reads `settings.yml`; [details below](#running-the-wiki-agent-wiki-ingest)) |
| `npm run data:init -- [<sync.json>]` | data repo seeder | Create and seed the data repo at `sync.json`'s `dataRoot`: git init, copy the `raw/`+`wiki/` skeleton from the code repo, first commit; idempotent |
| `npm run mutation:changed` | StrykerJS | Advisory mutation run scoped to `src/` files changed vs `main` (uncommitted included); exits 0 without running when none changed, and ends by printing the actionable mutants — the default pre-handoff step |
| `npm run mutation:changed -- --full` | StrykerJS | Advisory mutation run over all of `src/`, not just changed files; same printed summary |
| `npm run mutation:survivors` | triage helper | Re-list the actionable mutants from the last report — no run, instant |
| `npm run mutation` | StrykerJS | Raw full Stryker run without the printed summary — prefer the two above |

Type check, lint, and unit tests are quality gates: every change passes
them before it is done. CI (`.github/workflows/ci.yml`) enforces the same
gates on every pull request, testing each PR's merge commit against
`main`, with a 90% coverage floor on unit tests.

Every CLI above also answers `-h` / `--help` with its usage line, every
switch explained, defaults, and exit 0 with no side effects.

Verification has three layers:

| Layer | Commands | Status |
|---|---|---|
| Gates | `npm run typecheck`, `npm run lint`, `npm test` | blocking — every change, every PR |
| End-to-end | `npm run e2e`, `npm run health` | blocking — CI's `e2e` job on every PR; required locally when a change touches the sync, ingest, or CLI layers (exact trigger list in [AGENTS.md](AGENTS.md)) |
| Mutation | `npm run mutation:changed` | advisory — a signal, never a gate ([below](#mutation-testing)) |

The e2e suites drive the real CLIs — sync-vault against the synthetic
fixture vault, wiki-ingest against a stub agent in a temp data repo;
the health check verifies that a `raw/` projection is internally
consistent without the real vault. Both are deterministic and fast, so
they gate CI like the unit tests do — unlike mutation testing, whose
runtime grows with the suite.

### Renaming or removing a vault

Sync prunes what the config no longer names: edit the vault's `name` (or
delete its entry) in `sync.json`, then re-run `npm run sync-vault` — the
old `raw/notes/<name>/` tree and its `manifest.json` section are deleted
automatically, and the removal shows in the report as
`- <name>/ (stale namespace, not configured)`.

Two safety properties hold:

- A config with an empty `vaults` array prunes nothing — a truncated or
  mis-edited `sync.json` can never wipe the projection.
- `raw/` is disposable derived data versioned in the data repo: if a
  prune is ever wrong, `git revert` (or `git restore`) in the data repo
  brings the previous projection back.

Wiki pages whose `sources:` frontmatter cites the old `notes/<name>/…`
path still need updating after a rename; that is wiki maintenance under
`wiki/AGENTS.md`, not part of the sync run.

### Mutation testing

Green tests do not prove that the tests assert real behavior. Mutation
testing checks that: StrykerJS injects deliberate faults (mutants) into
`src/` code and verifies that the unit test suite fails for each one. A
surviving mutant means no test can tell the faulty code from the correct
code — a weak spot in the suite. A no-coverage mutant means no test even
reaches the line. Mutation testing is an **advisory signal, not a gate**:
its runtime grows with the suite (`mutants × tests`), so it never blocks
a merge.

#### The workflow

Every run command ends by printing the actionable mutants — the
Survived and NoCoverage entries — so one command is the whole check:

```text
$ npm run mutation:changed
Actionable mutants (2) — kill or record as equivalent:
  Survived  src/sync/config.ts:7  ConditionalExpression
  Survived  src/sync/frontmatter.ts:33  BlockStatement
```

An empty list (`No actionable mutants — nothing survived, nothing
uncovered.`) means the suite holds: nothing to triage.

A non-empty list is handled by the
[mutation-triage](.agents/skills/mutation-triage/SKILL.md) skill, which
loops over each mutant and either kills it with a new or stronger test
or records it as an equivalent mutant in the PR body.

You do **not** run a script first and then invoke the skill — the skill
re-runs the mutation itself if the report is stale. Two ways in:

- **Agent, mid-issue (the normal path):** `AGENTS.md` requires the agent
  to run `npm run mutation:changed` before declaring work complete; if
  the run prints survivors, the agent loads the triage skill and works
  the list in the same session.
- **Human, any time:** run `npm run mutation:changed` (or re-list the
  last report with `npm run mutation:survivors`), then tell the agent
  `triage the survivors`.

The scope rides on the prompt — one phrase runs and triages in one go:

| You say | Agent runs |
|---|---|
| `triage the survivors` | `npm run mutation:changed` — diff scope (files changed vs `main`), the default |
| `triage the full mutation run` / `run mutation across all of src and triage` | `npm run mutation:changed -- --full` — every file under `src/` |

Any mention of "survivors" or "mutation triage" loads the skill; the
word **full** (or its absence) picks the mode.

Reports land in `reports/mutation/` (gitignored): `mutation.html` shows
each mutant's original → replacement diff; `mutation.json` is the
machine-readable source the triage skill and `mutation:survivors` read.
Runs are incremental — results are reused from
`reports/stryker-incremental.json`, so repeat runs cost seconds, not
minutes.

In CI, the mutation job runs only when a pull request carries the
[`mutation`](https://github.com/mguinada/k-wiki/labels) label, nightly on
`main`, or via manual workflow dispatch — never as a blocking check. Its
HTML report is uploaded as an artifact (7-day retention). The agent
rules are in [AGENTS.md](AGENTS.md).

`stryker.config.json` keeps `tsconfig.json` out of the sandbox
(`ignorePatterns`): the repo runs TypeScript 7 (native), whose package
ships no JavaScript compiler API, which Stryker's sandbox tsconfig
rewrite still requires (upstream: stryker-js#6111). Vitest compiles via
esbuild and needs no tsconfig. Revisit when Stryker supports TypeScript 7.

The fixture generator produces a deterministic fake vault — fixed bytes,
no timestamps — covering every case the sync layer must handle (selected,
excluded, edited, deleted, and noise files). A checked-in snapshot lives at
`tests/fixtures/Documents/`; regenerate it with
`npm run fixtures -- tests/fixtures` after changing the generator. Never
edit the snapshot by hand.

`sync.json` at the repo root is the human-owned placement configuration:
which vaults to sync, where the data repo lives (`dataRoot`), and where to
publish the mirror (guide §26). The
`publish` section is parsed but unused until the mirror lands. Sync state —
hashes and timestamps — lives in `raw/manifest.json`, keyed per vault
namespace (guide §25). Sync is idempotent: a run with no source changes
copies, removes, and writes nothing.

## Running the sync

```sh
npm run sync-vault -- [--dry-run] [<sync.json>] [<raw-dir>]
```

Examples:

```sh
npm run sync-vault -- --dry-run          # defaults: repo sync.json, dataRoot raw dir
npm run sync-vault -- --dry-run my.json  # custom config, default raw dir
npm run sync-vault                        # real sync, all defaults
npm run sync-vault -- my.json /tmp/raw    # custom config and raw dir
```

Arguments:

| Argument | Default | Meaning |
|---|---|---|
| `--dry-run` | off | List what **would** be ingested; write nothing (no `raw/` files, no manifest read or write). Flag position is free. |
| `<sync.json>` | repo's `sync.json` | Config naming the vaults and their exclusion rules |
| `<raw-dir>` | `<dataRoot>/raw`, else the repo's `raw/` | Destination for `notes/` and `manifest.json` |

Live progress goes to stderr, the report to stdout. On a terminal
(TTY, color enabled) the scan and read heartbeats share one animated
status line — a braille spinner plus the sentence — rewritten in
place; piped, redirected, CI, or `NO_COLOR` runs get plain appended
lines instead (read heartbeat every 500 files by default).

### What gets ingested

A note syncs **unless** its frontmatter blocks it. The rule comes from
each vault's `exclude` field (`"exclude": "wiki:false"`):

| Frontmatter | Ingested? |
|---|---|
| `wiki: false` | no |
| `wiki: "false"` (quoted — web clipper style) | no |
| `wiki: true` | yes |
| property absent or blank | yes |
| no frontmatter at all | yes |

A `wiki: false` line in the note **body** never blocks. Configs still
using the old `select` field fail with a migration error: replace it
with `exclude`.

### First sync after switching to opt-out

The failure direction under opt-out is a **leak, not a loss**: a private
note nobody blocked lands in `raw/` and git history. Review first:

1. `npm run sync-vault -- --dry-run` — read the would-ingest list.
2. Add `wiki: false` to any note that must stay private.
3. Re-run the dry run until the list is clean.
4. Run `npm run sync-vault` for real; check `npm run health` after.

## Running the wiki agent (`wiki-ingest`)

```sh
npm run sync-vault   # 1. sync the vault into raw/
npm run wiki-ingest  # 2. run the agent headless, digest the run
```

`wiki-ingest` is the unattended ingest step (guide §18, issue #11). It
reads `raw/manifest.json`, diffs it against the snapshot from the
previous successful run (`outputs/last-ingested-manifest.json`), and
runs the agent non-interactively **in the data repo root** — `prompts/ingest.md`
for the first run, `prompts/incremental.md` with the changed sources
(`+` added, `~` changed, `-` removed) appended for every later one. The
agent itself follows `wiki/AGENTS.md`, never touches `raw/`, and gets
30 minutes (override with `--timeout <seconds>`); while it runs, one
animated status line — a braille spinner plus the elapsed time — is
rewritten in place on the terminal (a 10-per-second heartbeat, no
invented ETA: the agent emits its output only at completion); piped,
redirected, CI, or `NO_COLOR` runs get one plain heartbeat line per 60
seconds instead; with no changed sources nothing runs and the wrapper
exits 0.

The agent invocation lives in `settings.yml` at the repo root — never
hardcoded:

```yaml
command: pi        # agent CLI, run non-interactively in the data repo
model: GLM-5.2     # passed as --model
reasoning: high    # pi thinking level, passed as --thinking
```

The per-run digest — the human's review surface while runs are
unsupervised — is written to `outputs/runs/<timestamp>.md` (gitignored
machine output; the durable review surface is the data repo's git
diff) and printed to stdout: agent command, model, and reasoning level;
mode and prompt
file; sources added/changed/removed; wiki pages created/updated (read
from the data repo's git status, so it matches the `git diff` you
review); and the agent's final report, which the prompt requires to
state sources processed, pages created/updated, contradictions
detected, and unresolved questions. Page counts come from the data
repo's git status, so they cover everything uncommitted — review the
`git diff`, then commit the data repo after each run to keep every
digest scoped to its own run. A failed agent run exits 1 and
leaves the snapshot untouched, so the next run retries the same
sources; guardrails (lint, checks, auto-revert) are issue #12, the
one-command orchestration #13, scheduling #14.

**Timeout budgeting:** the 1800 s default fits the steady state —
incremental runs measured at 1–2 minutes (about one minute per note,
including page updates). A first full ingest is much larger (136
uningested notes at the time of the #10 drill); at the measured rate
that is hours, so give it an explicit budget, for example
`npm run wiki-ingest -- --timeout 14400`, and watch the spinner's
elapsed clock. A timed-out run fails cleanly and retries the same
sources on the next run.

## Gating changes with no-mistakes

Every trigger below starts the same pipeline — rebase, review, test,
document, lint, push, PR, CI watch — in a disposable worktree. Nothing
reaches `origin` until every check passes, and no-mistakes never merges
the PR: the run signals `Checks passed` and a human merges.

| Trigger | Command | Use it when |
|---|---|---|
| Gate push | `git push no-mistakes [<branch>]` | The work is committed on a branch; the explicit Git path |
| TUI wizard | `no-mistakes` | The work is not committed yet; the wizard creates a branch, commits, pushes through the gate, and attaches to the run |
| TUI auto | `no-mistakes -y` | The same wizard with every default accepted, no interaction |
| Agent skill | `/no-mistakes <task>` (or bare `/no-mistakes`) | A coding agent does a task and gates it, or gates already-committed work; drives `no-mistakes axi` under the hood |
| Headless run | `no-mistakes axi run --intent "<goal>"` | A script or non-interactive agent starts a run; `--intent` is required, `-y` auto-resolves gates |
| Rerun | `no-mistakes rerun [--intent "<goal>"]` | Re-trigger the pipeline for the current branch after a finished, failed, or cancelled run; it cancels any active run on the branch first — a between-runs action, not a way to bypass a gate |

New runs accept `--skip <steps>` (comma-separated pipeline steps to skip),
for example `no-mistakes --skip ci` or
`no-mistakes axi run --intent "..." --skip document`.

Inspecting a run is not triggering one: `no-mistakes attach`, `status`,
`runs`, and `axi status` / `axi logs` only observe existing runs.

The gate's per-repo configuration — commands, agent
selection, review and document rules — lives in
[`.no-mistakes.yaml`](.no-mistakes.yaml). The
pipeline-development context is the gate's main user; see
[AGENTS.md](AGENTS.md) for the split between it and wiki operations.

### Excluding the PR step here

no-mistakes' `pr` step regenerates the PR title and body from scratch
on every run — a full replacement, not a merge — which discards
agent-authored PR text and issue-closing keywords such as
`Closes #N` (upstream defects:
[kunchenguid/no-mistakes#763](https://github.com/kunchenguid/no-mistakes/issues/763),
[#713](https://github.com/kunchenguid/no-mistakes/issues/713)).
Agents create PRs themselves, so the body and issue linkage survive
every gated run.

There is **no config-file key** to skip a pipeline step — not in
`~/.no-mistakes/config.yaml` (global) and not in `.no-mistakes.yaml`
(repo). The skip rides per-run flags or git push options (verified
against v1.53.0 source).

Ways that work, per trigger:

| Trigger | How to exclude `pr` |
|---|---|
| TUI (`no-mistakes`, `no-mistakes -y`) | `--skip pr` flag, or the push-option config below |
| Agent / headless (`axi run`) | **always pass `--skip pr`** (see trap below) |
| Manual gate push (`git push no-mistakes …`) | `-o no-mistakes.skip=pr`, or the push-option config below |
| `no-mistakes rerun` | **cannot skip** — v1.53.0 exposes only `--intent`; avoid rerun here, start a fresh `axi run --skip pr` instead |

**Push-option config (automatic for pushes without explicit `-o`):**

```sh
git config push.pushoption no-mistakes.skip=pr
```

A self-healing backstop re-applies it if the repo-local setting is
ever lost: `~/.gitconfig` has an `includeIf "gitdir:~/Lab/k-wiki/"`
pointing at `~/.gitconfig-k-wiki`, which carries the same
`[push] pushOption`. The `gitdir:` pattern matches the worktree's
gitdir, so every worktree of this repository — linked ones via
`~/Lab/k-wiki/.git/worktrees/…` — inherits it; other repositories
are untouched. The gate's disposable worktrees belong to the bare
gate repo under `~/.no-mistakes/`, so they see no option — harmless,
since every trigger push originates in this repository. The
option also rides pushes to `origin`; GitHub ignores unknown push
options.

**Do not use `remote.<name>.pushoption`** — this repo used it and the
`pr` step still ran. git 2.50.1 (Apple Git-155) silently drops that
key: a packet trace and a clean two-repo reproduction show it is never
transmitted, while `push.pushOption` and explicit `-o` are. git has
never read that key — upstream parses only `push.pushOption` — so no
upgrade will make it work.

**Trap: `axi run --intent` suppresses the config option.** git sends
`push.pushOption` only when no `-o` flag is given, and `axi run
--intent …` pushes with its own `-o no-mistakes.intent=…`. So agents
passing intent must pass `--skip pr` explicitly — the flag forwards
the skip on both the push path and the IPC fallback.

Consequences:

- **No CI watch or CI auto-fix.** With no `pr` step the run records no
  PR URL, so the `ci` step skips. GitHub Actions still run and branch
  protection still blocks merges — only the gate's monitoring is gone.
- **No PR is auto-created.** If no PR is open on the branch when the
  gate finishes, none appears — create it before or after gating.
- **`axi respond --action skip` cannot skip `pr`** — the step never
  parks for approval; only pre-skip works.

To revert (the next gated push without `-o` runs the `pr` step again,
which rewrites any existing PR body on the branch once), unset the
repo-local key **and** the backstop — removing only one leaves the
other still supplying the option:

```sh
git config --unset push.pushoption
git config --file ~/.gitconfig-k-wiki --unset push.pushoption
```
