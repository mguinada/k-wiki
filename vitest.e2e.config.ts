import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    // A hung CLI child process must fail the lane, not stall it.
    testTimeout: 30_000,
  },
});
