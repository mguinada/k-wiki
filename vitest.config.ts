import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep vitest out of Stryker's sandbox copies: a crashed mutation run
    // leaves them behind, and they would double the suite.
    exclude: ["**/node_modules/**", ".stryker-tmp/**"],
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
