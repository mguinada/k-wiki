---
name: verify-k-wiki
description: Drive the real k-wiki pipeline CLIs (bin/sync-vault, bin/wiki-ingest, bin/wiki-sync, bin/wiki-query, the bin/check-* guardrails) end to end in throwaway temp data repos with a stub agent replacing the LLM, and capture proof artifacts. Use when asked to verify, prove, or manually exercise k-wiki behavior outside the vitest suites — e.g. "prove sync works", "verify the ingest cycle", "drive the pipeline like a user".
---

# Verify k-wiki

k-wiki is a pipeline of short-lived CLIs (no server, no UI): an
Obsidian vault syncs into an immutable `raw/` projection, an LLM agent
maintains a `wiki/` from it, and guardrail checkers audit the result.
Verification = running the real `bin/` launchers as child processes
against throwaway temp state, exactly like `tests/e2e/` does, and
capturing exit codes, stdout reports, written files, and git history.

## The one rule that matters most

**Never run a `bin/` CLI bare (without arguments).** A bare run uses
the repo's real `sync.json` — the user's real iCloud vault and the
real data repo at `~/Lab/k-wiki-engineering-data`. Every drive below
passes an explicit `<config>` and `<raw-dir>` so it can only touch
temp state. If a command here is ever run bare, stop and report it.

The only external system is the agent CLI (`pi` + model credentials).
It is a production boundary: `settings.yml`'s `command:` names it, so
a stub executable receives the exact argv the real agent would.
Verification always uses the stub (`helpers/stub-agent.mjs`) — no
credentials, deterministic, and it records the composed prompt for
inspection. A real LLM run stays a human decision (it costs money).

## Launch

Nothing stays alive. Prepare the checkout once, then every drive is
its own short-lived `bin/<cmd>` process:

```sh
cd <repo-root>
npm install          # once per checkout; Node >= 22.18, no build step
node bin/sync-vault --help; echo $?   # prints usage, exit 0 => ready
```

Teardown is just Cleanup (below) — there is no server to stop and no
process to kill; each CLI exits on its own.

## Doctor

One read-only check that the checkout is worth driving — dependencies
installed and the CLI layer loads:

```sh
test -d node_modules && node bin/check-raw; echo $?
```

Expect exit `0` (`check-raw` defaults to the repo's skeleton `raw/`,
which is healthy-empty; it reads nothing from the vault). Any other
exit, or a module-not-found error: run `npm install` and retry once
before declaring the checkout broken.

## Drive

The harness is plain shell. Scratch instances live under
`.verify-tmp/<run-id>/` at the repo root; every path a command
touches is inside that directory.

### 1. Scratch workspace (fixture vault + temp config)

```sh
cd <repo-root>
RUN_ID=$(date +%Y%m%d-%H%M%S)-$RANDOM
S=$PWD/.verify-tmp/$RUN_ID; EV=$PWD/.verify-evidence/$RUN_ID
mkdir -p "$S" "$EV"
node dev/generate.ts "$S"   # deterministic synthetic vault at $S/Documents
cat > "$S/sync.json" <<EOF
{"vaults":[{"name":"Documents","root":"$S/Documents","exclude":"wiki:false"}]}
EOF
```

The fixture vault is byte-stable and covers every sync case (selected,
excluded via `wiki: false`, edited, deleted, noise). The config
deliberately has no `dataRoot`, so the raw-dir argument below is what
keeps writes inside `$S` — that is the isolation mechanism.

### 2. Sync drive (deterministic, no agent)

```sh
bin/sync-vault "$S/sync.json" "$S/raw" >"$EV/sync.out" 2>"$EV/sync.err"; echo $? >"$EV/sync.code"
find "$S/raw" -type f | sort >"$EV/sync.files"
node bin/check-raw "$S/raw" >"$EV/check-raw.out" 2>&1; echo $? >"$EV/check-raw.code"
```

Expect: sync exit 0, a report listing the 7 selected notes (under
`raw/notes/Documents/AI/…`, `Inbox/…`, `Scratch/temp-research.md`),
`raw/manifest.json` present, and `check-raw` exit 0.

### 3. Data repo + stub agent (for every LLM-path drive)

The agent runs with the data repo as cwd; the data repo root is the
dirname of the raw-dir argument.

```sh
D=$S/data; mkdir -p "$D/wiki"; git init -q "$D"
git -C "$D" config user.email t@t; git -C "$D" config user.name t
bin/sync-vault "$S/sync.json" "$D/raw" >/dev/null 2>&1   # seed the projection
printf '# Index\n' > "$D/wiki/index.md"
git -C "$D" add -A && git -C "$D" commit -qm init
cat > "$D/settings.yml" <<EOF
command: $PWD/.agents/skills/verify-k-wiki/helpers/stub-agent.mjs
model: VERIFY-STUB
reasoning: low
EOF
mkdir -p "$S/outputs"
```

### 4. Ingest / cycle / query drives

```sh
# ingest: agent run + post-run guardrails + digest
bin/wiki-ingest --settings "$D/settings.yml" --outputs "$S/outputs" "$D/raw" \
  >"$EV/ingest.out" 2>"$EV/ingest.err"; echo $? >"$EV/ingest.code"
# full cycle: sync -> ingest -> lint -> verification -> one data-repo commit
bin/wiki-sync --settings "$D/settings.yml" --outputs "$S/outputs" "$S/sync.json" "$D/raw" \
  >"$EV/cycle.out" 2>"$EV/cycle.err"; echo $? >"$EV/cycle.code"
git -C "$D" log --oneline >"$EV/cycle.gitlog"
# query: answer printed to stdout, artifact saved for review
bin/wiki-query --settings "$D/settings.yml" --outputs "$S/outputs" "What is in the wiki?" \
  >"$EV/query.out" 2>"$EV/query.err"; echo $? >"$EV/query.code"
```

Expect: exit 0 for each; ingest leaves wiki pages with contract
frontmatter under `$D/wiki/` and a digest at
`$S/outputs/runs/<timestamp>.md`; the cycle adds exactly one commit on
top of `init` (`$EV/cycle.gitlog`); query stdout holds the stub's
answer line. The stub records what the agent actually saw at
`$D/outputs/stub-prompt.txt` and `stub-argv.txt` — read them when a
drive's behavior needs explaining.

To drive a change (edit, deletion, `wiki: false` flip), mutate a file
under `$S/Documents/…`, re-run step 2's sync into `$D/raw`, then
re-run the ingest drive: the digest should describe only the delta.

### Stable handles

Prefer these over line numbers or fragile text: exit codes (0 ok,
1 problems listed one per line, 3 stub saw no prompt), the stdout
report tables, `raw/manifest.json` sha-256 entries, the digest file
list under `outputs/runs/`, and `git log` in the data repo.

## Evidence

Proof artifacts go to `.verify-evidence/<run-id>/` at the repo root
and survive cleanup. A proof is complete when it shows:

- the action: the exact command line(s) run and their exit codes
  (`.code` files, captured above);
- the resulting state: written files (`.files` listings), the digest,
  the data repo's `git log`/`git show --stat` — not just the final
  stdout;
- side effects verified outside the process: `check-raw` /
  `check-links` / `check-provenance` / `check-fidelity` exit codes
  against the temp data repo, run as separate read-only commands.

Standards: exercise the real user path (the `bin/` launchers with
explicit args — no test-only flags, no direct `src/` imports); the
only mock is the stub agent, which sits exactly on the production
boundary (`settings.yml` `command:`) and receives production argv.
For `--dry-run` flavors, verify by observation (list files before and
after) rather than trusting the name.

## Cleanup

Remove exactly what this run created — the scratch tree, never the
evidence:

```sh
rm -rf "$S"
ls "$EV"   # confirm the proof artifacts survived
```

There is nothing to kill: no long-running process is ever started. Do
not touch `.verify-tmp/` entries from other run-ids (concurrent
runs), the repo's own `raw/`, `wiki/`, or `outputs/`, or anything
under `~/Lab` or the vault paths in the real `sync.json`.

## Helpers

- `helpers/stub-agent.mjs` — executable node script named by the temp
  `settings.yml`'s `command:` (step 3). Records the composed prompt
  and argv under `<data-repo>/outputs/`, answers query prompts
  plainly, writes guardrail-clean wiki pages on ingest prompts,
  removes them again on expunge prompts, and exits 3 if the wrapper
  ever fails to pass the prompt.
