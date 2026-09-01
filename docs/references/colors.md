# CLI color convention

All CLIs render color with `picocolors`, honor `NO_COLOR` (plain text
when set to a non-empty value), and apply color at the **render
boundary** — the stderr sink or `colorize*` helper that turns an
uncolored message into output bytes. Call sites never embed escape
codes: the `onProgress` contract is *uncolored messages*, and severity
is detected at the sink via the shared predicate `isWarning`
(`src/cli/progress.ts`).

## Color semantics

| Color | Feedback kind | Examples |
|---|---|---|
| dim | progress and heartbeat lines | `createAgentProgressSink` in `src/ingest/agent-run.ts` (consumed by `src/ingest/wiki-ingest.ts`, `src/sync/wiki-sync.ts`, `src/query/wiki-query.ts`, `src/cli/k-wiki.ts`), the dim human-step filing hint in `src/cli/k-wiki.ts`, and the no-change summary in `formatReport` (`src/sync/projection.ts`) |
| yellow | warning severity | any progress message containing `WARNING` — today the foreign-snapshot warning in `readSnapshot` (`src/ingest/wiki-ingest.ts`) — and the freshness warning rendered at the sink in `src/health/check-raw.ts` |
| red | error | `fail()` in every entry point, broken crosslinks, removed files, health problems in `src/health/check-raw.ts` |
| green | ok / healthy / added | `src/health/check-raw.ts`, the ok summary in `scripts/check-crosslinks.ts`, copied files in `formatReport` (`src/sync/projection.ts`) |
| bold | emphasis | source names — vault or repo — in `formatReport` and progress lines (`colorizeProgress`, `src/sync/projection.ts`; its `noun` argument picks vault or repo), the `Filed:` line in `src/query/wiki-query.ts` |

Yellow slots between dim (routine progress) and red (failure): a
warning must be visible against dim heartbeats without claiming the
urgency of an error.

## Boundary rules

- `onProgress` messages are uncolored: plain strings on the agent
  seam, typed `SyncProgress` events (uncolored `text`) on the sync
  seams — vault and repo drivers alike (`DriverOptions`,
  `src/sync/projection.ts`). Severity is detected at
  the sink (`createAgentProgressSink`, `colorizeProgress`) via the
  shared `isWarning` predicate (`src/cli/progress.ts`), not at the
  call site.
- `createAgentProgressSink` takes the caller's `ProgressTones`
  (`dim` + `yellow`) and renders `isWarning` messages `yellow`, all
  others `dim`.
- `colorizeProgress` (`src/sync/projection.ts`) applies the same rule
  for its self-built sink, plus `bold` source names (its `noun`
  argument — vault or repo); a WARNING message
  renders yellow even when it names a source.
- `NO_COLOR` set to a non-empty value produces plain text: colors are
  built with `picocolors` disabled — `terminalColors`
  (`src/cli/colors.ts`) is the shared construction helper — so every
  styling call is the identity. An empty `NO_COLOR` keeps colors on
  (the no-color.org rule).
