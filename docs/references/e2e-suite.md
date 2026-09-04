# End-to-end suite

`npm run e2e` (`vitest.e2e.config.ts`) runs real CLI child processes.
This page is the per-CLI scenario inventory — read it when adding an
e2e run or diagnosing a failing one.

- **sync-vault** — full vault lifecycle against the synthetic fixture
  vault in temp workspaces under `.e2e-tmp/` (gitignored).
- **wiki-ingest** — against a stub agent in temp data repos
  (second-brain runs included: profile ingest, cross-wiki validation,
  and the reverted domain→second-brain leak; isolate-whitelist runs
  pass the `--skill`/`-e` flags and warn-and-omit absent entries,
  issue #144).
- **sync-repo** — repo-as-source projection runs in temp source repos
  (verbatim copy, commit stamping, dirty-source and wrong-config
  failures, health freshness).
- **wiki-sync** — full-cycle, no-change, failure, guardrail-revert,
  reverted fidelity-failure, and repo-source cycle (the meta flow)
  runs.
- **scheduled-run** — full-cycle, no-op re-run, lock-skip,
  push-rejection-retry, double-push-failure, and dirty-tree recovery
  runs in temp data repos with an upstream remote.
