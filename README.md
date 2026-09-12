# k-wiki

An LLM-maintained knowledge wiki, derived from a human-owned Obsidian vault.

`k-wiki` implements the [Karpathy-style LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: a personal Obsidian vault remains the human-owned source of truth. Notes sync into an immutable `raw/` projection unless they opt out with `wiki: false`; an LLM agent then builds and maintains a structured, interlinked wiki under `wiki/`. Both trees are disposable derived data — versioned in a separate data repo placed by `sync.json`'s `dataRoot`, auditable by diff, and publishable to all devices as a read-only mirror. This repository holds the pipeline and the directory skeleton only; the contents of `raw/` and `wiki/` are gitignored here.

`bin/k-wiki` is the one front door for every wiki operation — the
[pipeline](#the-pipeline), the [queries](#running-queries-wiki-query),
and the [checks](#tooling) below are all verbs of it.

## Contents

- [Core invariant](#core-invariant)
- [Status](#status)
- [In this repository](#in-this-repository)
- [Working in this repo](#working-in-this-repo-humans-and-agents)
- [The pipeline](#the-pipeline)
- [Quick start](#quick-start)
- [Usage models](#usage-models)
- [Tooling](#tooling)
- [Running the sync](#running-the-sync)
- [Running the wiki agent](#running-the-wiki-agent-wiki-ingest)
- [Running the full cycle](#running-the-full-cycle-wiki-sync)
- [Running queries](#running-queries-wiki-query)
- [Querying from any project](#querying-from-any-project-k-wiki)
- [Shell completion (zsh)](#shell-completion-zsh)

## Core invariant

```text
Human → source vault
Sync  → raw/
LLM   → wiki/
```

Never let that direction reverse.

## Status

Stage 1 implementation is underway; code lands sequentially through the Stage 1 epic.

## In this repository

| Path | What it is |
|---|---|
| `AGENTS.md` / `wiki/AGENTS.md` | The two agent contexts |

## Working in this repo (humans and agents)

This repository hosts two agent contexts with deliberately different permissions:

- **Wiki operations** (ingest, lint, query) follow `wiki/AGENTS.md`.
- **Pipeline development** (scripts, config, tests) follows the root `AGENTS.md`.

## The pipeline

One cycle, vault to reviewed wiki — each step a verb of `bin/k-wiki`, the one front door for every wiki operation:

```text
Obsidian vault            sync-vault                wiki-ingest               review & commit
(human-owned,   ──►  raw/ projection  ──►  wiki/ updated by  ──►  read the digest,   ──►  git diff +
 outside repo)       (deterministic,       the agent (LLM,          then the git diff       commit in the
                      no LLM)               per settings.yml,        in the data repo        data repo
                                            contract wiki/AGENTS.md)
```

1. **Sync** — `bin/k-wiki sync-vault`: project every vault note not
   blocked by `wiki: false` into `raw/` and update `raw/manifest.json`
   ([details](#running-the-sync)).
2. **Ingest** — `bin/k-wiki wiki-ingest`: diff the manifest against the
   last successful ingest, run the agent over the changed sources, and
   write the digest ([details](#running-the-wiki-agent-wiki-ingest)).
3. **Review** — read the digest (`outputs/runs/<timestamp>.md`, also on
   stdout), then the `git diff` it summarizes, in the data repo.
4. **Commit** — commit the data repo, so the next digest covers only
   its own run.

`raw/` and `wiki/` contents live in the data repo at `sync.json`'s
`dataRoot`; this repo holds the pipeline and the skeleton only.
`bin/k-wiki wiki-sync` chains steps 1–4 into one command
([details](#running-the-full-cycle-wiki-sync)) — the base path's
sync step; the separate verbs stay available for debugging, and
`wiki-ingest` already runs the post-run guardrails — checks and
auto-revert — after every agent run. Every verb except the read
verbs, `propose`, and `completion` — k-wiki's own, front-door only
— is also its standalone launcher (`bin/<verb>`,
`bin/libexec/<verb>` for the maintenance tier): plumbing stays
standalone by design, not for
backward compatibility — it is the invocation path for e2e, npm
scripts, and CI, and the escape hatch when the front door does not
fit. Unattended scheduling is
[`setup-schedule`](#scheduling-the-pipeline-launchd).

After every successful ingest the pipeline also regenerates the
static KPI dashboard: `bin/k-wiki dashboard [<data-repo>]`
reads the data repo's wiki, manifests, and git history — read-only —
and writes a self-contained `<data-repo>/dashboard.html` (gitignored;
opens offline via `file://`) with coverage, structure, activity, and
provenance KPIs in dark and light themes.

## Quick start

From a fresh clone to the first committed wiki cycle — one vault, one
wiki ([model 1](#1-one-vault--one-wiki-baseline)). Prerequisites:

- **Node ≥ 22.18** — runs the `.ts` sources directly; there is no
  build step.
- **An agent CLI with model credentials** — `pi` by default
  (`settings.yml` names the command, provider, and model). Without
  working credentials the ingest step cannot run.
- **An Obsidian vault with notes** — a small test vault is enough.
  Notes opt out only via `wiki: false` frontmatter.

```sh
git clone git@github.com:mguinada/k-wiki.git && cd k-wiki && npm install
# edit sync.json: set vaults[].root to your vault, dataRoot to your data repo location
bin/k-wiki init-data-repo
bin/k-wiki wiki-sync
```

`data:init` seeds the data repo at `dataRoot` — git init, skeleton,
first commit, idempotent. `wiki-sync` then runs the whole cycle and
commits the data repo. Leave the `sync.json` edits uncommitted: vault
paths are private
([operator rule 8](#8-operator-rules-that-keep-instances-safe)).

Two pointers to know before the first run:

- **A first full ingest takes hours** — about one minute per note at
  the measured rate, and the 1800 s timeout default fits only
  incremental runs. Give the first run an explicit budget:
  `bin/k-wiki wiki-sync --timeout 14400`
  ([timeout budgeting](#running-the-wiki-agent-wiki-ingest)).
- **Review every run** — read the digest printed on stdout (also saved
  to `outputs/runs/<timestamp>.md`), then what it committed in the data
  repo (`git log -1`)
  ([the cycle](#running-the-full-cycle-wiki-sync)).

The base path's remaining steps, after the first cycle — ask the
wiki, browse it, file an answer (all from the checkout):

```sh
bin/k-wiki query "When should I prefer RAG over fine-tuning?"   # ask
bin/k-wiki list && bin/k-wiki read when-to-prefer-rag            # browse
bin/k-wiki wiki-query --file-last                                # file the reviewed answer
```

`query` prints the answer (stdout) and saves the run for review;
`--file-last` is the human step that files the reviewed answer into
the wiki ([details](#running-queries-wiki-query)). Everything else —
checks, failure semantics, further instances — is documented in the
sections below.

## Usage models

Every way this wiki can run today, one worked example each; the
examples here are the operator-level contract. Modes that arrive
with open issues are [listed separately](#arriving-with-open-issues)
and documented only when they land.

Every instance's data repo is named for its wiki's subject —
`k-wiki-<subject>-data`, this instance `k-wiki-engineering-data` —
never generically: two checkouts each holding a `k-wiki-data`
folder is exactly the crossed-instance confusion the snapshot stamp
catches mechanically, and a subject-based name prevents
it at the human level. The path is operator-owned config
(`sync.json`'s `dataRoot`); the wiki's identity is that same
stamp, never the folder name — renaming an
instance is a safe operator procedure with one budgeted full run.

The mirror vault follows the same naming family: **`KWiki <Subject>`**,
TitleCase with spaces — `KWiki` the brand prefix, the subject trailing;
this instance's mirror is `KWiki Engineering` (in the same iCloud
container as the source vault). Obsidian on iPhone/iPad lists vaults by
folder name, and the operating rule "edits belong upstream, never in the
mirror" depends on the picker making source and mirror unmistakable: a
mirror never takes a source vault's name, never the bare brand `KWiki`,
and never differs from a source name by case alone — case-insensitive
filesystems (the macOS/iOS default) would not show the difference. One
mirror per instance.

### 1. One vault → one wiki (baseline)

The current instance: one iCloud vault, one data repo, the four-step
cycle above. Run the cycle with one command, then review and run the
standing checks:

```sh
bin/k-wiki wiki-sync   # sync → ingest → lint → crosslinks (configured) → citation wall → verification → commit → publish (configured)
# review: the printed digest, git log -1 in the data repo
bin/k-wiki check-links ~/Lab/k-wiki-engineering-data/wiki   # every [[wikilink]] resolves
bin/k-wiki check-provenance ~/Lab/k-wiki-engineering-data/wiki  # every sources entry and origin is alive
bin/k-wiki check-fidelity ~/Lab/k-wiki-engineering-data/wiki ~/Lab/k-wiki-engineering-data/raw  # quoted tokens trace to origins; titles match file names
bin/k-wiki check-raw ~/Lab/k-wiki-engineering-data/raw         # raw/ matches its manifest
bin/k-wiki dashboard ~/Lab/k-wiki-engineering-data          # regenerate the KPI dashboard (also refreshed by every ingest); add -o to open it
```

The command commits the data repo itself, so the next digest covers
only its own run; the printed digest plus `git log -1` tell the whole
story ([details](#running-the-full-cycle-wiki-sync)). The separate
commands — `bin/k-wiki sync-vault`, `bin/k-wiki wiki-ingest`, and
`bin/k-wiki wiki-lint` (the quality-lint agent alone — the retry
door when the cycle's lint timed out or was skipped; its edits stay
uncommitted for the next cycle to verify, commit, and publish) —
stay available for debugging.

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
bin/k-wiki init-data-repo sync.local.json
bin/k-wiki sync-vault sync.local.json
bin/k-wiki wiki-ingest --settings settings.local.yml ~/Lab/k-wiki-private-data/raw
```

The data repo is seeded by `data:init` as a local git repository with
no remote — **add none ever**: history, rollback, and audit all work
without one ([model 7](#7-data-repo-location-and-privacy-posture)).
Each instance encodes its own privacy posture in its own config and
data location; the default instance's iCloud vault and optional
remote never touch this one. Several instances can also share one
checkout — a dropped-in `sync-<name>.json` per instance, selected
with `--wiki <name>` (short alias `-w`; both `wiki-query` and
`wiki-ingest` accept it)
([§9](#9-the-meta-wiki-a-repository-as-source))
— trading the physical isolation above for one clone.

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
  "dataRoot": "~/Lab/k-wiki-life-data",
  "vaults": [
    { "name": "Work", "root": "~/Vaults/Work", "exclude": "wiki:false" },
    { "name": "Personal", "root": "~/Vaults/Personal", "exclude": "wiki:false" }
  ]
}
```

The `dataRoot` names the wiki's subject — here both vaults together —
never one of its vaults: several vaults feed one wiki in this model,
and either vault's name would misname the repo.

**Sync is supported today; wiki-contract operation is not.** The e2e
suite covers a full single-vault lifecycle plus two-vault sync
(namespaces, per-vault manifest keys), but
[`wiki/AGENTS.md` § Multiple Source Vaults](wiki/AGENTS.md#multiple-source-vaults)
reserves multi-vault rules for a human-approved addendum that has not
landed — the wiki contract today covers a single source vault. Treat
this as a supported sync configuration, not a working wiki mode.

### 5. The second brain

One subject's own vault compiled into its own instance:
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
secondBrain.domains: [~/Lab/k-wiki-engineering-data/wiki]
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
`outputs/`, so it never crosses instances):

```sh
bin/k-wiki init-data-repo --second-brain sync-second-brain.json
bin/k-wiki wiki-sync --settings settings-second-brain.yml --outputs outputs-second-brain sync-second-brain.json
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
bin/k-wiki check-links ~/Lab/k-wiki-second-brain-data/wiki
bin/k-wiki check-provenance ~/Lab/k-wiki-second-brain-data/wiki ~/Lab/k-wiki-second-brain-data/raw
bin/k-wiki check-fidelity ~/Lab/k-wiki-second-brain-data/wiki ~/Lab/k-wiki-second-brain-data/raw
bin/k-wiki check-crosslinks ~/Lab/k-wiki-second-brain-data/wiki ~/Lab/k-wiki-engineering-data/wiki
bin/k-wiki check-raw ~/Lab/k-wiki-second-brain-data/raw
```

The default instance audits its own side of the discipline the same
way — self-referenced, it asserts the default instance (a domain
wiki) contains no cross-wiki links:

```sh
bin/k-wiki check-crosslinks ~/Lab/k-wiki-engineering-data/wiki ~/Lab/k-wiki-engineering-data/wiki
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
A remote is an explicit opt-in, and any git remote
works — a private GitHub repo, a self-hosted one, or a bare repo on
an external disk as the only remote:

```sh
git init --bare /Volumes/Backup/k-wiki-engineering-data.git   # once, on the disk
cd ~/Lab/k-wiki-engineering-data
git remote add origin /Volumes/Backup/k-wiki-engineering-data.git
git push -u origin main
```

The data repo holds personal material: push it only to a private
remote you explicitly control. It must live in a plain local folder,
never inside a cloud-synced one.

### 8. Operator rules that keep instances safe

Hardened during the first full build:

- **Run every `sync-vault` / `wiki-ingest` from its own checkout
  root.** The manifest snapshot
  (`<dataRoot>/outputs/last-ingested-manifest.json`) is per-data-repo
  state kept in the data repo's `outputs/` (gitignored there); a
  legacy snapshot in a checkout's `outputs/` is adopted into the data
  repo on the next run. The wrapper resolves
  `sync.json`, `settings.yml`, and its own `outputs/` relative to the
  checkout you are standing in. A foreign
  snapshot is caught mechanically: the snapshot is
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
  every run: `bin/k-wiki sync-vault sync.local.json` and
  `bin/k-wiki wiki-ingest --settings settings.local.yml <raw-dir>`. A
  committed sibling config (`sync-<name>.json` +
  `settings-<name>.yml`) is instead selected the short way —
  `--wiki <name>` on wiki-query and wiki-ingest — with an optional
  alias in `sync.json`'s `instances` map giving it any name you like
  ([§9](#9-the-meta-wiki-a-repository-as-source)).

### 9. The meta-wiki (a repository as source)

k-wiki documenting itself: the source is the k-wiki repository, not a
vault. A second pipeline instance with its own data repo
(`k-wiki-meta-data`), its own configs (`sync-meta.json`,
`settings-meta.yml`), and a different contract — describe, don't
prescribe; code is truth; pages for mechanisms, not per-file résumés.
Selection is an allowlist in `sync-meta.json`: anything not listed is
excluded by construction, so the projection can never ingest itself.
Only tracked files are selected — a gitignored file matching the
allowlist is skipped, since the recorded commit does not describe it.
A checkout hosting several instances selects one by name:
`--wiki <name>` on the query and ingest doors, resolved through the
checkout's registry — an alias in `sync.json`'s optional `instances`
map first (explicit human intent beats convention), then a free stem
`sync-<name>.json` in the checkout root; every derived path (raw dir,
outputs dir, settings file) keys off the resolved config file, so
`--wiki meta` reads `settings-meta.yml`, saves to `outputs-meta/`,
and files into the meta data repo. The alias map is human-owned —
created and maintained by editing `sync.json`; the pipeline never
writes it — and names are optional sugar: stems are free, and the
default instance needs no flag:

```json
{ "dataRoot": "…", "vaults": [ … ],
  "instances": { "eng": "sync.json", "meta": "sync-meta.json" } }
```

The `eng` alias names the root `sync.json` — the default instance
— so every derived path stays the default's (`outputs/`,
`settings.yml`); `meta` is explicit sugar over the free
`sync-meta.json` stem. This checkout's real registry, verbatim.

```sh
bin/k-wiki init-data-repo --meta sync-meta.json       # once
bin/k-wiki wiki-sync --settings settings-meta.yml sync-meta.json \
  ~/Lab/k-wiki-meta-data/raw                     # the one-command cycle
```

Merges to the checkout's `main` can re-sync the meta wiki
automatically — per machine, one installer run:
[`setup-meta-sync`](#the-meta-wiki-post-merge-auto-sync-git-hooks).

The meta instance rides the same cycle as every vault instance:
`wiki-sync` sees the repo-typed source in
`sync-meta.json` and runs the sync-repo core in-process at stage 1,
so lint, the configured crosslink audit, verification, and the single
regeneration commit run in-cycle — no operator discipline needed.
The piecewise commands stay the debug path, one stage at a time:

```sh
bin/k-wiki sync-repo sync-meta.json               # project a committed tree
bin/k-wiki wiki-ingest --wiki meta                # build the meta-wiki
bin/k-wiki check-raw ~/Lab/k-wiki-meta-data/raw       # coherence + freshness
bin/k-wiki wiki-query --wiki meta "<question>"    # ask the meta wiki
bin/k-wiki wiki-query --wiki meta --file-last     # file the reviewed answer
```

The projection records the source commit it was made from; `health`
warns when the source has moved on (`--fail-on-stale` to make it
blocking). Review every regeneration in the data repo with the usual
git-diff flow.

### Arriving with open issues

These modes are documented when their issue lands, not before:

- **`--batch N` for `wiki-ingest`** — batch construction stops
  being snapshot surgery; deferred until batched runs
  become the standing procedure for large backlogs.

## Tooling

The pipeline is TypeScript on Node.js (ESM). Node ≥ 22.18 runs the `.ts`
sources directly, so there is no build step — install dependencies with
`npm install` and run the commands below.

The runtime commands below are verbs of `bin/k-wiki` — the one
front door — tiered the way git classifies its subcommands: a small
porcelain front door for daily use, an operator tier for setup and
rare paths, and plumbing — mostly guardrail- or agent-invoked —
that stays fully visible because the guardrails depend on it.
Nothing is hidden or deleted; the tiers curate the front door
only. `bin/k-wiki` with no arguments prints the same tiered table.
Which verbs answer depends on the door: inside the checkout (the
cwd is the checkout) every verb is available — the human door; from
a bound project (`.k-wiki.json`, `--checkout`, or `K_WIKI_CHECKOUT`)
only the read verbs plus `propose` (the gated agent write) — and
the door-free `completion` plumbing — the agent door, which
refuses operator verbs
with both escapes named and prints its resolved door and instance
as dim stderr lines before every run that resolves a door. The
plumbing verbs' standalone
launchers live under `bin/libexec/` — git's libexec model: every
launcher stays fully callable, out of the top-level spotlight.
Development tooling keeps its own table at the end.

### Daily (porcelain)

Daily use is two commands: `bin/k-wiki init-data-repo` once to create the
data repo ([Quick start](#quick-start)), then `bin/k-wiki wiki-sync` after
every edit. Queries complete the daily loop:

| Command | Tool | Purpose |
|---|---|---|
| `bin/k-wiki wiki-sync [-h \| --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<sync.json>] [<raw-dir>]` | cycle orchestrator | Run the whole cycle — sync (sync-vault for vault sources, sync-repo for repo-sourced configs, [§9](#9-the-meta-wiki-a-repository-as-source)) → ingest → lint → crosslink audit (configured second brains) → citation wall (sandbox one-way audit) → verification (check-fidelity + check-provenance) → one data-repo commit → mirror publish (configured `publish` section) — and print the digest (reads `settings.yml`, including its optional `secondBrain.domains` list; [details below](#running-the-full-cycle-wiki-sync)) |
| `bin/k-wiki wiki-query [-h \| --help] [--file-last] [--wiki, -w <name>] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>` | query wrapper | Ask the built wiki one question headless: print the answer, save it for review (stage 1, default); `--file-last` files the reviewed answer deterministically (stage 2); `--wiki <name>` selects the instance — aliases then `sync-<name>.json` stems, both stages, derived paths from the resolved config (stage 1 reads the instance's settings; [details below](#running-queries-wiki-query)) |
| `bin/k-wiki <read verb>` — `query "<question>"`, `status`, `list [<type>]`, `read <slug>`, `health` | read verbs (both doors) | Ask the wiki bound to the current project from any cwd — zero flags once `.k-wiki.json` binds it; `status` (binding + paths), `list` (pages by type), `read` (one page verbatim), `health` (projection check); `-w <name>` selects the instance (aliases then `sync-<name>.json` stems) and overrides the binding's `wiki` key — `k-wiki query -w meta` and `k-wiki -w meta query` are the same command; answer-only, no filing passthrough ([details below](#querying-from-any-project-k-wiki)) |
| `bin/k-wiki propose [-h \| --help] [-w, --wiki <name>] [--checkout <path>] [--timeout <secs>] [--title <text>] [--type <type>] <slug> [<file>]` | agent write verb (both doors) | File one candidate note for the wiki: the body from `<file>` (or stdin), wrapped in the deterministic template, landed under `wiki/sandbox/` of the resolved instance as one gated run — accept-gate (only sandbox deltas survive; anything else reverts the run and fails it), `via: agent` + `expires:` stamps, one atomic `sandbox: <slug>` commit with a `wiki/log.md` audit entry; `-w <name>` overrides the binding's `wiki` key; a human reviews and promotes the note (filing reviewed pages stays `--file-last`) |

### Occasional operator

First-time setup, the unattended schedule, the dashboard, and the
cycle's separate steps — what daily operation runs for you, surfaced
for the rare direct use:

| Command | Tool | Purpose |
|---|---|---|
| `bin/k-wiki init-data-repo [--second-brain] [--meta] [<sync.json>]` | data repo seeder | Create and seed the data repo at `sync.json`'s `dataRoot`: git init, copy the `raw/`+`wiki/` skeleton from the code repo, write the standing `.gitignore` (Obsidian UI state, ingest snapshot), first commit; idempotent; `--second-brain` also writes the `.second-brain` identity marker ([§5](#5-the-second-brain)); `--meta` seeds the meta contract (`wiki/AGENTS.meta.md`) as the data repo's `wiki/AGENTS.md` ([§9](#9-the-meta-wiki-a-repository-as-source)) |
| `bin/k-wiki setup-schedule [-h \| --help] [--interval <duration>] [--print] [--uninstall]` | launchd installer | Register the pipeline with launchd: write `~/Library/LaunchAgents/com.kwiki.scheduled-run.plist` — absolute node + script paths, explicit `HOME`, minimal `PATH`, `StartInterval` (`30minutes` default) + `RunAtLoad` — then bootstrap and verify with `launchctl print`; `--interval` re-registers, `--print` emits the plist without installing (any OS), `--uninstall` boots out and removes it ([details below](#scheduling-the-pipeline-launchd)) |
| `bin/k-wiki setup-meta-sync [-h \| --help] [--print] [--uninstall]` | git-hook installer | Install the meta wiki's post-merge auto-sync git hooks (`post-merge` + `post-rewrite`) into the current checkout's shared hooks dir (`git rev-parse --git-path hooks`), baking absolute paths — canonical checkout, node binary, `settings-meta.yml` + `sync-meta.json`, `<dataRoot>/raw`, and the fire log; a merge or rebase-pull landing on `main` in the canonical checkout with a clean `git status --porcelain` (untracked included) fires one detached `bin/scheduled-run` cycle, anything else log-and-skips; idempotent, refuses to touch a foreign hook; `--print` emits the hook without a git repo, `--uninstall` removes exactly what it wrote ([details below](#the-meta-wiki-post-merge-auto-sync-git-hooks)) |
| `bin/k-wiki scheduled-run [-h \| --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]` | scheduled cycle wrapper | Run one unattended cycle — the command the launchd job executes: O_EXCL lockfile (PID + timestamp, two-hour stale takeover) at `<dataRoot>/.scheduled-run.lock` → `git pull --rebase` → `wiki-sync` (commit-only) → `git push` (one pull --rebase + retry on rejection, then alert); fails loud without an `origin` remote ([details below](#scheduling-the-pipeline-launchd)) |
| `bin/k-wiki dashboard [-h \| --help] [-o \| --open] [<data-repo>]` | KPI dashboard generator | Regenerate the static KPI dashboard: read the data repo's wiki, manifests, and git history — read-only — and write the self-contained `<data-repo>/dashboard.html` (gitignored; opens offline via `file://`) with coverage, structure, activity, and provenance KPIs in dark and light themes; refreshed by every ingest, `-o` also opens it ([above](#the-pipeline)) |
| `bin/k-wiki sync-vault [--dry-run] [<sync.json>] [<raw-dir>]` | sync CLI | Ingest every note not blocked by the vault's exclusion rule into `raw/notes/` (deterministic, no LLM; [details below](#running-the-sync)) |
| `bin/k-wiki sync-repo [-h \| --help] [<config>] [<raw-dir>]` | repo sync CLI | Project the allowlisted files of a committed source repository verbatim into `raw/notes/<name>/`, recording the source HEAD commit in the manifest (deterministic, no LLM; the meta-wiki adapter, [§9](#9-the-meta-wiki-a-repository-as-source)) |
| `bin/k-wiki wiki-ingest [-h \| --help] [--wiki, -w <name>] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [--note <text>] [<raw-dir>]` | ingest wrapper | Run the wiki agent headless over the sources that changed since the last ingest and write the per-run digest (`--wiki <name>` selects the instance — aliases then `sync-<name>.json` stems, derived paths from the resolved config; [details below](#running-the-wiki-agent-wiki-ingest)) |
| `bin/k-wiki completion [-h \| --help] [<shell>]` | completion emitter | Emit the zsh completion function for the front door — static shell plumbing, byte-identical on every run (default shell `zsh`, the only one today; an unknown shell is a usage error naming the supported shells): try it now with `source <(k-wiki completion zsh)`, keep it with `k-wiki completion zsh > ~/.zfunc/_k-wiki` plus `fpath`/`compinit` in `~/.zshrc` ([recipe below](#shell-completion-zsh)) |

### Verification & maintenance (plumbing)

The check-and-fix tail — mostly invoked by the wiki-ingest and
wiki-sync guardrails and by the wiki agent, standalone when an
operator wants them. It lives under `bin/libexec/`, visible on
purpose; curation never hides plumbing:

| Command | Tool | Purpose |
|---|---|---|
| `bin/k-wiki check-raw [<raw-dir>] [--fail-on-stale]` | health CLI | Check the coherence of a `raw/` projection (default: the repo's `raw/`): every `raw/notes/<vault>/` file matches its `manifest.json` sha-256, with no orphans and no missing entries; a repo-sourced projection (sync-repo) is also freshness-checked — a recorded source commit behind the source repo's HEAD warns, and `--fail-on-stale` makes it exit 1; read-only, no vault access; exit 0 = coherent (including healthy-empty), exit 1 = one line per problem |
| `bin/k-wiki check-links [<wiki-dir>]` | wikilink checker | Check that every `[[wikilink]]` under `wiki/` (default) resolves to an existing page by file name, and every body-text heading anchor (`[[page#Chapter]]`) to a heading in the target page byte-identical to the anchor (frontmatter `sources` citations stay `check-provenance`'s domain; block references and multi-level anchors' parent segments are skipped), skipping external slashed `[[<vault>/<page>]]` cross-wiki targets; the sandbox namespace is scanned too — links *from* sandbox pages are validated exactly like main-page links, and links *into* the sandbox resolve silently (direction violations are `check-citations`' business); exit 0 = all links resolve, exit 1 = one `file:line -> [[link]]` line per broken link |
| `bin/k-wiki check-crosslinks <wiki-dir> <domain-wiki-dir> [<domain-wiki-dir>…]` | cross-wiki link checker | Check the one-way link discipline between a wiki and its domain wikis: every slashed `[[<vault>/<page>]]` link names a vault of a passed domain wiki (validated against its `raw/manifest.json`, case-insensitive) and resolves to an existing page there, the domain wikis carry no cross-wiki links, and the sandbox namespace carries none either (a slashed link from sandbox notes is a cross-instance leak); exit 0 = discipline holds, exit 1 = one `file:line -> [[link]]` line per problem |
| `bin/k-wiki check-citations [<wiki-dir>]` | one-way citation wall checker | Check the one-way wall between the wiki and its `wiki/sandbox/` namespace (default: the repo's `wiki/`): main pages never link or embed sandbox pages (embeds count as links), sandbox pages never link sandbox peers, `sources` entries never touch a sandbox page in either direction, sandbox pages never use slashed cross-wiki links, and the `via: agent` stamp lives only inside the sandbox; link resolution itself stays `check-links`' business; exit 0 = wall holds, exit 1 = one `wiki/<path>[:<line>] -> <evidence>` line per violation |
| `bin/k-wiki check-provenance [<wiki-dir> [<raw-dir>]]` | dead-provenance checker | Check that every `sources` entry under `wiki/` resolves — a wikilink to an existing `type: source` page, an anchored `[[hub#Chapter]]` entry that lands on a hub heading byte-identical to its anchor, a raw path to an existing `raw/` file that **no hub covers** (a hub-covered path must cite the wikilink; default: the repo's `wiki/` and its sibling `raw/`); exit 0 = coherent, exit 1 = one `wiki/<page> -> …` line per problem (an anchor miss reports `wiki/<page>:<line>`); when `type: source` pages lack `origin`, a yellow warning below the ok summary (exit stays 0; printed only when no dead provenance was found) names the exact `backfill-origin` commands to run, dry run first — the deterministic backstop that catches any purge miss |
| `bin/k-wiki check-fidelity [<wiki-dir> [<raw-dir>]]` | citation-fidelity checker | Check that every machine-checkable token a `type: source` page quotes in its body — tilde paths, dotted config keys (file extensions and hostnames excluded), long and short CLI flags, `npm run` commands — appears in the page's `origin` file under `raw/` (a prefix of a longer name does not count), and every page's `title` kebab-cases to its file name (`index`, `overview`, `log` exempt; default: the repo's `wiki/` and its sibling `raw/`); exit 0 = faithful, exit 1 = one `wiki/<page> -> …` line per problem — catches fabricated tokens deterministically; relational misquotes (right tokens, wrong containment) stay with the lint prompt and diff review; source pages without `origin` skip quote checking and get the same yellow `backfill-origin` warning as check-provenance |
| `bin/k-wiki backfill-origin [<wiki-dir> [<raw-dir>]]` | origin backfill | Deterministically write `origin` on every `type: source` page lacking it whose `sources` cites exactly one existing `raw/` path **and** whose title corroborates that note's name, bumping `updated` (default: the repo's `wiki/` and sibling `raw/`; `--date YYYY-MM-DD` overrides the bump date, `--dry-run` previews every pairing without writing); zero/several-path and title-mismatch pages are reported for judgment, never guessed; refuses a dirty wiki tree, appends an audit entry to `wiki/log.md`, idempotent — `git diff` is the review surface |
| `bin/k-wiki link-sources [-h \| --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]` | sources wikilink migration | Rewrite legacy path-form `sources` entries under `wiki/` (default) to wikilinks of their `type: source` hub pages — anchored (`[[hub#Chapter]]`) for a multi-part hub's sub-source — in all pages whose entry maps to the shared hub index; dry run by default prints every pair without writing, `--write` refuses a tree with uncommitted changes and appends an audit entry to `wiki/log.md`, unmappable entries are reported never guessed, idempotent — `git diff` is the review surface (the guardrails and `check-provenance` enforce the wikilink format on changed pages going forward) |
| `bin/k-wiki anchor-citations [-h \| --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]` | chapter-anchor migration | Rewrite aliased hub citations (`[[hub\|Chapter]]`) to the anchored form (`[[hub#Chapter]]`) and generate one hub heading per cited chapter — byte-identical to the anchor — under `wiki/` (default); dry run by default, `--write` refuses a tree with uncommitted changes and appends an audit entry to `wiki/log.md`, aliases that name no chapter are reported never guessed, idempotent |
| `bin/k-wiki open-origin [<hub> [--print] [--config <path>] [--vault <name>] [-h \| --help]]` | deep-dive linker | Read a hub page's `origin` under `raw/` and emit an `obsidian://open` URI for its note in the live vault, resolved against `sync.json` vaults (`--vault` overrides the vault, `--config` overrides the sync config, `--print` prints the URI without opening); nothing is stored in wiki data |
| `bin/k-wiki wiki-promote [-h \| --help] [--wiki, -w <name>] [--raw-dir <dir>] <slug> --sources "<source page>" [--sources "<source page>"…]` | sandbox-note promotion | The sandbox's only exit, the human's deliberate act (human-door verb, absent on the agent door): walk `wiki/sandbox/<slug>.md` into the main wiki — the note's body lands byte-exact as `wiki/<type-directory>/<slug>.md`, its sandbox stamps and agent-written sources are dropped, the human-approved `sources` (each tracing to a `type: source` page with a live `origin` under `raw/`, or the promotion is refused) and the promotion date are written in; page + `index.md` entry + `log.md` audit entry + the sandbox copy's deletion land as one `promote: <slug>` commit, rolled back whole on any failure; refuses a dirty tree, an expired or missing note, a slug collision with an existing main page, untraceable sources, and a page that would violate the one-way citation wall |

### Development tooling

Everything that exists to build and maintain this repository rather
than to run a wiki — the npm scripts and the `dev/` launchers,
kept apart from the runtime surface above:

| Command | Tool | Purpose |
|---|---|---|
| `npm run typecheck` | tsc | Type-check `src/`, `bin/`, `dev/`, and `tests/` without emitting code |
| `npm run lint` | Biome | Lint and verify formatting across the repo |
| `npm run format` | Biome | Rewrite files to the canonical format — the fix command for lint findings, not a gate |
| `npm test` | vitest | Run the unit test suite |
| `npm run test:coverage` | vitest | Run the unit tests and fail below the 90% coverage thresholds — what CI runs |
| `npm run audit` | npm | On-demand dependency-vulnerability check (the same audits CI's gates job runs before typecheck): the production tree at high or worse and the full tree at critical, both blocking; CI additionally logs a non-blocking advisory full-tree audit whose findings surface as run annotations |
| `npm run e2e` | vitest | Run the end-to-end suite (`tests/e2e/`): real CLI child processes through full CLI lifecycles in temp workspaces and temp data repos under `.e2e-tmp/` (gitignored); the per-CLI scenario inventory lives in [`docs/references/e2e-suite.md`](docs/references/e2e-suite.md) |
| `node dev/generate.ts <dir>` | fixture generator | Write the synthetic Obsidian test vault to `<dir>/Documents` |
| `npm run board-triage -- [-h \| --help] [--dry-run] [--owner <login>] [--project <n>]` | board triage CLI | Apply the mechanical half of the K-Wiki Kanban triage contract via the `gh` CLI — Backlog → Ready (unblocked, no `research` label), open PR → In progress, closed → Done — Status field values only; lane order is never touched, ids are resolved fresh every run, every move is verified by re-reading the board, and `--dry-run` plans with zero writes (default: `mguinada`'s project 2; [below](#scheduled-board-triage)) |
| `npm run mutation:changed` | StrykerJS | Optional advisory mutation run scoped to the changed hunks of the `src/` files that differ from the mutation base — `main` by default, any ref via `MUTATION_BASE`, or the `main` commit from N days ago via `MUTATION_WINDOW_DAYS` (uncommitted included; new files whole) — `src/quality/mutation-scope.ts` builds the `file:start-end` ranges; exits 0 without running when nothing changed, and ends by printing the actionable mutants — recommended for small diffs; the authoritative mutation signal lives in CI |
| `npm run mutation:changed -- --full` | StrykerJS | Advisory mutation run over all of `src/`, not just changed files; same printed summary |
| `node dev/mutation-survivors.ts` | triage helper | Re-list the actionable mutants from the last report — no run, instant |
| `npm run mutation:report` | report renderer | Render the rolling survivor-issue body from a `mutation.json` report, merged into the current issue body's ledger (`--prior-body`) — what the `mutants-report` workflow files — no run, instant |
| `npm run mutation` | StrykerJS | Raw full Stryker run without the printed summary — prefer the three above |
| `npm run complexity` | complexity gate | Blocking cyclomatic gate over changed code: every `src/` function whose lines a change vs `main` touches (new files whole, deletions skipped) must stay at cyclomatic ≤ 10 (engine: complexity-guard; scoping mirrors `mutation:changed`); runs as part of `npm test` too; failures name file, line, function, score, and the refactor instruction; no inline suppressions — exclusions via `.complexityguard.json` justified in the PR body ([reference](docs/references/complexity-gate.md)) |
| `npm run complexity:full` | complexity report | Advisory whole-`src/` per-function debt table, worst first — the input for complexity-lowering refactors; the table is advisory, but the same run re-executes the changed-mode gate, so a working tree with a gated violation still fails it |
| `npm run structure` | structure budget gate | Blocking whole-`src/` structure gate (`tests/quality/structure.test.ts`): a fresh `refactor-metrics` scan must keep every counter at or below its `.structureguard.json` budget (`dataToSyncEdges` pinned at zero — no import from `src/data/` into `src/sync/`); failures name the counter, budget, fresh value, and the offending files; runs as part of `npm test` too; lowering a budget is a one-line reviewed diff, raising one or adding a per-counter exclude demands a written justification in the PR body |
| `npm run refactor-metrics -- [--json] [<root>] [-h \| --help]` | refactor metrics scanner | Print the src/ refactor campaign's structure counters for a TypeScript tree (default: this repo's `src/`): file-size bands (>800, >500, >350 lines, and the largest file), cross-domain import edges (imports between different top-level domains, the `cli` shared layer excluded), the data→sync edge count (layering inversions; pinned at zero), and duplication counters (`parseArgs` copies, directory walkers, repo-root derivations, `unquote` definitions, `env:` signatures and their file spread, `(dataRoot, env)` pairs, and `dirname` derivations of `rawDir`); `--json` prints one JSON object keyed by counter name instead of the table; the structure gate (`npm run structure`) holds every counter at or below its `.structureguard.json` budget |

Type check, lint, and unit tests are quality gates: every change passes
them before it is done — the unit run includes the cyclomatic complexity
gate over changed code (`npm run complexity` runs it alone; functions a
change touches must stay at cyclomatic ≤ 10). CI
(`.github/workflows/ci.yml`) enforces the same gates on every pull
request, testing each PR's merge commit against `main`, with a 90%
coverage floor on unit tests.

Every CLI above also answers `-h` / `--help` with its usage line, every
switch explained, defaults, and exit 0 with no side effects.

Verification has three layers:

| Layer | Commands | Status |
|---|---|---|
| Gates | `npm run typecheck`, `npm run lint`, `npm test` | blocking — every change, every PR |
| End-to-end | `npm run e2e`, `bin/k-wiki check-raw` | blocking — CI's `e2e` job on every PR; required locally when a change touches the sync, ingest, or CLI layers (exact trigger list in [AGENTS.md](AGENTS.md)) |
| Mutation | CI nightly windowed run (trailing 7 days) + label-gated PR runs + on-demand code-wide dispatch (`mutation:changed` locally when wanted) | advisory — a signal, never a gate ([below](#mutation-testing)) |

The e2e suites drive the real CLIs — sync-vault against the synthetic
fixture vault, wiki-ingest and wiki-sync against a stub agent in temp
data repos, scheduled-run against a stub agent with an upstream
remote; the health check verifies that a `raw/` projection is
internally consistent without the real vault. Both are deterministic and fast, so
they gate CI like the unit tests do — unlike mutation testing, whose
runtime grows with the suite.

### Renaming or removing a vault

Sync prunes what the config no longer names: edit the vault's `name` (or
delete its entry) in `sync.json`, then re-run `bin/k-wiki sync-vault` — the
old `raw/notes/<name>/` tree and its `manifest.json` section are deleted
automatically, and the removal shows in the report as
`- <name>/ (stale namespace, not configured)`.

Two safety properties hold:

- A config with an empty `vaults` array prunes nothing — a truncated or
  mis-edited `sync.json` can never wipe the projection.
- `raw/` is disposable derived data versioned in the data repo: if a
  prune is ever wrong, `git revert` (or `git restore`) in the data repo
  brings the previous projection back.

The prune is a batch of manifest removals, so the next
`bin/k-wiki wiki-ingest` routes it to
[expungement](#when-a-note-is-deleted-expungement) and re-derives the
affected wiki pages; that is wiki maintenance under `wiki/AGENTS.md`,
not part of the sync run.

### Scheduled board triage

The mechanical half of the K-Wiki Kanban triage contract runs on a
schedule:
`.github/workflows/board-triage.yml` runs `dev/board-triage.ts` every
6 hours — Backlog → Ready for issues with no open blocker and no
`research` label, → In progress for Backlog issues with an open PR
cross-reference, → Done for closed issues on any non-Done lane. Writes go
to the board's Status field only: issues, labels, bodies, and lane
order are never touched (Ready-lane sequencing stays a triage-run
judgment), project/field/option ids are resolved fresh every run, and
every move is verified by re-reading the board — a mismatch is retried
once, and a move that still fails turns the run red. The report (one
line per move and stay, with reasons) lands in the job log and the
run's summary page. Manual triage runs keep working alongside it — the
automation is idempotent with them.

The job authenticates with `GH_TOKEN = secrets.KWIKI_BOARD_TRIAGE_TOKEN`:
a classic PAT with `repo` + `project` scopes — it reads `mguinada/k-wiki`
and writes mguinada's user projects. (Fine-grained PATs cannot access
user-owned projects: their Projects permission is organization-only.)
The default `GITHUB_TOKEN`
cannot write projects. Locally, `npm run board-triage` uses the `gh`
keyring login directly; `--dry-run` previews the plan with zero
writes.

**Re-verifying the automation** (GraphQL schema drift, behavior
changes, a new board): `dev/rehearse-board-triage.sh` rebuilds a
scratch board — never the live one — carrying one issue per contract
state and proves the lane verdicts, the dry-run zero-write property,
verify-on-apply, evidence lines, Ready-order preservation, and
idempotency, failing red on any mismatch. Run it from the repo root
with the `gh` keyring login; its header documents the fixture's
lifecycle and the rate-limit back-offs.

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
Untriaged mutants (2) — kill or record as adjudicated:
  Survived  src/sync/config.ts:7  ConditionalExpression
  Survived  src/sync/frontmatter.ts:33  BlockStatement
```

An empty list (`No actionable mutants — nothing survived, nothing
uncovered.`) means the suite holds: nothing to triage.

A non-empty list is handled by the
[mutation-triage](.agents/skills/mutation-triage/SKILL.md) skill, which
loops over each mutant and either kills it with a new or stronger test
or records the adjudication in `.mutants-registry.json`, the
equivalent-mutant registry at the repo root — a settled mutant is
filtered from the list and counted separately (untriaged vs
recorded), never silently excused.

You do **not** run a script first and then invoke the skill — the skill
re-runs the mutation itself if the report is stale. Two ways in:

- **Agent, mid-issue (optional):** the dev loop no
  longer mandates a local run — CI is the authoritative signal. For a
  small diff where context-hot triage is cheap, the agent runs `npm
  run mutation:changed`, and if it prints survivors, loads the triage
  skill and works the list in the same session.
- **Human or agent, any time:** run `npm run mutation:changed` (or re-list
  the last report with `node dev/mutation-survivors.ts`), then tell the agent
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

In CI, mutation testing is advisory — never a blocking check — and
runs in three shapes. A pull request carrying the
[`mutation`](https://github.com/mguinada/k-wiki/labels) label triggers
the `mutation` job, which uses the same hunk-scoped command as the
optional local run (`npm run mutation:changed`, full checkout history)
and uploads its HTML and JSON report as an artifact (7-day retention).
The nightly `main` run is **window-scoped**: it mutates only the
`src/` hunks changed in the trailing 7 days (`MUTATION_WINDOW_DAYS`),
so a quiet week costs minutes, not hours, and a merge stays in scope
for seven nightly runs. A quiet window (nothing changed) files a
synthetic empty report instead of failing. The code-wide full run —
capable of outgrowing GitHub's 6 h per-job limit — is **manual
dispatch only**: four parallel `mutation-chunks` jobs over
size-balanced disjoint `src/` chunks, stitched by the `mutation-merge`
job into that same artifact, refusing a partial picture when a chunk
failed. After each nightly or dispatched run, the
[`mutants-report`](.github/workflows/mutants-report.yml) workflow
downloads that artifact and merges the actionable mutants into one
rolling issue labeled
`mutation` — "Mutation testing: actionable survivors" — on the
K-Wiki Kanban at Status = Ready. The issue body is a **merged
ledger**, never a replace snapshot: entries leave only via verified
kills (or later adjudication), out-of-scope entries stay listed, and
only a dispatched code-wide run from the default branch reconciles
the whole ledger (there, absence means death). The rolling issue is
the kill-work queue: spin
dedicated triage issues from its list when a batch is worth a pass,
and keep the count tended. The agent rules are in
[AGENTS.md](AGENTS.md).

The Kanban step authenticates with a dedicated secret — the name is
declared in the workflow file, the single source of truth: a classic
PAT with `repo` + `project` scopes (fine-grained PATs cannot access
user-owned projects, and `GITHUB_TOKEN` cannot write projects; same
constraint as the board-triage job above). When the secret is absent
the filing still happens — the board add is skipped with a warning, so
missing board access never blocks the survivor report.

`stryker.config.json` keeps `tsconfig.json` out of the sandbox
(`ignorePatterns`): the repo runs TypeScript 7 (native), whose package
ships no JavaScript compiler API, which Stryker's sandbox tsconfig
rewrite still requires (upstream: stryker-js#6111). Vitest compiles via
esbuild and needs no tsconfig. Revisit when Stryker supports TypeScript 7.

The fixture generator produces a deterministic fake vault — fixed bytes,
no timestamps — covering every case the sync layer must handle (selected,
excluded, edited, deleted, and noise files). A checked-in snapshot lives at
`tests/fixtures/Documents/`; regenerate it with
`node dev/generate.ts tests/fixtures` after changing the generator. Never
edit the snapshot by hand.

`sync.json` at the repo root is the human-owned placement configuration:
which vaults to sync, where the data repo lives (`dataRoot`), and where to
publish the mirror. The
`publish` section activates the mirror publish step: a `mirror` path
(the `KWiki Engineering` folder inside the iCloud Obsidian container's
`Documents` folder — the one iCloud Drive shows as Obsidian; mirrors are
named `KWiki <Subject>`, see
[Usage models](#usage-models)) plus the required
include patterns selecting what to publish (`["wiki/**"]` in the
shipped config). The optional `root` knob (`"wiki"` in the shipped
config) re-bases the selected files' mirror paths by stripping that
top-level segment, so the wiki tree sits at the mirror vault's root
instead of under a `wiki/` husk. Sync state —
hashes and timestamps — lives in `raw/manifest.json`, keyed per vault
namespace. Sync is idempotent: a run with no source changes
copies, removes, and writes nothing.

## Running the sync

```sh
bin/k-wiki sync-vault [--dry-run] [<sync.json>] [<raw-dir>]
```

Examples:

```sh
bin/k-wiki sync-vault --dry-run          # defaults: repo sync.json, dataRoot raw dir
bin/k-wiki sync-vault --dry-run my.json  # custom config, default raw dir
bin/k-wiki sync-vault                        # real sync, all defaults
bin/k-wiki sync-vault my.json /tmp/raw    # custom config and raw dir
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

1. `bin/k-wiki sync-vault --dry-run` — read the would-ingest list.
2. Add `wiki: false` to any note that must stay private.
3. Re-run the dry run until the list is clean.
4. Run `bin/k-wiki sync-vault` for real; check `bin/k-wiki check-raw` after.

## Running the wiki agent (`wiki-ingest`)

```sh
bin/k-wiki sync-vault   # 1. sync the vault into raw/
bin/k-wiki wiki-ingest  # 2. run the agent headless, digest the run
```

`wiki-ingest` is the unattended ingest step. It
reads `raw/manifest.json`, diffs it against the snapshot from the
previous successful run (`<dataRoot>/outputs/last-ingested-manifest.json`), and
runs the agent non-interactively **in the data repo root** — `prompts/ingest.md`
for the first run, `prompts/incremental.md` with the changed sources
(`+` added, `~` changed, `→` renamed, `-` removed) appended for every
later one, except that removals route to `prompts/expunge.md` (see
[below](#when-a-note-is-deleted-expungement)); a move is detected as a
rename even when only its frontmatter changed — identical body text
still pairs, so a same-day tag edit during a rename never expunges.
The
snapshot is stamped with the data repo it belongs to: one
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
exits 0 — unless `--sources` is present, where the explicit list is
the change set ([below](#scoped-re-ingest---sources)).

The agent invocation lives in `settings.yml` at the repo root — never
hardcoded:

```yaml
command: pi        # agent CLI, run non-interactively in the data repo
model: GLM-5.2     # passed as --model
reasoning: high    # pi thinking level, passed as --thinking
```

Unless `isolate: false` opts out, every spawned ingest and lint run
is isolated from the host's global agent setup: the
wrapper prepends `--no-context-files --no-extensions --no-skills`, so
installed context files (AGENTS.md discovery), extensions, and skills
cannot leak into headless runs. Set `false` only to debug with the
ambient global setup. Query runs are not isolated. Under isolation,
two optional list keys whitelist named entries back in:
`isolate.skills` (paths, resolved against the settings file's
directory, `~` allowed) and `isolate.extensions` (pi `-e` sources —
a path, `npm:<package>`, or `git:<repo>`); the wrapper appends one
`--skill`/`-e` flag per entry after the `--no-*` flags, so exactly
the named entries load — each one a deliberate trust grant. A missing
entry warns and is omitted; the run proceeds. Both keys are ignored
with `isolate: false`.

The per-run digest — the human's review surface while runs are
unsupervised — is written to `outputs/runs/<timestamp>.md` (gitignored
machine output; the durable review surface is the data repo's git
diff) and printed to stdout: agent command, model, reasoning level,
and isolation state (`isolated` / `not isolated`, plus whitelist
counts such as `isolated +2 skills +2 extensions`); mode and
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
sources. Before the agent runs, the wrapper warns pre-flight — one
yellow line per file with its fix (`git rm --cached <path>`), then
proceeds; a signal, not a gate — when the data repo tracks a file
that also matches an ignore rule: gitignore does not apply to
tracked files, so the rule covers nothing and an external writer
(an open Obsidian) editing the file would trip the immutability
check; `data:init` seeds the standing rules, so a fresh repo cannot
hit this. After every agent run three mechanical guardrails check the
data repo (immutability, frontmatter, wikilinks):
`wiki/log.md`, the append-only log, is exempt from the frontmatter
check (it carries none by design); a tripped check auto-reverts the data repo to its pre-run state (the
pre-run commit plus the uncommitted work that preceded the run),
writes a failure digest naming the check, and exits 1; the
one-command orchestration is [`wiki-sync`](#running-the-full-cycle-wiki-sync);
unattended scheduling is
[`setup-schedule`](#scheduling-the-pipeline-launchd).

**Timeout budgeting:** the 1800 s default fits the steady state —
incremental runs measured at 1–2 minutes (about one minute per note,
including page updates). A first full ingest is much larger (136
uningested notes at the time of the first measured full run); at the measured rate
that is hours, so give it an explicit budget, for example
`bin/k-wiki wiki-ingest --timeout 14400`, and watch the spinner's
elapsed clock. A timed-out run fails cleanly and retries the same
sources on the next run.

### Scoped re-ingest (`--sources`)

```sh
bin/k-wiki wiki-ingest --sources Engineering/AI/RAG.md   # repeatable
```

`--sources <vault/path>` re-ingests exactly the listed
sources against the existing wiki — the recovery affordance for a wiki
that is complete but under-filed. Paths are exact manifest paths
(`<vault name>/<vault-relative path>`): no globbing, no substring
matching — an unknown path is an error naming it; duplicates dedupe
and the list sorts. The explicit list replaces the manifest diff
(every path a `~` changed line) and routes to `prompts/incremental.md`
even when nothing changed. On success a scoped run writes a merged
snapshot — the previous snapshot plus the explicit paths' current
entries — so pending manifest changes outside the list stay pending
for the next ordinary run. It needs a valid snapshot:
with none, run a full ingest first (`-h` documents the switch in
full).
The digest's Mode line records `sources selected explicitly`.

A scoped run always carries an operator note: `--note
<text>` rides verbatim below the changed-source list under an
`Operator note:` heading — the why behind a re-opened set — and
without `--note` a static default line states that unchanged content
does not imply a no-op and asks the agent to re-adjudicate filing
decisions, so a recovery run never re-applies the no-change
precedent. `--note` requires `--sources` and never lands on ordinary
incremental, expunge, or full runs.

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
changed sources are ingested in the same run.

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
identical content — or identical body text, frontmatter edits aside —
in the same sync is a **move**, not a deletion: the
run treats it as a change/retitle (`→ vault/old → vault/new`) and never
routes to expunge. A rename *with* body edits still routes to expunge.

Afterwards, `bin/k-wiki check-provenance <wiki-dir>` is the permanent
backstop: every `sources` entry and every `origin` must resolve, so a
missed purge surfaces as a dead link, not as silent contamination.

## Running the full cycle (`wiki-sync`)

```sh
bin/k-wiki wiki-sync   # sync → ingest → lint → crosslinks (configured) → citation wall → verification → commit → publish (configured)
```

`wiki-sync` is the one-command orchestrator.
It chains the proven pieces and adds no capability of its own:

1. **sync** — `sync-vault` in-process: vault → `raw/`. A repo-sourced
   config ([§9](#9-the-meta-wiki-a-repository-as-source), e.g.
   `sync-meta.json`) runs the `sync-repo` core in-process instead:
   the allowlisted files of the committed source tree project
   verbatim into `raw/notes/<name>/`, stamped with the source HEAD
   commit; only tracked files are selected (gitignored allowlisted
   files are skipped), tracked changes or untracked-selectable files
   fail the cycle (untracked scratch no pattern can select does not
   block), and mixed vault+repo configs are refused — one instance
   per config.
2. **ingest** — `wiki-ingest` in-process: the agent over changed
   sources, the post-run guardrails, the digest in the code repo's
   `outputs/runs/` (gitignored, per-checkout).
3. **lint** — the headless sibling of the manual lint run: the same
   `prompts/lint.md`, through the same agent settings, in a fresh
   agent session in the data repo root. The report lands in the
   **data repo's** `outputs/lint-<date>.md` (the standing convention:
   quality history travels with the content), and the same three
   guardrails check the run with the same auto-revert. The orchestrator
   pins the date and passes the concrete report path in the prompt, so
   its report check and the prompt cannot disagree.
4. **crosslinks** — second brains only: an instance whose
   settings carry `secondBrain.domains: [<wiki dirs>]` gets the
   `check-crosslinks` audit run over its wiki against every listed
   domain wiki — every cycle, including no-change cycles, after lint
   and before the commit. One broken or forbidden `[[<vault>/<page>]]`
   link fails the cycle (exit 1, one `file:line -> [[link]]` line per
   problem, no commit — the uncommitted diff is the fix surface), so
   the wiki/AGENTS.md "after every run" contract is enforced, not
   prose. Instances without the key skip the stage; the default
   instance is unchanged.
5. **citations** — every cycle, configured or not: the one-way
   sandbox audit (`bin/libexec/check-citations`' core) runs over
   the data repo's working tree after the crosslink audit and before
   verification. Main pages must never link, embed, or cite sandbox
   pages; sandbox pages must never carry `sources` edges,
   sandbox-peer links, or cross-wiki links; the `via: agent` stamp
   lives only inside `wiki/sandbox/`. One violation line fails the
   cycle before the commit — after path-scoped-reverting every
   offending page to its last committed state (never a whole-repo
   reset), so a rogue edge never rides the cycle's commit. A wiki
   without a sandbox namespace runs the stage as a near-no-op (only
   the stamp-placement rule can trip); the base path gains no flag,
   no concept, no required step.
6. **verification** — every cycle, configured or not:
   the deterministic `check-fidelity` and
   `check-provenance` cores run over the data repo's
   `wiki/` and `raw/`, after lint, the crosslink audit, and the
   citation wall. One problem line per finding fails the cycle
   before the commit: the lint edits are reverted (the ingest edits
   stay, uncommitted, as the fix surface), mirroring the lint stage's failure semantics.
   The misquote and dead-citation classes are produced by ingest;
   the cycle is where their detection is guaranteed to run.
7. **commit** — one data-repo commit staging `wiki/`, `raw/`, and
   `outputs/`, with a message summarizing sources processed, pages
   touched, and the lint report.
8. **publish** — only for configs whose `sync.json` carries a
   `publish` section: copy the data repo's
   include-matched files (`["wiki/**"]` in the shipped config)
   into the mirror vault — an iCloud-served disposable
   reading copy that iPhone and iPad open in Obsidian. With
   `publish.root` set (`"wiki"` in the shipped config)
   the top-level segment is stripped from every mirror path, so the
   wiki tree appears at the vault root; without it the copy is
   verbatim. Deletions
   included: a page gone
   from the wiki leaves the mirror on the next run; the mirror's own
   `.obsidian/` device state is never touched; byte-identical files
   are never rewritten, so a second run over an intact mirror changes
   nothing. Runs after the commit, every cycle — a mirror the
   transport mangled is healed by the next run. A publish failure
   fails the cycle (exit 1) after the commit has landed; the next run
   retries the copy.

The final digest on stdout — sync summary, lint summary, the
crosslink audit result (configured instances), the citation-wall
result, the fidelity and provenance results, the commit hash, the
publish summary (configured mirror), then the full ingest digest —
plus `git log -1` in the data repo tell the whole story of the run
without opening any other file.

Every cycle holds the shared run lock — the same
`<dataRoot>/.scheduled-run.lock` the scheduled wrapper takes — from
before its first stage until after its last, released on success,
failure, and guardrail revert alike. When another run (manual or
scheduled) holds a fresh lock, `wiki-sync` refuses loud with one
line naming the holder — `a run has been in progress since HH:MM
(PID N) — retry in a few minutes` — instead of two cycles colliding
at the git layer (`index.lock`); a lock older than two hours is a
dead run's and is taken over. The lock is one per data repo, so
independent instances never contend.

With no changed sources the agent stages skip (cost scales with
activity, not the clock), a clean data repo commits nothing, and the
command exits 0 — a configured crosslink audit and the verification
checks still run, and their passes are noted in the digest.
Because the skip keys on the ingest snapshot — which a failed agent
run leaves untouched — the next cycle retries a failed ingest even
when sync then reports no changes. Lint gets no such retry: it runs
only in a cycle whose ingest ran, so after a failed lint the report
waits for the next cycle with changed sources (or a manual lint run).
A failure at any stage stops the chain and exits 1; a tripped
guardrail has already reverted its agent run, and a verification
failure has reverted the lint edits. Switches:
`--settings <path>`, `--outputs <dir>` (the run digest location;
default the repo's `outputs/`; the ingest snapshot always lives in the
data repo's `outputs/`),
`--timeout <secs>` (default 1800, applies to both agent stages), plus
the `<sync.json>` and `<raw-dir>` positionals — `-h` documents them
all. Unattended scheduling is `setup-schedule` —
[next section](#scheduling-the-pipeline-launchd).

## Scheduling the pipeline (launchd)

```sh
bin/k-wiki setup-schedule                        # install: every 30 minutes
bin/k-wiki setup-schedule --interval 15minutes  # re-register with a new interval
bin/k-wiki setup-schedule --print             # emit the plist, install nothing
bin/k-wiki setup-schedule --uninstall         # bootout the job and remove the plist
```

`setup-schedule` registers the pipeline with launchd:
the job runs `node bin/scheduled-run` on a fixed interval —
`StartInterval 1800` by default, `RunAtLoad` — from the checkout you
installed it from, with absolute node + script paths, an explicit
`HOME`, and a minimal `PATH` (the wrapper builds the rest). The
pinned node path is the **invocation path** when absolute and
existing (e.g. `/opt/homebrew/bin/node`, stable across Homebrew
upgrades — the resolved binary lives in a versioned Cellar and
breaks on every `brew upgrade node`), falling back to
the resolved binary. Register through the stable path once —
`/opt/homebrew/bin/node bin/k-wiki setup-schedule` — to move an
existing install off a versioned Cellar path. The same rule holds for
the pinned script path: after pulling a change that renames or moves
the launcher (as the switch to extensionless launcher names did),
re-run `bin/k-wiki setup-schedule` once — until then the installed job
points at the deleted path and every tick fails into
`launchd-stderr.log` with `MODULE_NOT_FOUND`, leaving the wiki stale
with no other alert. The plist
lands at `~/Library/LaunchAgents/com.kwiki.scheduled-run.plist` and is
verified with `launchctl print` before the installer reports success.
After installing, one manual kick proves the whole path:

```sh
launchctl kickstart gui/$(id -u)/com.kwiki.scheduled-run
```

`scheduled-run` wraps the manual cycle with exactly what unattended
operation needs and nothing else:

1. **lockfile** — an atomic `O_EXCL` lockfile (PID + timestamp) at
   `<dataRoot>/.scheduled-run.lock` prevents concurrent runs on the
   same machine; a lock older than two hours is taken over, so a
   killed run never wedges the schedule. The lock is shared with
   manual `wiki-sync` runs: a manual cycle in progress makes the
   next scheduled firing skip — its note names the holder's PID and
   start time — while a scheduled cycle in progress makes a manual
   `wiki-sync` fail loud with the same holder line instead of
   colliding at the git layer. The lock lives at the data repo root,
   one per instance, outside `wiki-sync`'s commit pathspecs so the
   sync can never stage it.
2. **`git pull --rebase`** — the run starts on a fresh base; any
   overlap that slipped through (lock stolen, raw git run by hand,
   second machine) surfaces as a rejected push, never silently
   diverged history. Skipped when the data repo tree is dirty —
   a failed sync deliberately leaves its edits uncommitted (the
   fix surface), and a rebase would refuse them; the push-rejection
   path then owns any divergence.
3. **`wiki-sync`** — unchanged: the full gated cycle ending in a
   local commit. `wiki-sync` stays commit-only; nothing in an
   interactive run pushes.
4. **`git push`** — unattended pushing is consented to here and only
   here, after the guardrails and checks have passed. A rejection
   gets one `git pull --rebase` + retry; a second failure logs an
   `ALERT` line and exits 1. The data repo must have an `origin`
   remote — the wrapper fails loud without one.

Every failure other than the push retry waits for the next interval
by design — no retry/backoff. The guardrails and
verification have already reverted a broken run, so the wiki stays at
the last good commit and the log tells the story.

**Logs:** `~/Library/Logs/k-wiki/scheduled-run.log`, rotated at 5 MiB
(one previous generation kept). The log carries the run's progress,
wiki-sync's digest, and any error. launchd's own captures land beside
it (`launchd-stdout.log`, `launchd-stderr.log`) for failures before
Node even starts. `KWIKI_SCHEDULED_LOG` overrides the location.

**Behavioral edges:**

- **Mac asleep** — launchd coalesces missed intervals: one run at
  wake, never a pile-up. iCloud lag is the same story — a note still
  in flight lands on the next run; never retry.
- **First run after boot/login** — `RunAtLoad` runs the job once at
  load, deterministically.
- **iCloud lag** — manifests make sync idempotent; the next interval
  catches up. Event triggers (`fswatch`, `WatchPaths`) are rejected
  by design: iCloud materializes files lazily, so file events fire
  late, in bursts, or only on download.
- **Push rejection** — pull --rebase + retry once, then alert (log
  `ALERT`, exit 1, launchd records the non-zero exit). A conflicted
  rebase is aborted (`git rebase --abort`) before the next pull site,
  so the next tick retries with the tree actionable; divergent
  content is resolved manually.

**Multi-machine rule:** enable the scheduler on exactly one machine
— the source vault lives in iCloud, so only macOS can run the
pipeline anyway. Other machines pull read-only (`k-wiki query` on a
clone of the data repo) or run manual gated `wiki-sync` cycles. The
lockfile prevents same-machine overlap; cross-machine overlap is made
recoverable by the pull --rebase + rejected-push sequence, not
prevented. If a second machine ever needs a scheduled sync, the known
upgrade is a lease lock as a git ref in the data repo — deliberately
deferred until then. Linux (systemd timer) and Windows (Task
Scheduler) backends are follow-up issues: the installer fails loud
on non-macOS platforms (`--print` still emits the macOS plist
everywhere), and the platform switch keeps them additive.

### The meta wiki: post-merge auto-sync (git hooks)

```sh
bin/k-wiki setup-meta-sync                 # once per machine
bin/k-wiki setup-meta-sync --print         # emit the hook, install nothing
bin/k-wiki setup-meta-sync --uninstall     # remove exactly what was installed
```

The meta wiki's source changes only when k-wiki's `main` moves —
an event — so the engineering wiki's interval schedule is the
wrong shape here: a timer mostly runs no-op cycles and still misses
the freshness point. The right trigger is the merge itself.
`setup-meta-sync` writes two git hooks (`post-merge` for merges,
`post-rewrite` for rebase-based pulls) into the checkout's shared
hooks dir — `git rev-parse --git-path hooks`, so the canonical
checkout and its linked worktrees are all served — with every path
baked absolute at install time: the node binary (the invocation
path, stable across Homebrew upgrades), the canonical checkout
(never the linked worktree the installer may run from), the meta
configs inside it, `<dataRoot>/raw` from `sync-meta.json`, and the
fire log.

The hook guards before firing: the fire must land in the
canonical checkout (a merge on `main` inside a linked worktree
log-and-skips — the cycle projects the canonical checkout's tree,
and syncing any other tree would write the wrong content), the
current branch must be `main`, and `git status --porcelain` fully
clean — dirty and untracked included. Anything else log-and-skips
(the reason goes to the log; `k-wiki health` keeps flagging the
staleness until a real fire).
A clean merge on `main` fires one detached cycle —
`nohup bin/scheduled-run --settings settings-meta.yml sync-meta.json
<dataRoot>/raw &` — so the merge returns instantly while the cycle
(minutes of real LLM ingest) runs in the background under
`scheduled-run`'s own per-dataRoot lockfile, pull/push, and
push-rejection retry. Install is idempotent (an identical hook is
left alone — only its executable bit is repaired if lost, an older
generation of ours is replaced, a foreign hook without the
installer's marker is refused loud and never touched). One log
line per fire, plus the cycle's own output:
`~/Library/Logs/kwiki/meta-sync.log` on macOS, the XDG state dir
elsewhere.

Install runs **once per machine** — hooks live in the git hooks
(dir from `git rev-parse --git-path hooks`), unversioned — and two
machines may merge and both fire safely:
separate data-repo lockfiles, and the data-repo pull/push
serializes the wiki state. The prerequisite is a **private
`origin` remote on the meta data repo** (`scheduled-run` fails
loud without one); both machines then converge on one wiki through
it. Known gap: which git operations fire which hook is
git-version-dependent — a fast-forward `git pull` fires
`post-merge` on current git but may not on older versions, and a
pure fast-forward `pull --rebase` rewrites nothing and so fires
`post-rewrite` not at all. On any machine, `k-wiki health` is the
honest freshness signal; the manual one-command cycle above is
always available, and a long-interval launchd catch-up job is the
recorded follow-up if the gap ever bites.

## Running queries (`wiki-query`)

```sh
bin/k-wiki wiki-query "When should I prefer RAG over fine-tuning?"   # stage 1: answers, saves for review
bin/k-wiki wiki-query --file-last                                  # stage 2: files the reviewed answer
```

`wiki-query` is the terminal front-end for asking the built wiki a
question. Filing is two-stage, and an
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
  appends the `log.md` entry (`## [date] query | <question>`). The
  three writes are a unit: a failure anywhere in the filing rolls
  all of them back — no half-filed wiki is left behind. It fails
  cleanly when no saved answer exists, and warns when the data
  repo's `raw/` or `wiki/` changed after the saved timestamp — the
  answer cites pages that may have moved; the warning does not block
  the filing.

The old `--no-filing` switch is gone (superseded): answer-only is
the default, and there is exactly one filing path (`--file-last`).
Stage 1 switches: `--settings <path>`, `--outputs <dir>`,
`--raw-dir <dir>`, `--timeout <secs>` (default 1800) — and
`--wiki <name>` to run both stages against another instance in the
same checkout ([§9](#9-the-meta-wiki-a-repository-as-source)):
resolution goes alias (`sync.json`'s `instances` map) → stem
(`sync-<name>.json`) → listing error, the derived raw dir, outputs
dir, and settings follow the resolved config, an explicit flag always
overrides its derived counterpart, and the filing hint echoes the
flag so a meta answer cannot be filed into the regular wiki by
mistake. `-h` documents them all.

## Querying from any project (`k-wiki`)

```sh
k-wiki query "When should I prefer RAG over fine-tuning?"   # any cwd inside a bound project
k-wiki status                                               # which wiki am I bound to — and how fresh?
k-wiki list [concept|entity|source|query|comparison]       # pages by type
k-wiki read retrieval-augmented-generation                 # one page verbatim
k-wiki health                                               # projection coherence/freshness
k-wiki propose my-candidate note.md                        # hand one candidate note to the human (sandboxed)
```

Every verb answers `k-wiki <verb> --help` — or `-h`, in either
position — with its own scoped help: usage, switches, defaults,
what it writes, exit semantics. `k-wiki --help` on its own stays
the tiered front-door table.

`k-wiki` is the universal front door — the same one executable that
serves the operator tiers above — and which verbs answer depends on
the door, decided by checkout resolution:

- **Agent door** — the resolution chain resolves a binding (the
  `--checkout` flag, `K_WIKI_CHECKOUT`, or a `.k-wiki.json` found
  walking up): the five read verbs above plus `propose`, the one
  agent write verb — `completion`, the door-free shell plumbing
  ([below](#shell-completion-zsh)), answers too. Every
  operator verb is refused with both escapes named (`cd` into the
  checkout, or the standalone launcher). The query is answer-only
  by construction, so exposing it to agents is safe; the write
  path is redirected, not exposed raw: a `propose` write is a
  sandbox write — it can only land under `wiki/sandbox/` of the
  bound instance, gated, stamped, and committed atomically, and a
  run touching anything else reverts itself and fails. This door
  can never write the reviewed wiki, whatever flags an agent
  passes or omits.
- **Human door** — the chain falls back to the cwd being the
  checkout (run from inside it): the full verb table, and a
  flag-less run resolves the checkout's root `sync.json` — the
  default instance, structural, never configured.

Every run that resolves a door first prints two dim stderr lines —
the resolved door and instance — so wrong-door and wrong-corpus
calls are visible in the transcript. `-w <name>` (or `--wiki <name>`)
selects the instance
on any verb that takes it — aliases first, then `sync-<name>.json`
stems — and overrides the binding's `wiki` key; the verb-first
spelling is canonical (`k-wiki query -w meta` ≡ `k-wiki -w meta
query` — a leading `-w`/`-h` is reordered after the verb; a
verb-specific flag before the verb is a usage error).

Binding file `.k-wiki.json` at the bound project's root:

```json
{ "checkout": "~/k-wiki", "wiki": "meta" }
```

- `checkout` — a k-wiki checkout whose `sync.json` resolves the data
  repo; its `prompts/`, outputs, and settings live there too.
- `wiki` — optional instance name inside that checkout: resolved
  through the checkout's registry (an alias in `sync.json`'s
  `instances` map first, then a free stem `sync-<name>.json`), so the
  binding selects the corpus, the settings file, and the outputs dir
  together — the answer is saved to that instance's
  `outputs-<stem>/last-query.md` and `k-wiki status` names the
  resolved config and data repo. Without the key the default
  instance answers; an optional `settings` key (a settings file
  inside the checkout) overrides the derived settings file.
- One project binds exactly one wiki: the file must be a single
  JSON object; lists and multi-wiki forms are rejected. That 1:1
  limit is the safety property — no ambient path between work and
  personal knowledge.
- Gitignore the file in personal projects; commit it in team
  projects.

Checkout resolution order (first hit wins): the `--checkout <path>`
flag, the `K_WIKI_CHECKOUT` environment variable, the nearest
`.k-wiki.json` walking up from the cwd (stopping at the home
directory or the filesystem root), then the cwd itself — the human
door. Bindings belong to consumer projects: the checkout root stays
unbound by design (flag-less must mean the same thing in the same
place), and agents working inside the k-wiki checkout itself
compose `--checkout <its checkout> -w <its wiki>` from the
checkout's `.agents/.k-wiki.json` — the k-wiki skill carries that
mandate.

### Shell completion (zsh)

`k-wiki completion [<shell>]` emits the completion function for the
front door — static shell plumbing (`zsh` is the only shell today,
the default; an unknown shell is a usage error): no checkout,
instance, or door is resolved, nothing is written, and the output
is byte-identical on every run. Try it now, zero setup:

```sh
source <(k-wiki completion zsh)
```

Keep it permanently:

```sh
mkdir -p ~/.zfunc
k-wiki completion zsh > ~/.zfunc/_k-wiki
# ~/.zshrc:
#   fpath=(~/.zfunc $fpath)
#   autoload -Uz compinit
#   compinit
```

After either install, `k-wiki <TAB>` lists the verbs grouped by the
bare-help tiers and `k-wiki query -<TAB>` offers the global flags
(`-w`/`--wiki`, `-h`/`--help`, `--checkout <path>` completing
paths). If you invoke `k-wiki` through a shell alias
(`alias k-wiki='node ~/k-wiki/bin/k-wiki'`), also `setopt
COMPLETE_ALIASES` — otherwise zsh completes the alias's expansion
(`node`) for the words after the verb; putting the checkout's `bin/`
on `PATH` avoids the alias entirely. Verb arguments (the question
text, `read`'s slug, `list`'s type filter) are not completed — the
emitter is static by design.

There is no filing passthrough: `--file-last` stays the human-run
`wiki-query` verb inside the checkout (`wiki-query --wiki <name>
--file-last` when the binding named an instance). The one agent
write path is `k-wiki propose <slug> [<file>]` — redirected filing:
the note body (file or stdin) lands under `wiki/sandbox/` as one
gated run (`via: agent` and `expires:` stamps, one atomic
`sandbox: <slug>` commit, a `wiki/log.md` audit entry; any
main-tree delta reverts the run and fails it), where a human
reviews and promotes it. The sandbox is honest about what it is:
structural friction + deterministic detection + undo + audit —
never a security boundary against a shell-capable agent on the
same machine. The read-only
verbs open no write path: `status` prints the resolution chain
(checkout, origin, instance, sync config, settings, data repo,
outputs dir, wiki dir, `index.md`) plus a `last change:` line —
the data repo's last commit time (`never` for a fresh,
never-committed data repo). It states the fact; the staleness
verdict stays with `health`;
`list` prints one `slug — title` line per page grouped by type
in the `index.md` order (the navigation pages `index`,
`log`, `overview` are read by name instead); `read` prints one page
verbatim by file name with near-match suggestions when absent and
an ambiguity error on duplicate file names; `health` delegates to the
read-only `check-raw` coherence/freshness check against the bound
projection (`--fail-on-stale` makes staleness blocking). A wrong
pairing (a binding whose checkout resolves an unexpected data repo)
fails loudly via the existing guardrails — no silent cross-wiki
reads. Humans can add a shell alias:
`alias k-wiki='node ~/k-wiki/bin/k-wiki'`.
