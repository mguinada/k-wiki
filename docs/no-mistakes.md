# The no-mistakes gate

How changes in this repository are gated through
[no-mistakes](https://github.com/kunchenguid/no-mistakes) before they reach
`origin`. This is operator documentation for this repo's setup — the gate
triggers, the step-skip mechanics, and the pr-exclusion stack — kept here so
the project README stays about the project. The gate's per-repo configuration
lives in [`../.no-mistakes.yaml`](../.no-mistakes.yaml); the
pipeline-development context is the gate's main user (see
[`../AGENTS.md`](../AGENTS.md) for the split between it and wiki operations).

## Triggers

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

## Excluding the PR step here

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
against v1.53.0 source, re-verified against v1.58.0).

Ways that work, per trigger:

| Trigger | How to exclude `pr` |
|---|---|
| TUI (`no-mistakes`, `no-mistakes -y`) | `--skip pr` flag, or the push-option config below |
| Agent / headless (`axi run`) | **always pass `--skip pr`** (see trap below) |
| Manual gate push (`git push no-mistakes …`) | `-o no-mistakes.skip=pr`, or the push-option config below |
| `no-mistakes rerun` | **cannot skip** — it exposes only `--intent` (v1.53.0 through v1.58.0); avoid rerun here, start a fresh `axi run --skip pr` instead |

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

**Trap: `axi run --intent` suppresses the config option.** git sends `push.pushOption` only when no `-o` flag is given, and `axi run
--intent …` pushes with its own `-o no-mistakes.intent=…`. So agents
passing intent must pass `--skip pr` explicitly — the flag forwards
the skip on both the push path and the IPC fallback.

**CLI shim — the machine-level backstop.** The flag and push option
above ride on the caller's discipline: an `axi run` without `--skip pr`,
or any `rerun`, still runs the `pr` step (the IPC rerun path carries no
skip at all). On this machine `~/.local/bin/no-mistakes` is therefore a
wrapper script, not the installer's symlink. It appends `--skip pr` to
every run-starting invocation (`axi run` and the bare TUI/wizard),
merges `pr` into an existing `--skip` value instead of duplicating it,
refuses `no-mistakes rerun` with the safe alternative printed, and passes
every other subcommand through untouched. Every invocation prints a
one-line shim notice to stderr (never stdout, where agents parse TOON
output), so the shim cannot act invisibly. Self-updates replace only
`~/.no-mistakes/bin/no-mistakes`, so the shim survives them; a full
reinstall fails loudly when its plain `ln -s` hits the existing wrapper
file. Remove the shim — restore the stock CLI — with:

```sh
ln -sf ~/.no-mistakes/bin/no-mistakes ~/.local/bin/no-mistakes
```

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
