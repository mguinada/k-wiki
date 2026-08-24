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
| `docs/karpathy_wiki_implementation_guide.md` | The implementation guide — spec of record, including the target repository layout (§6) |
| `AGENTS.md` / `wiki/AGENTS.md` | The two agent contexts ([issue #3](https://github.com/mguinada/k-wiki/issues/3)) |

## Working in this repo (humans and agents)

This repository hosts two agent contexts with deliberately different permissions:

- **Wiki operations** (ingest, lint, query) follow `wiki/AGENTS.md`.
- **Pipeline development** (scripts, config, tests) follows the root `AGENTS.md`.

See [Two Agent Contexts](docs/karpathy_wiki_implementation_guide.md#1-two-agent-contexts) in the guide before doing either.

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
`npm run wiki-sync` chains steps 1–4 into one command
([details](#running-the-full-cycle-wiki-sync)); the separate commands
stay available for debugging, and `wiki-ingest` already runs the
post-run guardrails — checks and auto-revert — after every agent run.
Scheduling is #14.

## Usage models

Every way this wiki can run today, one worked example each. The design
behind them is [guide §25](docs/karpathy_wiki_implementation_guide.md#25-scaling-to-multiple-vaults-and-multiple-wikis);
the examples here are the operator-level contract. Modes that arrive
with open issues are [listed separately](#arriving-with-open-issues)
and documented only when they land.

### 1. One vault → one wiki (baseline)

The current instance: one iCloud vault, one data repo, the four-step
cycle above. Run the cycle with one command, then review and run the
standing checks:

```sh
npm run wiki-sync   # sync → ingest → lint → crosslinks (configured) → commit
# review: the printed digest, git log -1 in the data repo
npm run check-links -- ~/Lab/k-wiki-data/wiki   # every [[wikilink]] resolves
npm run check-provenance -- ~/Lab/k-wiki-data/wiki  # every sources entry and origin is alive
npm run check-fidelity -- ~/Lab/k-wiki-data/wiki ~/Lab/k-wiki-data/raw  # quoted tokens trace to origins; titles match file names
npm run health -- ~/Lab/k-wiki-data/raw         # raw/ matches its manifest
```

The command commits the data repo itself, so the next digest covers
only its own run; the printed digest plus `git log -1` tell the whole
story ([details](#running-the-full-cycle-wiki-sync)). The separate
commands — `npm run sync-vault`, `npm run wiki-ingest` — stay
available for debugging (guide §8).

These checks take their directories explicitly: their defaults are
this repo's skeleton trees, not the data repo at `dataRoot`.

### 2. Several vaults → several wikis

Privacy or audience separation with full physical isolation: N
checkouts of this repo, each with its own `sync.json`, `settings.yml`,
and data repo. No process changes — the pipeline is per-checkout,
and nothing about one instance leaks into another.

A maximum-privacy instance beside the default one, for material with
the strictest confidentiality requirements:

```sh
git clone git@github.com:mguinada/k-wiki.git ~/Lab/k-wiki-private
cd ~/Lab/k-wiki-private && npm install
```

`sync.local.json` — uncommitted (see [operator rules](#8-operator-rules-that-keep-instances-safe));
the vault lives on local disk and never syncs anywhere:

```json
{
  "dataRoot": "~/Lab/k-wiki-private-data",
  "vaults": [
    { "name": "Private", "root": "~/Vaults/Private", "exclude": "wiki:false" }
  ]
}
```

`settings.local.yml` — uncommitted; this instance's own agent and
model, pinned independently of the default instance:

```yaml
command: pi
model: GLM-5.2
reasoning: high
```

Seed once, then run the same cycle as model 1:

```sh
npm run data:init -- sync.local.json
npm run sync-vault -- sync.local.json
npm run wiki-ingest -- --settings settings.local.yml ~/Lab/k-wiki-private-data/raw
```

The data repo is seeded by `data:init` as a local git repository with
no remote — **add none ever**: history, rollback, and audit all work
without one ([model 7](#7-data-repo-location-and-privacy-posture)).
Each instance encodes its own privacy posture in its own config and
data location; the default instance's iCloud vault and optional
remote never touch this one.

### 3. One vault → several wikis by exclusion key

The same vault feeding two instances that partition it by frontmatter.
Each instance is set up like model 2 (own checkout, own data repo) but
points at the same vault `root` with a different `exclude` key:

```json
{
  "dataRoot": "~/Lab/k-wiki-public-data",
  "vaults": [
    { "name": "Engineering",
      "root": "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Engineering",
      "exclude": "public:false" }
  ]
}
```

Each instance applies exactly one `<key>:false` rule, so what syncs
is fully predictable from a note's frontmatter:

| Note frontmatter | Private (`exclude: "wiki:false"`) | Public (`exclude: "public:false"`) |
|---|---|---|
| none, or any value but `false` | synced | synced |
| `public: false` | synced | not synced |
| `wiki: false` + `public: false` | not synced | not synced |
| `wiki: false` only | not synced | **synced — subset breaks** |

The public wiki stays a subset of the private one **only by frontmatter
convention**: every note that carries `wiki: false` must also carry
`public: false`. No code enforces the pairing; the vault author
maintains it.

### 4. Several vaults → one wiki

`sync.json`'s `vaults` array with several entries — each vault syncs
into its own `raw/notes/<name>/` namespace with its own manifest key:

```json
{
  "dataRoot": "~/Lab/k-wiki-data",
  "vaults": [
    { "name": "Work", "root": "~/Vaults/Work", "exclude": "wiki:false" },
    { "name": "Personal", "root": "~/Vaults/Personal", "exclude": "wiki:false" }
  ]
}
```

**Sync is supported today; wiki-contract operation is not.** The e2e
suite covers a full single-vault lifecycle plus two-vault sync
(namespaces, per-vault manifest keys), but
[`wiki/AGENTS.md` § Multiple Source Vaults](wiki/AGENTS.md#multiple-source-vaults)
reserves multi-vault rules for a human-approved addendum that has not
landed — the wiki contract today covers a single source vault. Treat
this as a supported sync configuration, not a working wiki mode.

### 5. The second brain

One subject's own vault compiled into its own instance
([guide §25, Scenario D](docs/karpathy_wiki_implementation_guide.md#scenario-d-the-second-brain)):
a profile layer the agent reads before every run and every query,
`project`/`decision`/`attempt` pages under `wiki/second-brain/`, and
one-way cross-wiki links into domain wikis. The subject can be a
person, a career, or a venture — the compiled memory is what defines
the class, not privacy. Several second brains are ordinary model-2
instances, each free to link into the same domain wikis. The setup is
model 2's — own vault, own data repo, own config — with the files
below (uncommitted per
[operator rule 8](#8-operator-rules-that-keep-instances-safe); vault
paths and model choice are private):

`sync-second-brain.json`:

```json
{
  "dataRoot": "~/Lab/k-wiki-second-brain-data",
  "vaults": [
    { "name": "Brain", "root": "~/Vaults/Brain", "exclude": "wiki:false" }
  ]
}
```

`settings-second-brain.yml`:

```yaml
command: pi
provider: openrouter
model: moonshotai/kimi-k2.6
reasoning: high
secondBrain.domains: [~/Lab/k-wiki-data/wiki]
```

The `secondBrain.domains` key (a `[...]`-wrapped, comma-separated
list of domain wiki dirs, one per linked domain wiki) wires the
crosslink audit into the cycle: every `wiki-sync` run audits the
second brain's cross-wiki links against every listed wiki after lint
and before the commit, so the wiki/AGENTS.md "after every run"
contract is enforced automatically. Omit the key and the cycle skips
the audit (the manual command below still works).

Seed once, then run the same cycle as model 1 — naming the config,
the settings, **and a per-instance outputs dir** so the run digests
stay separate (the manifest snapshot lives in each data repo's own
`outputs/`, so it never crosses instances; issue #112):

```sh
npm run data:init -- --second-brain sync-second-brain.json
npm run wiki-sync -- --settings settings-second-brain.yml --outputs outputs-second-brain sync-second-brain.json
```

`data:init --second-brain` writes `.second-brain` at the data root —
the operator-owned identity marker the ingest guardrails read (only
a marked repo may carry cross-wiki links; the agent-writable profile
never grants identity). The first ingest creates
`wiki/second-brain/profile.md` — the agent's
evolving memory of the wiki's subject: current projects, goals,
communication style, standing preferences. Later runs read it first and update it
when the sources reveal changes; queries shape their answers with it
("What did I try for fast tests?" is answered from the `attempt` and
`decision` pages together with the profile). The profile is an
accreted layer, like `queries/`: rebuilds preserve it, and — like
`index.md` and `overview.md` — it needs no `sources` field.

Second-brain pages may reference domain wikis — never the reverse —
with a slashed wikilink target, `[[<vault>/<page>]]`:

```markdown
Chose vitest over jest for the macOS suite; domain background in
[[engineering/retrieval-augmented-generation]] and
[[anthropology/decision-making]].
```

The vault segment names a domain wiki (matched case-insensitively
against that wiki's `raw/manifest.json` — the sibling of the wiki
dir passed to the checker) and the page segment must exist in that
wiki; several domain wikis may be linked from the same second
brain. Such links never resolve inside the second brain;
`check-crosslinks` validates them, and domain wikis themselves may
carry no cross-wiki links — only a second brain may use them, so a
domain wiki writing one fails the ingest guardrails. When the
instance's settings carry `secondBrain.domains` (above), the
`wiki-sync` cycle runs this audit automatically after every run —
failure fails the cycle before the commit. The manual commands (one
`<domain-wiki-dir>` per linked domain wiki):

```sh
npm run check-links -- ~/Lab/k-wiki-second-brain-data/wiki
npm run check-provenance -- ~/Lab/k-wiki-second-brain-data/wiki ~/Lab/k-wiki-second-brain-data/raw
npm run check-fidelity -- ~/Lab/k-wiki-second-brain-data/wiki ~/Lab/k-wiki-second-brain-data/raw
npm run check-crosslinks -- ~/Lab/k-wiki-second-brain-data/wiki ~/Lab/k-wiki-data/wiki
npm run health -- ~/Lab/k-wiki-second-brain-data/raw
```

The default instance audits its own side of the discipline the same
way — self-referenced, it asserts the default instance (a domain
wiki) contains no cross-wiki links:

```sh
npm run check-crosslinks -- ~/Lab/k-wiki-data/wiki ~/Lab/k-wiki-data/wiki
```

### 6. Topology changes by rebuild

`wiki/` is derived from `raw/` alone, so topology changes are
re-ingestion, never information loss:

```text
split:  partition raw/ by vault namespace  →  rebuild each wiki
merge:  concatenate namespaced raw/ trees  →  rebuild one wiki
```

A rebuild is the agent run over all of `raw/` (`prompts/rebuild.md`)
in a fresh data repo, or after clearing `wiki/`. Split first, merge
later: once sensitive notes are merged into a wiki and its git
history, privacy cannot be un-mixed without rewriting that history.

### 7. Data repo location and privacy posture

The data repo is a plain git repository — provider-agnostic. Every
feature works with no remote at all: history, rollback, audit
(guide §19). A remote is an explicit opt-in, and any git remote
works — a private GitHub repo, a self-hosted one, or a bare repo on
an external disk as the only remote:

```sh
git init --bare /Volumes/Backup/k-wiki-data.git   # once, on the disk
cd ~/Lab/k-wiki-data
git remote add origin /Volumes/Backup/k-wiki-data.git
git push -u origin main
```

The data repo holds personal material: push it only to a private
remote you explicitly control. It must live in a plain local folder,
never inside a cloud-synced one (guide §26).

### 8. Operator rules that keep instances safe

Hardened during the first full build (issue #61):

- **Run every `sync-vault` / `wiki-ingest` from its own checkout
  root.** The manifest snapshot
  (`<dataRoot>/outputs/last-ingested-manifest.json`) is per-data-repo
  state kept in the data repo's `outputs/` (gitignored there); a
  legacy snapshot in a checkout's `outputs/` is adopted into the data
  repo on the next run (issue #112). The wrapper resolves
  `sync.json`, `settings.yml`, and its own `outputs/` relative to the
  checkout you are standing in. A foreign
  snapshot is caught mechanically (issue #95): the snapshot is
  stamped with its data repo root at write time, and a read whose
  stamp does not match — foreign or unstamped — warns loudly and
  falls back to a full run. A crossed instance can therefore cost an
  unintended full re-run, but never a silently wrong change set (the
  spurious-expunge case).
- **Keep instance-specific config uncommitted or pass it
  explicitly.** `sync.json` and `settings.yml` are tracked files in a
  public repo; a private instance's vault paths and model choice must
  never be committed. Either leave local edits uncommitted in the
  instance checkout, or keep untracked local files and name them on
  every run: `npm run sync-vault -- sync.local.json` and
  `npm run wiki-ingest -- --settings settings.local.yml <raw-dir>`.

### 9. The meta-wiki (a repository as source)

k-wiki documenting itself: the source is the k-wiki repository, not a
vault. A second pipeline instance with its own data repo
(`k-wiki-meta-data`), its own configs (`sync-meta.json`,
`settings-meta.yml`), and a different contract — describe, don't
prescribe; code is truth; pages for mechanisms, not per-file résumés
([guide §25 Scenario E](docs/karpathy_wiki_implementation_guide.md)).
Selection is an allowlist in `sync-meta.json`: anything not listed is
excluded by construction, so the projection can never ingest itself.

```sh
npm run data:init -- --meta sync-meta.json       # once
npm run sync-repo -- sync-meta.json               # project a committed tree
node src/ingest/wiki-ingest.ts --settings settings-meta.yml \
  ~/Lab/k-wiki-meta-data/raw                       # build the meta-wiki
npm run health -- ~/Lab/k-wiki-meta-data/raw       # coherence + freshness
```

The projection records the source commit it was made from; `health`
warns when the source has moved on (`--fail-on-stale` to make it
blocking). Review every regeneration in the data repo with the usual
git-diff flow.

### Arriving with open issues

These modes are documented when their issue lands, not before:

- **Read-only mirror publish** — the iPhone/iPad reading copy (#15).
- **Scheduled unattended operation** (#14).
- **`--batch N` for `wiki-ingest`** — batch construction stops
  being snapshot surgery; deferred from #13 until batched runs
  become the standing procedure for large backlogs.

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
| `npm run e2e` | vitest | Run the end-to-end suite (`tests/e2e/`): real CLI child processes — sync-vault through a full vault lifecycle (first run, no-op re-run, edit, delete, block flip, multi-vault) against the synthetic fixture vault in temp workspaces under `.e2e-tmp/` (gitignored), wiki-ingest through first-run, incremental, expunge, rename, skip, failure, timeout, and guardrail auto-revert runs against a stub agent in temp data repos, the second brain through profile-layer ingest, cross-wiki link validation, the reverted domain→second-brain leak, and a health-checked second-brain sync, sync-repo through verbatim projection, commit stamping, unchanged re-run, dirty-source and wrong-config failures, and health freshness runs in temp source repos, and wiki-sync through full-cycle, no-change rerun, failure, guardrail-revert, and configured crosslink-audit (pass and fail) runs |
| `npm run health [-- <raw-dir>] [--fail-on-stale]` | health CLI | Check the coherence of a `raw/` projection (default: the repo's `raw/`): every `raw/notes/<vault>/` file matches its `manifest.json` sha-256, with no orphans and no missing entries; a repo-sourced projection (sync-repo) is also freshness-checked — a recorded source commit behind the source repo's HEAD warns, and `--fail-on-stale` (after the `--`) makes it exit 1; read-only, no vault access; exit 0 = coherent (including healthy-empty), exit 1 = one line per problem |
| `npm run check-links [-- <wiki-dir>]` | wikilink checker | Check that every `[[wikilink]]` under `wiki/` (default) resolves to an existing page by file name, skipping external slashed `[[<vault>/<page>]]` cross-wiki targets; exit 0 = all links resolve, exit 1 = one `file:line -> [[link]]` line per broken link |
| `npm run check-crosslinks <wiki-dir> <domain-wiki-dir> [<domain-wiki-dir>…]` | cross-wiki link checker | Check the one-way link discipline between a wiki and its domain wikis: every slashed `[[<vault>/<page>]]` link names a vault of a passed domain wiki (validated against its `raw/manifest.json`, case-insensitive) and resolves to an existing page there, and the domain wikis carry no cross-wiki links; exit 0 = discipline holds, exit 1 = one `file:line -> [[link]]` line per problem |
| `npm run backfill-origin [-- <wiki-dir> [<raw-dir>]]` | origin backfill | Deterministically write `origin` (guide §14a) on every `type: source` page lacking it whose `sources` cites exactly one existing `raw/` path **and** whose title corroborates that note's name, bumping `updated` (default: the repo's `wiki/` and sibling `raw/`; `--date YYYY-MM-DD` overrides the bump date, `--dry-run` previews every pairing without writing); zero/several-path and title-mismatch pages are reported for judgment, never guessed; refuses a dirty wiki tree, appends an audit entry to `wiki/log.md`, idempotent — `git diff` is the review surface |
| `npm run check-provenance [-- <wiki-dir> [<raw-dir>]]` | dead-provenance checker | Check that every `sources` entry under `wiki/` resolves (wikilink → an existing page, path → an existing `raw/` file) and every source page's `origin` exists under `raw/` (default: the repo's `wiki/` and its sibling `raw/`); exit 0 = coherent, exit 1 = one `wiki/<page> -> …` line per problem — the deterministic backstop that catches any purge miss; when `type: source` pages lack `origin`, a yellow warning below the ok summary (exit stays 0; printed only when no dead provenance was found) names the exact `backfill-origin` commands to run, dry run first |
| `npm run check-fidelity [-- <wiki-dir> [<raw-dir>]]` | citation-fidelity checker | Check that every machine-checkable token a `type: source` page quotes in its body — tilde paths, dotted config keys (file extensions and hostnames excluded), long and short CLI flags, `npm run` commands — appears in the page's `origin` file under `raw/` (a prefix of a longer name does not count), and every page's `title` kebab-cases to its file name (`index`, `overview`, `log` exempt; default: the repo's `wiki/` and its sibling `raw/`); exit 0 = faithful, exit 1 = one `wiki/<page> -> …` line per problem — catches fabricated tokens deterministically; relational misquotes (right tokens, wrong containment) stay with the lint prompt and diff review; source pages without `origin` skip quote checking and get the same yellow `backfill-origin` warning as check-provenance |
| `npm run fixtures -- <dir>` | fixture generator | Write the synthetic Obsidian test vault to `<dir>/Documents` |
| `npm run sync-vault -- [--dry-run] [<sync.json>] [<raw-dir>]` | sync CLI | Ingest every note not blocked by the vault's exclusion rule into `raw/notes/` (deterministic, no LLM; [details below](#running-the-sync)) |
| `npm run sync-repo -- [-h \| --help] [<config>] [<raw-dir>]` | repo sync CLI | Project the allowlisted files of a committed source repository verbatim into `raw/notes/<name>/`, recording the source HEAD commit in the manifest (deterministic, no LLM; the meta-wiki adapter, [§9](#9-the-meta-wiki-a-repository-as-source)) |
| `npm run wiki-ingest -- [-h \| --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]` | ingest wrapper | Run the wiki agent headless over the sources that changed since the last ingest and write the per-run digest (reads `settings.yml`; [details below](#running-the-wiki-agent-wiki-ingest)) |
| `npm run wiki-sync -- [-h \| --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<sync.json>] [<raw-dir>]` | cycle orchestrator | Run the whole cycle — sync → ingest → lint → crosslink audit (configured second brains) → one data-repo commit — and print the digest (reads `settings.yml`, including its optional `secondBrain.domains` list; [details below](#running-the-full-cycle-wiki-sync)) |
| `npm run wiki-query -- [-h \| --help] [--file-last] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>` | query wrapper | Ask the built wiki one question headless: print the answer, save it for review (stage 1, default); `--file-last` files the reviewed answer deterministically (stage 2; reads `settings.yml` in stage 1; [details below](#running-queries-wiki-query)) |
| `npm run data:init -- [--second-brain] [--meta] [<sync.json>]` | data repo seeder | Create and seed the data repo at `sync.json`'s `dataRoot`: git init, copy the `raw/`+`wiki/` skeleton from the code repo, first commit; idempotent; `--second-brain` also writes the `.second-brain` identity marker ([§5](#5-the-second-brain)); `--meta` seeds the meta contract (`wiki/AGENTS.meta.md`) as the data repo's `wiki/AGENTS.md` ([§9](#9-the-meta-wiki-a-repository-as-source)) |
| `npm run mutation:changed` | StrykerJS | Advisory mutation run scoped to the changed hunks of the `src/` files that differ from `main` (uncommitted included; new files whole) — `scripts/mutation-scope.ts` builds the `file:start-end` ranges; exits 0 without running when nothing changed, and ends by printing the actionable mutants — the default pre-handoff step |
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
fixture vault, wiki-ingest and wiki-sync against a stub agent in temp
data repos; the health check verifies that a `raw/` projection is
internally consistent without the real vault. Both are deterministic and fast, so
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

The prune is a batch of manifest removals, so the next `npm run
wiki-ingest` routes it to
[expungement](#when-a-note-is-deleted-expungement) and re-derives the
affected wiki pages; that is wiki maintenance under `wiki/AGENTS.md`,
not part of the sync run.

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
| `triage the survivors` | `npm run mutation:changed` — diff scope (changed hunks of the files that differ vs `main`), the default |
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
`main`, or via manual workflow dispatch — never as a blocking check.
Labeled-PR runs use the same hunk-scoped command as the local
pre-handoff step (`npm run mutation:changed`, full checkout history);
only the nightly and dispatched runs mutate all of `src/`. Its
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
previous successful run (`<dataRoot>/outputs/last-ingested-manifest.json`), and
runs the agent non-interactively **in the data repo root** — `prompts/ingest.md`
for the first run, `prompts/incremental.md` with the changed sources
(`+` added, `~` changed, `→` renamed, `-` removed) appended for every
later one, except that removals route to `prompts/expunge.md` (see
[below](#when-a-note-is-deleted-expungement)). The
snapshot is stamped with the data repo it belongs to (issue #95): one
stamped for another instance — or an unstamped legacy one — is ignored
with a loud warning and the run falls back to the full prompt, so a
foreign snapshot in the data repo — a clone or copy from another
machine, say — can never silently diff, or expunge, against this
instance's state. The
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

Unless `isolate: false` opts out, every spawned ingest and lint run
is isolated from the host's global agent setup (issue #118): the
wrapper prepends `--no-context-files --no-extensions --no-skills`, so
installed context files (AGENTS.md discovery), extensions, and skills
cannot leak into headless runs. Set `false` only to debug with the
ambient global setup. Query runs are not isolated.

The per-run digest — the human's review surface while runs are
unsupervised — is written to `outputs/runs/<timestamp>.md` (gitignored
machine output; the durable review surface is the data repo's git
diff) and printed to stdout: agent command, model, reasoning level,
and isolation state (`isolated` / `not isolated`); mode and
prompt file; sources added/changed/removed/renamed; wiki pages
created/updated/deleted (read
from the data repo's git status, so it matches the `git diff` you
review); and the agent's final report, which the prompt requires to
state sources processed, pages created/updated, contradictions
detected, and unresolved questions. Page counts come from the data
repo's git status, so they cover everything uncommitted — review the
`git diff`, then commit the data repo after each run to keep every
digest scoped to its own run. A failed agent run exits 1 and
leaves the snapshot untouched, so the next run retries the same
sources. After every agent run three mechanical guardrails check the
data repo (immutability, frontmatter, wikilinks — guide §1, §7, §9):
`wiki/log.md`, the append-only log, is exempt from the frontmatter
check (it carries none by design); a tripped check auto-reverts the data repo to its pre-run state (the
pre-run commit plus the uncommitted work that preceded the run),
writes a failure digest naming the check, and exits 1; the
one-command orchestration is [`wiki-sync`](#running-the-full-cycle-wiki-sync),
scheduling #14.

**Timeout budgeting:** the 1800 s default fits the steady state —
incremental runs measured at 1–2 minutes (about one minute per note,
including page updates). A first full ingest is much larger (136
uningested notes at the time of the #10 drill); at the measured rate
that is hours, so give it an explicit budget, for example
`npm run wiki-ingest -- --timeout 14400`, and watch the spinner's
elapsed clock. A timed-out run fails cleanly and retries the same
sources on the next run.

### Unverified frontier in the digest

The digest carries an **Unverified frontier** section between the
changed-source list and the agent report. It lists every wiki page the
run created or updated whose `sources` frontmatter has exactly one entry
— the mechanical signal that a claim rests on a single source and has
not yet been independently corroborated.

Review these pages first in the `git diff`. The agent report also lists
any new load-bearing claims it identified with no second source; read
both together. A page on the mechanical list is not automatically wrong
— it may be the first authoritative source on a new topic — but it is
where bad-source contamination would first appear.

### When a note is deleted (expungement)

Deleting a vault note must purge its influence — not merely drop its
source page. When the manifest diff after a sync has removed entries,
`wiki-ingest` routes the run to `prompts/expunge.md`: the removed
note's last synced content is recovered from the data repo's git
history, the wrapper computes a deterministic direct set (the source
page, every page citing it in `sources`, `index.md`, `overview.md`),
and the agent **re-derives** every affected page from its remaining
sources instead of surgically deleting content. A mixed sync — a
deletion plus additions or edits — stays one expunge run: the
incremental prompt is appended below the expunge prompt, so the other
changed sources are ingested in the same run. Design details: guide
[§14a](docs/karpathy_wiki_implementation_guide.md).

What you see:

- the digest is labeled `expunge` (`# Wiki ingest digest (expunge)`);
- before the agent runs, a progress line announces the trigger and the
  direct set;
- the digest carries an **Expunge direct set** section and a **pages
deleted** category, plus the agent's report: claims removed, pages
deleted/updated, multi-source terms considered for a page but not
filed (with reasons), contradictions dissolved, queries expunged, and
the threshold decision;
- when the affected set exceeded roughly ⅓ of the wiki, the agent
  rebuilds instead and the digest carries the bolded line
  **Threshold exceeded — full rebuild executed; expect a large diff
covering the whole wiki.**

What to review in the git diff: claims that only the deleted note
supported are gone, shared claims survive with lower confidence where
support thinned, one-sided `CONTRADICTION` callouts are dissolved,
citing `queries/` pages are expunged, and `log.md` carries the
`## [YYYY-MM-DD] expunge | <title>` entry. There are no tombstone
pages — the wiki reflects the current `raw/`.

Rename exception: deleting `AI/old.md` and adding `AI/new.md` with
identical content in the same sync is a **move**, not a deletion — the
run treats it as a change/retitle (`→ vault/old → vault/new`) and never
routes to expunge. A rename *with* edits still routes to expunge.

Afterwards, `npm run check-provenance -- <wiki-dir>` is the permanent
backstop: every `sources` entry and every `origin` must resolve, so a
missed purge surfaces as a dead link, not as silent contamination.

## Running the full cycle (`wiki-sync`)

```sh
npm run wiki-sync   # sync → ingest → lint → crosslinks (configured) → commit
```

`wiki-sync` is the one-command orchestrator (guide §18, issue #13).
It chains the proven pieces and adds no capability of its own:

1. **sync** — `sync-vault` in-process: vault → `raw/`.
2. **ingest** — `wiki-ingest` in-process: the agent over changed
   sources, the post-run guardrails, the digest in the code repo's
   `outputs/runs/` (gitignored, per-checkout).
3. **lint** — the headless sibling of the manual lint run: the same
   `prompts/lint.md`, through the same agent settings, in a fresh
   agent session in the data repo root. The report lands in the
   **data repo's** `outputs/lint-<date>.md` (the #61 convention:
   quality history travels with the content), and the same three
   guardrails check the run with the same auto-revert. The orchestrator
   pins the date and passes the concrete report path in the prompt, so
   its report check and the prompt cannot disagree.
4. **crosslinks** — second brains only (issue #96): an instance whose
   settings carry `secondBrain.domains: [<wiki dirs>]` gets the
   `check-crosslinks` audit run over its wiki against every listed
   domain wiki — every cycle, including no-change cycles, after lint
   and before the commit. One broken or forbidden `[[<vault>/<page>]]`
   link fails the cycle (exit 1, one `file:line -> [[link]]` line per
   problem, no commit — the uncommitted diff is the fix surface), so
   the wiki/AGENTS.md "after every run" contract is enforced, not
   prose. Instances without the key skip the stage; the default
   instance is unchanged.
5. **commit** — one data-repo commit staging `wiki/`, `raw/`, and
   `outputs/`, with a message summarizing sources processed, pages
   touched, and the lint report.

The final digest on stdout — sync summary, lint summary, the
crosslink audit result (configured instances), the commit hash, then
the full ingest digest — plus `git log -1` in the data repo tell the
whole story of the run without opening any other file.

With no changed sources the agent stages skip (cost scales with
activity, not the clock), a clean data repo commits nothing, and the
command exits 0 — a configured crosslink audit still runs, and its
pass is noted in the digest.
Because the skip keys on the ingest snapshot — which a failed agent
run leaves untouched — the next cycle retries a failed ingest even
when sync then reports no changes. Lint gets no such retry: it runs
only in a cycle whose ingest ran, so after a failed lint the report
waits for the next cycle with changed sources (or a manual lint run).
A failure at any stage stops the chain and exits 1; a tripped
guardrail has already reverted its agent run. Switches:
`--settings <path>`, `--outputs <dir>` (the run digest location;
default the repo's `outputs/`; the ingest snapshot always lives in the
data repo's `outputs/`, issue #112),
`--timeout <secs>` (default 1800, applies to both agent stages), plus
the `<sync.json>` and `<raw-dir>` positionals — `-h` documents them
all. Scheduling is #14; the publish step joins with #15.

## Running queries (`wiki-query`)

```sh
npm run wiki-query -- "When should I prefer RAG over fine-tuning?"   # stage 1: answers, saves for review
npm run wiki-query -- --file-last                                  # stage 2: files the reviewed answer
```

`wiki-query` is the terminal front-end for asking the built wiki a
question (guide §16, issues #67 and #72). Filing is two-stage, and an
omitted flag can never produce wiki writes:

- **Stage 1 (default, `<question>`)** composes `prompts/query.md`
  with the question and runs the agent headless in the data repo
  root — same `settings.yml`, spinner, and `--timeout` budget as
  `wiki-ingest` — then prints the answer and saves the run
  (question, answer, pages cited, timestamp) to
  `outputs/last-query.md` (`--outputs <dir>` to relocate it). The run
  is answer-only by construction: the prompt says write nothing, and
  the wrapper enforces it mechanically — it captures the data repo's
  pre-run git state, and any change under `wiki/` during the run,
  whatever the agent claims, reverts the data repo to that state and
  exits 1 with nothing saved. A question the wiki cannot answer
  prints plainly with suggested sources and exits 0.
- **Stage 2 (`--file-last`, human-only)** is deterministic code, no
  agent, zero tokens: it templates the saved answer byte-exactly
  into `wiki/queries/<slug>.md` (kebab-case slug from the question,
  `-2`/`-3` suffixes on collision; `type: query` frontmatter with
  `sources` derived from the answer's citations of `type: source`
  pages), appends the `index.md` entry under `## Queries`, and
  appends the `log.md` entry (`## [date] query | <question>`). It
  fails cleanly when no saved answer exists, and warns when the data
  repo's `raw/` or `wiki/` changed after the saved timestamp — the
  answer cites pages that may have moved; the warning does not block
  the filing.

The old `--no-filing` switch is gone (superseded): answer-only is
the default, and there is exactly one filing path (`--file-last`).
Stage 1 switches: `--settings <path>`, `--outputs <dir>`,
`--raw-dir <dir>`, `--timeout <secs>` (default 1800) — `-h`
documents them all.
