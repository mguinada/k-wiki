import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The convention guard for the advisory mutation job's failure
 * visibility (issue #215): the job is `continue-on-error` so a failing
 * run never gates a merge, but that same flag kept the 2026-08-27 and
 * 2026-08-29 nightlies fully green on the run page while the Stryker
 * dry run died on unit tests that were red on main (#171, merged over
 * its own red checks) or incompatible with the runner's worker-thread
 * pool (#189's `process.chdir()`). The contract this scan enforces:
 * the failure must surface as an error annotation on the run page —
 * visible the same night, without making anything blocking.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The `mutation:` job block of ci.yml, verbatim. */
async function mutationJobBlock(): Promise<string> {
  const ci = await readFile(
    resolve(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const start = ci.indexOf("\n  mutation:");

  if (start === -1) {
    throw new Error("mutation job not found in .github/workflows/ci.yml");
  }

  const rest = ci.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\S/);

  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe("ci.yml mutation job (issue #215 guard)", () => {
  it("stays continue-on-error so a failing advisory run never gates a merge", async () => {
    const block = await mutationJobBlock();

    expect(block).toContain("continue-on-error: true");
  });

  it("gives the mutation run step an id so later steps can see its outcome", async () => {
    const block = await mutationJobBlock();

    expect(block).toContain("id: mutation");
  });

  it("emits an error annotation when the mutation run step failed", async () => {
    const block = await mutationJobBlock();

    expect(block).toMatch(
      /if: always\(\) && steps\.mutation\.outcome == 'failure'/,
    );
    expect(block).toContain("::error");
  });
});
