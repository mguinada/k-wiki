import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The issue #123 kill path for import-guard mutants.
 *
 * `tests/setup.ts` marks this worker, so the unmutated guard
 * `if (isMainModule(import.meta.url))` stays false and importing a
 * CLI module runs nothing. A Stryker mutant that flips the guard to
 * `if (true)` makes the import execute `main()`, whose first statement
 * `refuseTestWorker(...)` then rejects the import — the module can
 * only fail loudly, never run with live defaults.
 *
 * Each CLI is imported dynamically and this file holds no static
 * imports of them, so every guard evaluates fresh inside the worker
 * (also inside Stryker's sandbox, where the mutated source sits next
 * to this test).
 */
const cliModules = [
  "src/data/init-data-repo.ts",
  "src/fixtures/generate.ts",
  "src/health/check-raw.ts",
  "src/ingest/wiki-ingest.ts",
  "src/query/wiki-query.ts",
  "src/sync/sync-repo.ts",
  "src/sync/sync-vault.ts",
  "src/sync/wiki-sync.ts",
  "scripts/backfill-origin.ts",
  "scripts/check-crosslinks.ts",
  "scripts/check-links.ts",
  "scripts/check-provenance.ts",
] as const;

const testsDir = dirname(fileURLToPath(import.meta.url));

describe("CLI import guard inside a test worker (issue #123)", () => {
  for (const cli of cliModules) {
    it(`${cli} imports without running main() in a test worker`, async () => {
      const moduleUrl = pathToFileURL(join(testsDir, "..", cli)).href;

      await expect(import(moduleUrl)).resolves.toBeDefined();
    });
  }
});
