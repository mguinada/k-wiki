# Wiki ingest

Ingest diffs `raw/manifest.json` against the last successful ingest,
runs the agent (stubbed in verification) over the changed sources with
the composed prompt, writes the per-run digest, and then runs the
post-run guardrails (checks + auto-revert on failure).

## Sub-features

- `ingest-first`: first run is a full ingest over every source.
- `ingest-incremental`: only changed sources are re-processed.
- `ingest-noop`: no manifest change skips the agent entirely.
- `ingest-expunge`: a removed note routes to expungement (pages
  deleted, digest says so).
- `ingest-guardrail-revert`: an agent run that leaves broken wiki
  state is auto-reverted; the digest reports it.
- `ingest-snapshot`: the manifest snapshot lands in the data repo's
  `outputs/last-ingested-manifest.json`, stamped for the next delta.

## How to get to it (user POV)

- Run `bin/wiki-ingest --settings <settings.yml> --outputs <dir>
  [<raw-dir>]` from the checkout root; read the digest it prints
  (also saved under the outputs dir).

## Driving it with the CLI harness

Preconditions:

- Temp data repo `$D` with seeded `raw/`, `wiki/index.md`, git
  identity, and `settings.yml` naming the stub agent — SKILL.md Drive
  step 3.
- Outputs dir `$S/outputs` (separate from the data repo).

- **First run.** Run `bin/wiki-ingest --settings "$D/settings.yml" --outputs "$S/outputs" "$D/raw"`. Exit 0; the digest on stdout describes the processed sources; `$D/wiki/concepts/stub.md` and `$D/wiki/sources/stub-source.md` exist with contract frontmatter (`title`, `type`, `created`/`updated`, `sources`); the digest file exists under `$S/outputs/runs/`; the snapshot exists at `$D/outputs/last-ingested-manifest.json`.
- **What the agent saw.** Read `$D/outputs/stub-prompt.txt` (the composed prompt) and `$D/outputs/stub-argv.txt` (the flags the real agent CLI would receive). Asserting on these beats guessing why a run behaved oddly.
- **No-op.** Re-run the same command. Exit 0 with a skip — the stub was not invoked again (`$D/outputs/stub-prompt.txt` mtime unchanged, or digest says no change).
- **Incremental.** Edit a vault note under `$S/Documents`, re-run the sync into `$D/raw` (`bin/sync-vault "$S/sync.json" "$D/raw"`), then re-run ingest. The digest covers only that note's sources.
- **Expunge.** Delete a vault note, re-sync, re-run ingest. The digest reports expungement and the stub removes its seeded pages (`stub-source.md` gone); `bin/check-links "$D/wiki"` still exits 0.
- **Guardrail revert.** Sabotage the stub's output (e.g. `echo 'break' >> "$D/wiki/index.md"` before the guardrail stage is not controllable this way — instead point `settings.yml` `command:` at a script that writes a page with no frontmatter). Ingest exits non-zero or reports the revert; `git -C "$D" status` shows a clean tree (auto-revert).
- **Proof.** Digest file, `$D/outputs/stub-prompt.txt`, the wiki file listing, and a `git -C "$D" log --oneline` into `$EV`.

## Gotchas

- The stub runs with cwd = the data repo; its writes under
  `<cwd>/outputs/` are inside the data repo, its wiki writes land in
  `$D/wiki`.
- The snapshot lives in the data repo's `outputs/`, not the
  `--outputs` dir — a snapshot found elsewhere is a bug.
- Exit 3 from the stub means the wrapper passed no `--print` payload;
  treat it as a harness bug, not app behavior.
