# CLI color convention

All CLIs render color with `picocolors`, honor `NO_COLOR` (plain text
everywhere), and apply color at the **render boundary** — the stderr
sink or `colorize*` helper that turns an uncolored message into output
bytes. Call sites never embed escape codes: the `onProgress` contract
is *uncolored messages*, and severity is detected at the sink via the
shared predicate `isWarning` (`src/cli/progress.ts`).

## Color semantics

| Color | Feedback kind | Examples |
|---|---|---|
| dim | progress and heartbeat lines | `createAgentProgressSink` in `src/ingest/wiki-ingest.ts` (also consumed by `src/sync/wiki-sync.ts`, `src/query/wiki-query.ts`), the no-change summary in `formatReport` (`src/sync/sync-vault.ts`) |
| yellow | warning severity | any progress message containing `WARNING` — today the foreign-snapshot warning in `readSnapshot` (`src/ingest/wiki-ingest.ts`) — and the freshness warning rendered at the sink in `src/health/check-raw.ts` |
| red | error | `fail()` in every entry point, broken crosslinks, removed files, health problems in `src/health/check-raw.ts` |
| green | ok / healthy / added | `src/health/check-raw.ts`, the ok summary in `scripts/check-crosslinks.ts`, copied files in `src/sync/sync-vault.ts` |
| bold | emphasis | vault names in `formatReport` and progress lines (`src/sync/sync-vault.ts`), repo names in progress lines (`src/sync/sync-repo.ts`), the `Filed:` line in `src/query/wiki-query.ts` |

Yellow slots between dim (routine progress) and red (failure): a
warning must be visible against dim heartbeats without claiming the
urgency of an error.

## Boundary rules

- `onProgress` messages are uncolored strings. Severity is detected at
  the sink (`createAgentProgressSink`, `colorizeProgress`) via the
  shared `isWarning` predicate (`src/cli/progress.ts`), not at the
  call site.
- `createAgentProgressSink` takes the caller's `ProgressTones`
  (`dim` + `yellow`) and renders `isWarning` messages `yellow`, all
  others `dim`.
- `colorizeProgress` (`src/sync/sync-vault.ts`) applies the same rule
  for its self-built sink, plus `bold` vault names; a WARNING message
  renders yellow even when it names a vault.
- `NO_COLOR` produces plain text: `picocolors` is constructed with
  colors disabled, so every styling call is the identity.
