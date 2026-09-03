import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git- and clock-heavy tests (wiki-ingest, guardrails, sync
    // progress) spawn real child processes and wait real intervals;
    // under heavy machine load (e.g. endpoint-security scanning) the
    // defaults starve them. The run output showed ingest tests at
    // 24-30 s under full-suite load, so 60 s left headroom — but the
    // mixed-expunge ingest tests (two full ingest cycles each) and a
    // repo-sourced wiki-sync test still crossed it in a 20-minute
    // full-coverage run (issue #149 gate), so the ceiling rose to
    // 120 s — and a later gate coverage run on a machine loaded
    // ~2.5x its core count pushed the real-agent timeout test to
    // 138 s past that, so 300 s, keeping the headroom ratio that
    // fixed the earlier escalations. The e2e config sets 30 s for
    // the CLI suites for the same reason.
    testTimeout: 300_000,
    // The same load history, attacked at its amplifier instead of its
    // symptom: the default maxWorkers is one fork per core, and every
    // worker spawns real git/agent children, so a cores-worth of
    // workers on an already-loaded machine oversubscribes it into
    // multi-minute global stalls (one stall inflates every in-flight
    // test equally — the gate run showed unrelated tests all at
    // ~92.8 s and one afterAll rm past the 120 s hook ceiling). A
    // fixed cap of 4 leaves CPU headroom for the spawned children;
    // CI's 4-core runners already run at or below it.
    maxWorkers: 4,
    // afterAll cleanup rm's many git-heavy temp dirs; under load the
    // 10 s default kills the hook (guardrails flake, issue #145 run).
    // Same value the heaviest suites already declare per-file.
    hookTimeout: 120_000,
    // Keep vitest out of Stryker's sandbox copies: a crashed mutation run
    // leaves them behind, and they would double the suite. Keep the e2e
    // suite out of the unit run (npm test) and coverage: it spawns the
    // real CLI and lives in vitest.e2e.config.ts (npm run e2e).
    exclude: ["**/node_modules/**", ".stryker-tmp/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
