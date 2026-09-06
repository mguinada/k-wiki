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
  issue #144; sandbox-hygiene runs included: the TTL reaper deletes
  an expired `wiki/sandbox/` note on the next run while a live one
  survives, and a sandbox-less repo stays byte-identical on the skip
  path, issue #338).
- **sync-repo** — repo-as-source projection runs in temp source repos
  (verbatim copy, commit stamping, untracked scratch proceeds and
  untracked-selectable refuses, gitignored allowlisted files skipped
  and `.git/info/exclude` scratch workflows kept, dirty-source and
  wrong-config failures, health freshness).
- **wiki-sync** — full-cycle, no-change, failure, guardrail-revert,
  reverted fidelity-failure, repo-source cycle (the meta flow),
  run-lock (loud holder refusal, release after a completed cycle,
  independent instance while another holds its lock), and
  publish-denylist (a sandbox page never reaches the mirror, issue
  #338) runs.
- **scheduled-run** — full-cycle, no-op re-run, lock-skip,
  push-rejection-retry, double-push-failure, and dirty-tree recovery
  runs in temp data repos with an upstream remote.
- **setup-meta-sync** — hook install, idempotent re-install,
  uninstall, merge and rebase-pull fires, and feature-branch,
  linked-worktree, and dirty-tree guard skips in a temp source repo
  with a stubbed cycle runner.
- **sandbox** — not a launcher run: the suite drives the `runSandboxRun`
  library primitive (issue #336; the `propose` verb that will wrap it
  is family 6) in-process, with a real stub agent child process over
  a real git temp data repo. Four flows: a sandbox-only run lands one
  atomic `sandbox: <slug>` commit with `via:`/`expires:` stamps and
  the `wiki/log.md` audit entry; a main-tree-touching run is
  path-scoped-reverted and fails loudly while a mid-window wiki-sync
  commit and pre-existing dirty work survive; a wrong-repo run
  (instance and run context naming different data repos) is refused
  before the agent runs; an empty run commits nothing.
