/**
 * Vitest setup file for every test worker (unit and e2e; Stryker's
 * vitest runner prepends its own setup and keeps the project's).
 *
 * Marks this process as a test worker so `isMainModule` never runs a
 * CLI's `main()` as an import side effect inside the worker — a
 * mutated import guard under Stryker then cannot touch live state
 * (issue #123). The key duplicates the one in `src/cli/is-main.ts`
 * on purpose: a shared const would make a mutated key an equivalent
 * (self-consistent) mutant. Spawned CLI children are fresh `node`
 * processes: they never see this flag, so real CLI runs are
 * unaffected.
 */
(globalThis as { __kWikiTestWorker__?: boolean }).__kWikiTestWorker__ = true;
