// Grades one mutation-triage eval run against its outputs directory.
// Usage: node grade.ts <run-dir>  (run-dir contains outputs/ and repo/)
//
// Objective checks only: registry schema and bucket routing via the
// repo's own modules (the same enforcement CI uses), identity keys
// computed live from the run's fixture, test presence and shape,
// and the summary report's mechanism wording.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRegistry } from "../fixture/src/quality/mutation-registry.ts";
import { mutantIdentity } from "../fixture/src/quality/mutation-identity.ts";
import { parseReport } from "../fixture/src/quality/mutation-survivors.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Expectation {
  text: string;
  passed: boolean;
  evidence: string;
}

const runDir = resolve(process.argv[2] ?? "");
const outputs = join(runDir, "outputs");
const repo = join(runDir, "..", "repo");

/** The run's registry: from outputs, else the repo it edited. */
function registryPath(): string | undefined {
  for (const p of [join(outputs, ".mutants-registry.json"), join(repo, ".mutants-registry.json")]) {
    if (existsSync(p)) {
      return p;
    }
  }

  return undefined;
}

/** The run's registry as a Map, or an explanatory error. */
function loadRegistry(): { entries: Map<string, { bucket: string }> } | string {
  const p = registryPath();

  if (p === undefined) {
    return "no .mutants-registry.json in outputs or repo";
  }

  try {
    return parseRegistry(readFileSync(p, "utf8"));
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** The expected identity of one mutant, computed from the run's own report+source. */
function identityOf(file: string, mutator: string): string | undefined {
  const report = parseReport(readFileSync(join(repo, "reports/mutation/mutation.json"), "utf8"));
  const mutant = report.files[file]?.mutants.find((m) => m.mutatorName === mutator);

  if (mutant === undefined) {
    return undefined;
  }

  return mutantIdentity(
    file,
    mutant,
    (f) => {
      try {
        return readFileSync(join(repo, f), "utf8");
      } catch {
        return undefined;
      }
    },
  );
}

/** Files under outputs/tests/ (or tests changes anywhere in outputs). */
function testFiles(): string[] {
  const root = join(outputs, "tests");

  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { recursive: true }).map(String);
}

/** The run's summary report text. */
function reportText(): string {
  for (const name of readdirSync(outputs)) {
    if (name.toLowerCase().includes("report") || name.toLowerCase().includes("triage")) {
      const p = join(outputs, name);

      if (existsSync(p) && !name.endsWith(".json")) {
        return readFileSync(p, "utf8");
      }
    }
  }

  return "";
}

function grade(evalName: string): Expectation[] {
  const registry = loadRegistry();
  const isMap = typeof registry !== "string";
  const entries = isMap ? registry.entries : new Map<string, { bucket: string }>();

  const common: Expectation[] = [
    {
      text: "the committed registry file is present and schema-valid (full receipt on every entry)",
      passed: isMap,
      evidence: isMap ? `parsed ${entries.size} entr${entries.size === 1 ? "y" : "ies"}` : registry,
    },
  ];

  if (evalName.includes("standard")) {
    const equivalentId = identityOf("src/log-format.ts", "StringLiteral");
    const killableId = identityOf("src/log-format.ts", "ArithmeticOperator");
    const tests = testFiles();
    const testText = tests.map((t) => readFileSync(join(outputs, "tests", t), "utf8")).join("\n");
    const distinguishingInput = /\d+\.\d{3,}/.test(testText);

    return [
      ...common,
      {
        text: "the log-prefix StringLiteral equivalent is recorded under its span identity",
        passed: equivalentId !== undefined && entries.has(equivalentId),
        evidence: `expected identity ${equivalentId}; registry keys: ${[...entries.keys()].join(", ") || "(none)"}`,
      },
      {
        text: "the recorded equivalent carries bucket \"equivalent\"",
        passed: equivalentId !== undefined && entries.get(equivalentId)?.bucket === "equivalent",
        evidence: `bucket: ${entries.get(equivalentId ?? "")?.bucket ?? "(absent)"}`,
      },
      {
        text: "a killing test for the rounding math exists and uses a distinguishing input",
        passed: tests.length > 0 && testText.includes("formatAmount") && distinguishingInput,
        evidence: tests.length === 0
          ? "no files under outputs/tests/"
          : `test mentions formatAmount: ${testText.includes("formatAmount")}; distinguishing decimal present: ${distinguishingInput}`,
      },
      {
        text: "the killable ArithmeticOperator mutant is NOT parked in the registry",
        passed: killableId === undefined || !entries.has(killableId),
        evidence: `registry ${entries.has(killableId ?? "") ? "wrongly contains" : "does not contain"} the killable identity ${killableId}`,
      },
    ];
  }

  if (evalName.includes("artifact")) {
    const artifactId = identityOf("src/inventory.ts", "OptionalChaining");
    const equivalentId = identityOf("src/inventory.ts", "StringLiteral");

    return [
      ...common,
      {
        text: "the coverage-attribution OptionalChaining is recorded with bucket \"artifact\" — never equivalent",
        passed: artifactId !== undefined && entries.get(artifactId)?.bucket === "artifact",
        evidence: `bucket: ${entries.get(artifactId ?? "")?.bucket ?? "(absent)"}`,
      },
      {
        text: "the log-text StringLiteral is recorded with bucket \"equivalent\"",
        passed: equivalentId !== undefined && entries.get(equivalentId)?.bucket === "equivalent",
        evidence: `bucket: ${entries.get(equivalentId ?? "")?.bucket ?? "(absent)"}`,
      },
      {
        text: "no kill tests were written (the prompt said the suite already kills the killable one)",
        passed: testFiles().length === 0,
        evidence: `test files: ${testFiles().join(", ") || "(none)"}`,
      },
    ];
  }

  // stop-the-nightly-refiling
  const equivalentId = identityOf("src/log-format.ts", "StringLiteral");
  const text = reportText();
  const namesRegistry = text.includes(".mutants-registry.json");
  const namesFiltering = /filter|filing|re-?fil/i.test(text);
  const prBodyAsMechanism = /record it in the PR body/i.test(text) && !namesRegistry;

  return [
    ...common,
    {
      text: "the re-filing mutant is recorded in the registry under its span identity",
      passed: equivalentId !== undefined && entries.has(equivalentId),
      evidence: `expected identity ${equivalentId}; registry keys: ${[...entries.keys()].join(", ") || "(none)"}`,
    },
    {
      text: "the report names the registry as the filing-time filter that stops re-filing",
      passed: namesRegistry && namesFiltering && !prBodyAsMechanism,
      evidence: `mentions registry: ${namesRegistry}; mentions filtering/filing: ${namesFiltering}; PR-body-as-mechanism: ${prBodyAsMechanism}`,
    },
  ];
}

const evalName = runDir.split("/").slice(-3, -2)[0] ?? "";
const expectations = grade(evalName);
const passed = expectations.filter((e) => e.passed).length;
const grading = {
  run_id: `${evalName}-${runDir.split("/").slice(-2).join("/")}`,
  summary: {
    pass_rate: expectations.length === 0 ? 0 : passed / expectations.length,
    passed,
    failed: expectations.length - passed,
    total: expectations.length,
  },
  expectations,
};

console.log(JSON.stringify(grading, null, 2));

await import("node:fs").then(({ writeFileSync }) =>
  writeFileSync(join(runDir, "grading.json"), JSON.stringify(grading, null, 2)),
);
