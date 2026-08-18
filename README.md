# k-wiki

An LLM-maintained knowledge wiki, derived from a human-owned Obsidian vault.

`k-wiki` implements the [Karpathy-style LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: a personal Obsidian vault remains the human-owned source of truth. Notes marked `wiki: true` are deterministically synced into an immutable `raw/` projection inside this repo; an LLM agent then builds and maintains a structured, interlinked wiki under `wiki/`. The wiki is disposable derived data — versioned in git, auditable by diff, and publishable to all devices as a read-only mirror.

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
| `npm run fixtures -- <dir>` | fixture generator | Write the synthetic Obsidian test vault to `<dir>/Documents` |
| `npm run sync-vault -- [<sync.json>] [<raw-dir>]` | sync CLI | Project `wiki:true` notes from the configured vaults into `raw/notes/` (deterministic, no LLM; defaults to the repo's `sync.json` and `raw/`) |

Type check, lint, and unit tests are quality gates: every change passes
them before it is done. CI (`.github/workflows/ci.yml`) enforces the same
gates on every pull request, testing each PR's merge commit against
`main`, with a 90% coverage floor on unit tests.

The fixture generator produces a deterministic fake vault — fixed bytes,
no timestamps — covering every case the sync layer must handle (selected,
excluded, edited, deleted, and noise files). A checked-in snapshot lives at
`tests/fixtures/Documents/`; regenerate it with
`npm run fixtures -- tests/fixtures` after changing the generator. Never
edit the snapshot by hand.

`sync.json` at the repo root is the human-owned placement configuration:
which vaults to sync and where to publish the mirror (guide §26). The
`publish` section is parsed but unused until the mirror lands. Sync state —
hashes and timestamps — lives in `raw/manifest.json`, keyed per vault
namespace (guide §25). Sync is idempotent: a run with no source changes
copies, removes, and writes nothing.

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
