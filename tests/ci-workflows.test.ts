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
 * pool (#189's `process.chdir()`). The contract this guard enforces:
 * the failure must surface as an error annotation on the run page —
 * visible the same night, without making anything blocking.
 *
 * ci.yml is a machine-consumed declarative artifact, so the guard
 * parses the job into a semantic model — its own keys and its steps —
 * and asserts meaning, not raw file text.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One workflow job, normalized: its own scalar keys plus its
 *  `steps:` entries as key/value maps. Nesting under a step (`with:`
 *  maps and their block scalars) is not modeled. */
type WorkflowJob = {
  keys: Record<string, string>;
  steps: Record<string, string>[];
};

/** YAML indentation landmarks inside a job block: the job's own keys,
 *  a `steps:` list item, and a step's own keys. */
const JOB_KEY_INDENT = 4;
const STEP_ITEM_INDENT = 6;
const STEP_KEY_INDENT = 8;
const BLOCK_SCALARS: readonly string[] = [">", "|"];

/** Record `key: value` (split on the first colon) and return both. */
function recordEntry(
  target: Record<string, string>,
  entry: string,
): [key: string, value: string] {
  const separator = entry.indexOf(":");
  const key = entry.slice(0, separator).trim();
  const value = entry.slice(separator + 1).trim();

  target[key] = value;

  return [key, value];
}

/**
 * Parse one `jobId:` block of a workflow file into the WorkflowJob
 * model: comments are ignored at any depth, a step key whose value is
 * `>` or `|` collects its more-indented lines (folded with spaces),
 * and the block ends at the next key shallower than the job's own.
 */
function parseJob(text: string, jobId: string): WorkflowJob {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${jobId}:`);

  if (start === -1) {
    throw new Error(`job ${jobId} not found in workflow`);
  }

  const job: WorkflowJob = { keys: {}, steps: [] };
  let step: Record<string, string> | undefined;
  let scalar:
    | { target: Record<string, string>; key: string; body: string[] }
    | undefined;

  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const indent = line.length - trimmed.length;

    if (scalar && indent > STEP_KEY_INDENT) {
      scalar.body.push(trimmed);
      continue;
    }

    if (scalar) {
      scalar.target[scalar.key] = scalar.body.join(" ");
      scalar = undefined;
    }

    if (indent < JOB_KEY_INDENT) {
      break;
    }

    if (indent === JOB_KEY_INDENT) {
      recordEntry(job.keys, trimmed);
      continue;
    }

    let entry = "";

    if (indent === STEP_ITEM_INDENT && trimmed.startsWith("- ")) {
      step = {};
      job.steps.push(step);
      entry = trimmed.slice(2);
    } else if (indent === STEP_KEY_INDENT && step) {
      entry = trimmed;
    } else {
      continue;
    }

    if (entry === "") {
      continue;
    }

    const [key, value] = recordEntry(step, entry);

    if (BLOCK_SCALARS.includes(value)) {
      scalar = { target: step, key, body: [] };
    }
  }

  if (scalar) {
    scalar.target[scalar.key] = scalar.body.join(" ");
  }

  return job;
}

async function loadMutationJob(): Promise<WorkflowJob> {
  const workflow = await readFile(
    resolve(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );

  return parseJob(workflow, "mutation");
}

const job = await loadMutationJob();

describe("ci.yml mutation job (issue #215 guard)", () => {
  it("stays continue-on-error so a failing advisory run never gates a merge", () => {
    expect(job.keys["continue-on-error"]).toBe("true");
  });

  it("gives the mutation run step an id so later steps can see its outcome", () => {
    expect(job.steps.some((step) => step.id === "mutation")).toBe(true);
  });

  it("emits an error annotation when the mutation run step failed", () => {
    const annotate = job.steps.find(
      (step) => step.if === "always() && steps.mutation.outcome == 'failure'",
    );

    expect(annotate?.run?.startsWith('echo "::error')).toBe(true);
  });
});
