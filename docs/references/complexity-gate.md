# Cyclomatic complexity gate

`npm run complexity` is a **blocking** gate over changed code;
`npm run complexity:full` is the **advisory** whole-`src/` debt report.
Both run the same vitest file, `tests/quality/complexity.test.ts`; all
repo-owned logic lives in the pure library `src/quality/complexity.ts`
(no `main()`, no `bin/` launcher by design — the failing assertion
message **is** the agent-facing report).

The engine is [`complexity-guard`](https://www.npmjs.com/package/complexity-guard)
(pinned devDependency, Rust binary, tree-sitter parsing), invoked for
metrics only. Every gate semantic — diff scoping, threshold, report —
is repo-owned, so a broken or abandoned engine can be replaced without
changing the npm scripts, the test, or the CI shape.

## Semantics

- **Scoping mirrors `npm run mutation:changed`:** the gate analyzes the
  `src/*.ts` files that differ from `origin/main` (uncommitted work
  included — the same plain two-endpoint diff, so the pre-handoff run
  sees what the agent actually changed). New/untracked files are gated
  whole; deleted files are skipped; renames gate as new files.
- **A violation fails the gate only when the function's line extent
  intersects a changed hunk** (new side). The engine supplies each
  function's real `start_line`/`end_line`, so no approximation is used.
  Legacy complexity a change does not touch never blocks — that debt is
  visible in `npm run complexity:full` and lowered deliberately.
- **Threshold:** fail when a gated function's cyclomatic complexity
  **exceeds 10** (11 fails, 10 passes; per function, never per file).
  Functions over 8, at or under 10, print as a non-failing warning
  tier. Rationale: McCabe's original recommendation, SonarSource's
  stricter end, defect-correlation research, and this codebase's own
  distribution — at implementation time 87% of `src/` functions
  already complied, median 3, p75 5–6, p90 11.
- **Nothing changed** (clean tree vs `origin/main`): the gate test
  skips — passes without reading the engine.
- **Output** is diagnostics only (no `raw/` or vault content): for each
  violation, `path:line`, function name, score, threshold, and the
  instruction to refactor — extract helpers, table-driven dispatch,
  early returns, split generators into named steps — plus a per-run
  summary (files checked, functions gated, violations, warnings).
  Colors follow
  [`docs/references/colors.md`](colors.md) at the render boundary.

## Calibration (engine numbers vs ESLint ground truth)

Complexity counts are engine-relative. `.complexityguard.json` pins the
engine to ESLint-aligned counting: `logical_operators`,
`nullish_coalescing`, and `optional_chaining` each add 1, and a switch
counts per case (verified by probe: a function with ten `if`s reads
11; an arrow with `if (a && b)`, `if (a || b)`, and `a ?? b` reads 6).

Measured over all of `src/` (engine, at landing time): 285 functions,
median 3, p75 5, p90 11, max 34; 31 functions over 10, 41 over 8 —
against an ESLint 9 + TS 5.8 sandbox ground truth of 246 functions,
33 over 10, same median and top offenders (`src/query/wiki-query.ts:282`
`main` 34, `src/ingest/wiki-ingest.ts:1465` `runWikiIngest` 30,
`src/ingest/wiki-ingest.ts:1880` `main` 28, `parseSettings` 24,
`src/sync/wiki-sync.ts:841` `main` 24).

One semantic difference, accepted and documented: the engine reports
**top-level function shapes only** (module functions, module-scope
arrows, class methods). Nested functions — a closure or generator
inside a function — are neither folded into the parent's score nor
reported as separate entries. ESLint counts each nested function
separately; `checkCrossWikiLinks` in `src/crosslinks.ts` reads 11 here
where ESLint reads 24 for the nested generator inside it. The gate is
therefore slightly looser than "ESLint complexity 10" on nested-heavy
code; the threshold stays 10.

## Suppression policy

No inline suppressions. If a function is genuinely irreducible, add an
exact path entry to `files.exclude` in [`.complexityguard.json`](../../.complexityguard.json)
with a written justification line in the PR body — the same rule as
`// Stryker disable`. The engine applies `files.exclude` from that
config even to explicitly passed paths, so an exclusion holds in both
changed and full mode. `files.exclude` starts empty.

## CI wiring

- **Pull requests (blocking):** the gate rides the existing `test` job
  inside `npm run test:coverage`; that job checks out with
  `fetch-depth: 0` because the gate diffs against `origin/main`.
- **Nightly + manual dispatch (advisory):** the mutation job's arm runs
  `npm run complexity:full`, uploads `complexity-debt-report` as an
  artifact (7-day retention), and never blocks.

## What lives where

| Piece | Location |
|---|---|
| Gate library (scoping, threshold, rendering, engine runner) | `src/quality/complexity.ts` |
| Gate + unit tests (the gate itself is a test) | `tests/quality/complexity.test.ts` |
| Diff scoping reused from the mutation tooling | `src/quality/mutation-scope.ts` (`collectChangedFiles`, `parseNewRanges`, `mergeRanges`) |
| Engine config, thresholds, exclusions | `.complexityguard.json` |
| CI steps | `.github/workflows/ci.yml` |
