import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
