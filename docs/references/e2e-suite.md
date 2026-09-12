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
  independent instance while another holds its lock),
  publish-denylist (a sandbox page never reaches the mirror, issue
  #338), and citation-wall (a rogue main→sandbox edge fails the
  standing lint, is path-scoped-reverted to its last committed
  state, leaves the cycle's commit untouched, and the next cycle
  passes, issue #339) runs.
- **wiki-lint** — the standalone lint door against a stub agent in
  temp data repos: completed run (report written, digest on stdout,
  edits left uncommitted for the next cycle) and guardrail-revert
  (a forbidden write reverts the repo and exits 1) runs.
- **scheduled-run** — full-cycle, no-op re-run, lock-skip,
  push-rejection-retry, double-push-failure, and dirty-tree recovery
  runs in temp data repos with an upstream remote.
- **setup-meta-sync** — hook install, idempotent re-install,
  uninstall, merge and rebase-pull fires, and feature-branch,
  linked-worktree, and dirty-tree guard skips in a temp source repo
  with a stubbed cycle runner.
- **k-wiki** — the front door (issue #337) in temp checkouts, temp
  data repos, and bound temp projects: read verbs on both doors
  (agent door via `.k-wiki.json`, human door from the checkout
  cwd), the guardrail revert for a rogue agent, binding-key and
  alias instance resolution, the leading-global reordering
  (`k-wiki -w meta <verb>` ≡ `k-wiki <verb> -w meta` for every
  verb that takes it — the read verbs plus the verbatim-argv
  handoff to `wiki-query` and `wiki-ingest`), operator-verb
  refusal on the agent door (both escapes named) and dispatch by
  import on the human door, the door/instance dim stderr lines,
  in-context verb help (issue #348) — every read verb's
  `-h`/`--help` renders the verb's own scoped help with the
  leading `-h <verb>` form reordering to the same output, and the
  operator verbs' dispatcher help stays byte-identical to their
  standalone launchers across the whole table — the tiered bare
  help, and the completion verb (issue #352): `completion` and
  `completion zsh` emit byte-identical scripts (exit 0, stdout
  only), an unknown shell exits 1 naming zsh, and — where a zsh
  is installed — a zpty run sources the emitted file and proves
  `k-wiki <TAB>` lists the verbs and `k-wiki query -<TAB>`
  offers the global flags in a real terminal.
- **sandbox** — not a launcher run: the suite drives the `runSandboxRun`
  library primitive (issue #336) in-process, with a real stub agent child process over
  a real git temp data repo. Four flows: a sandbox-only run lands one
  atomic `sandbox: <slug>` commit with `via:`/`expires:` stamps and
  the `wiki/log.md` audit entry; a main-tree-touching run is
  path-scoped-reverted and fails loudly while a mid-window wiki-sync
  commit and pre-existing dirty work survive; a wrong-repo run
  (instance and run context naming different data repos) is refused
  before the agent runs; an empty run commits nothing.
- **propose** — `bin/k-wiki propose` (issue #340, the verb that wraps
  the primitive) as a real front-door child process from bound temp
  projects with stub agents: a filing run lands the templated note as
  one stamped `sandbox: <slug>` commit with only sandbox deltas and a
  clean tree; a rogue stub's main-tree write reverts the run and
  fails loudly; an idle stub's empty run fails having committed
  nothing; the body arrives by file or stdin; the binding's `wiki`
  key lands the note in that instance's repo (the verb's own
  resolution — never the ambient cwd), and `-w` overrides the key in
  both positions; the verb's own `-h` and usage errors answer.
- **wiki-promote** — the human door's sandbox-note promotion (issue
  #341) through the real `bin/libexec/wiki-promote` launcher in temp
  data repos: the one-unit landing (body byte-exact minus stamps and
  agent-written sources, page + `index.md` + `log.md` entry + sandbox-copy
  deletion as one `promote: <slug>` commit leaving a clean tree), the
  already-promoted, dirty-tree, and untraceable-sources refusals, a
  promotion alongside unrelated sandbox peers, and the whole-unit
  rollback when the citation wall trips. The verb's agent-door absence
  is pinned in the k-wiki dispatcher suite.
