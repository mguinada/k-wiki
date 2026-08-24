import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set the test-worker marker in every worker (issue #123); see
    // tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
    // Git- and clock-heavy tests (wiki-ingest, guardrails, sync
    // progress) spawn real child processes and wait real intervals;
    // under heavy machine load (e.g. endpoint-security scanning) the
    // default 5 s starves them. The e2e config sets 30 s for the CLI
    // suites for the same reason.
    testTimeout: 30_000,
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
