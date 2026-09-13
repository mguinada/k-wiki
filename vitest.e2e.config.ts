import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // See tests/setup-env.ts — macOS notifications stay off in tests.
    setupFiles: ["tests/setup-env.ts"],
    include: ["tests/e2e/**/*.test.ts"],
    // A hung CLI child process must fail the lane, not stall it.
    testTimeout: 30_000,
  },
});
