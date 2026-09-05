# Full cycle

`wiki-sync` chains the whole pipeline into one command — sync
(sync-vault) → ingest → lint → configured crosslink audit →
verification (check-fidelity + check-provenance) → exactly one
data-repo commit → optional mirror publish — and prints the digest.

## Sub-features

- `cycle-full`: vault change flows to a committed wiki in one command.
- `cycle-nochange`: a re-run with no vault change is a fast no-op.
- `cycle-failure`: a failing stage fails the cycle before the commit.
- `cycle-commit`: exactly one regeneration commit per run; the next
  digest covers only its own run.

## How to get to it (user POV)

- Run `bin/wiki-sync [--settings <path>] [--outputs <dir>]
  [<sync.json>] [<raw-dir>]` after editing vault notes; review the
  printed digest, then `git log -1` in the data repo.

## Driving it with the CLI harness

Preconditions:

- Temp data repo `$D` + stub settings per SKILL.md Drive step 3, and
  the scratch config `$S/sync.json`.
- The raw-dir argument must be inside the data repo (`$D/raw`); the
  data repo root is its dirname.

- **Full cycle.** Touch a vault note under `$S/Documents`, then run `bin/wiki-sync --settings "$D/settings.yml" --outputs "$S/outputs" "$S/sync.json" "$D/raw"`. Exit 0; the digest covers the touched note; `git -C "$D" log --oneline` shows exactly one new commit on top of `init`; `git -C "$D" show --stat HEAD` touches `raw/`, `wiki/`, and the digest.
- **No change.** Re-run immediately. Exit 0, no new commit (`git -C "$D" log --oneline` unchanged), digest reports nothing to do.
- **Failure before commit.** Point `settings.yml` `command:` at a stub variant that exits 1 (e.g. a one-line `process.exit(1)` script, chmod 755). Re-run the cycle after a vault touch. The cycle fails; `git -C "$D" log --oneline` shows no new commit — nothing half-done was committed.
- **Verification stages ran.** The cycle output names the lint and verification stages; on success they are part of the digest/progress lines. A sabotaged wiki (hand-edit `$D/wiki/concepts/stub.md` to drop its `sources`) makes the next cycle fail before the commit.
- **Proof.** `git -C "$D" log --oneline`, `git -C "$D" show --stat HEAD`, the digest file, and the cycle stdout/stderr into `$EV`.

## Gotchas

- The mirror publish stage is configured via the real `sync.json`'s
  `publish` section; the temp config omits it, so verification covers
  the no-publish path. Driving publish would write into a vault —
  do not wire the temp config at the user's mirror.
- `--timeout` caps the agent run (default 1800 s); the stub finishes
  in milliseconds, so leave it unset during verification.
- The cycle refuses a dirty data repo where its contracts demand a
  clean base; a "dirty tree" failure usually means a previous drive
  left uncommitted sabotage — `git -C "$D" status` first.
