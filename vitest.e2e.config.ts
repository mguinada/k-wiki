import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set the test-worker marker in every worker (issue #123); see
    // tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
    include: ["tests/e2e/**/*.test.ts"],
    // A hung CLI child process must fail the lane, not stall it.
    testTimeout: 30_000,
  },
});
