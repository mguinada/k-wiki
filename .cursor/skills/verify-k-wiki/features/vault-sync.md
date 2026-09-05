# Vault sync

Sync projects every vault note not blocked by its exclusion rule
(`wiki: false` frontmatter) into an immutable `raw/notes/<vault>/`
projection with a sha-256 `manifest.json` — deterministic, no LLM.

## Sub-features

- `sync-first`: first run ingests every selected note.
- `sync-noop`: re-run with no vault change writes nothing and says so.
- `sync-edit`: an edited note is re-projected with a new hash.
- `sync-delete`: a deleted note is dropped from the projection and manifest.
- `sync-block`: a note gaining `wiki: false` leaves the projection.
- `sync-dry-run`: `--dry-run` lists what would sync and writes nothing.
- `sync-prune`: removing a vault from the config prunes its namespace.

## How to get to it (user POV)

- Run `bin/sync-vault [--dry-run] [<sync.json>] [<raw-dir>]` from the
  checkout root after editing notes in the Obsidian vault.

## Driving it with the CLI harness

Preconditions:

- Scratch workspace per SKILL.md Drive step 1 (`$S`, fixture vault at
  `$S/Documents`, temp `sync.json` with no `dataRoot`).
- Fresh empty raw dir: `mkdir -p "$S/raw"`.

- **First run.** Run `bin/sync-vault "$S/sync.json" "$S/raw"`. Exit 0; stdout report lists the 7 selected notes (`AI/RAG.md`, `AI/llms/attention-is-all-you-need.md`, `AI/rag-evaluation-notes.md`, `Inbox/clipped-note.md`, `Inbox/parking-lot.md`, `Inbox/quick-idea.md`, `Scratch/temp-research.md`); `find "$S/raw" -type f` shows `notes/Documents/**` plus `manifest.json`; excluded (`wiki: false`) and noise files (`.DS_Store`, non-md) are absent.
- **No-op re-run.** Run the same command again. Exit 0 with a no-change report; `find "$S/raw" -type f | sort` is byte-identical to the first run's listing.
- **Edit.** Append a line to `$S/Documents/Scratch/temp-research.md`, re-run. The report lists only that note; its manifest hash changed (`grep temp-research "$S/raw/manifest.json"`).
- **Delete.** `rm "$S/Documents/Inbox/quick-idea.md"`, re-run. The note is gone from `notes/Documents/Inbox/` and the manifest.
- **Block flip.** Add `wiki: false` frontmatter to `$S/Documents/Inbox/parking-lot.md`, re-run. The note leaves the projection (same report shape as a delete).
- **Dry run.** On a fresh raw dir, run `bin/sync-vault --dry-run "$S/sync.json" "$S/raw"`. Exit 0 and the listing appears on stdout; `test -d "$S/raw/notes"` fails — nothing was written.
- **Proof.** Run `node bin/check-raw "$S/raw"`; exit 0. Save the report, the file listing, and `manifest.json` to `$EV` per SKILL.md Evidence.

## Gotchas

- To flip a note, merge `wiki: false` into the note's **existing**
  frontmatter block — never prepend a second `---` block. The parser
  reads the first block, so a second one silently does nothing.
- Never run bare: without `<raw-dir>` a config without `dataRoot`
  defaults to the repo's own `raw/`.
- Progress goes to stderr, the report to stdout — capture both.
- The fixture vault is deterministic; any hash change you did not
  cause by a vault edit is a bug worth reporting, not noise.
