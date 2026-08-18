# Test fixtures

`Documents/` is a checked-in snapshot of the synthetic vault the fixture
generator produces. It exists so humans can inspect the fixture without
running anything, and so a test can catch drift between the generator and
the snapshot.

Regenerate after changing the generator:

    npm run fixtures -- tests/fixtures

Do not edit files under `Documents/` by hand — the snapshot test compares
them byte-for-byte against generator output.

## Case matrix

| Path (under `Documents/`) | Case |
|---|---|
| `AI/RAG.md` | Selected: `wiki: true`, nesting depth 1 |
| `AI/llms/attention-is-all-you-need.md` | Selected: `wiki: true`, nesting depth 2 |
| `AI/rag-evaluation-notes.md` | Hash-change case: sync tests edit the content between runs |
| `Scratch/temp-research.md` | Removal case: sync tests delete it or flip its flag between runs |
| `Projects/house-renovation.md` | Excluded: `wiki: false` |
| `Inbox/parking-lot.md` | Excluded: no frontmatter |
| `.obsidian/app.json` | Noise: Obsidian settings, skipped |
| `.trash/deleted.md` | Noise: trashed note, skipped even though it says `wiki: true` |
| `.DS_Store` | Noise: macOS Finder metadata, skipped |

The vault is named `Documents` to mirror the real vault's shape. Only the
vault-internal structure is faked here; the real vault's iCloud container
path lives in [`sync.json`](../sync.json) (guide §26).
