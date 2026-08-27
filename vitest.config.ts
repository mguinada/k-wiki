import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git- and clock-heavy tests (wiki-ingest, guardrails, sync
    // progress) spawn real child processes and wait real intervals;
    // under heavy machine load (e.g. endpoint-security scanning) the
    // default 5 s starves them. The e2e config sets 30 s for the CLI
    // suites for the same reason. Under full-suite parallel load with
    // coverage on, per-test times inflate several-fold and the
    // timeouts move between git-heavy files (observed in the gate's
    // fix run, 2026-08-27): 60 s per test and 120 s per hook — the
    // budget two temp-dir afterAll cleanups already override to
    // individually — keep the suite deterministic under load instead
    // of whack-a-mole per-file overrides.
    testTimeout: 60_000,
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
