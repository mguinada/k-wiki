import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectOffenders,
  counterKeys,
  metricsOfOffenders,
  type StructureOffenders,
} from "../../src/quality/refactor-metrics.ts";
import {
  applyExcludes,
  breachesOf,
  parseStructureBudget,
  renderBreaches,
} from "../../src/quality/structure.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const guardPath = join(repoRoot, ".structureguard.json");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A budget JSON body: every counter at its override or zero. */
function budgetJson(overrides: Record<string, number> = {}): string {
  const budget = Object.fromEntries(
    counterKeys.map((key) => [key, overrides[key] ?? 0]),
  );

  return JSON.stringify({ budget });
}

/**
 * A tiny src-like tree for the guard: one oversized file, one
 * data→sync import (line 1 of its file — also a cross-domain edge).
 */
async function makeGuardTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-structure-"));

  tempDirs.push(root);

  const files: Record<string, string> = {
    "data/db.ts": 'import { sha } from "../sync/hash.ts";\n',
    "sync/hash.ts": "export const sha = 1;\n",
    "big.ts": `${Array<string>(801).fill("// filler").join("\n")}\n`,
    "plain.ts": "export const value = 1;\n",
  };

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(file)), { recursive: true });
    await writeFile(join(root, file), content);
  }

  return root;
}

/** Offenders of the guard tree, with every counter derivable. */
async function guardOffenders(): Promise<StructureOffenders> {
  return collectOffenders(await makeGuardTree());
}

describe("parseStructureBudget", () => {
  it("parses a budget carrying every counter and no excludes", () => {
    const parsed = parseStructureBudget(budgetJson({ maxFileLines: 1170 }));

    expect(parsed.budget.maxFileLines).toBe(1170);
    expect(parsed.exclude).toEqual({});
  });

  it("parses per-counter exclude path lists", () => {
    const body = JSON.stringify({
      budget: JSON.parse(budgetJson()).budget,
      exclude: { parseArgsCopies: ["src/legacy/old.ts"] },
    });

    expect(parseStructureBudget(body).exclude.parseArgsCopies).toEqual([
      "src/legacy/old.ts",
    ]);
  });

  it("rejects a budget missing a counter", () => {
    const body = JSON.parse(budgetJson());
    delete body.budget.filesOver800;

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      /missing counters filesOver800/,
    );
  });

  it("rejects an unknown counter key", () => {
    const body = JSON.parse(budgetJson());
    body.budget.crossdomainEdges = 5;

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      /unknown counters crossdomainEdges/,
    );
  });

  it("rejects a non-number counter value", () => {
    const body = JSON.parse(budgetJson());
    body.budget.maxFileLines = "1170";

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      /counter maxFileLines must be a finite non-negative number/,
    );
  });

  it("rejects an exclude entry under a non-counter key", () => {
    const body = JSON.parse(budgetJson());
    body.exclude = { whatever: ["src/a.ts"] };

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      /exclude names a non-counter whatever/,
    );
  });

  it("rejects malformed JSON with a thrown parse error", () => {
    expect(() => parseStructureBudget("{")).toThrow();
  });
});

describe("breachesOf", () => {
  it("reports no breach while every fresh counter stays within budget", () => {
    const fresh = metricsOfOffenders({
      ...emptyOffenders(),
      dataToSyncEdges: [{ path: "src/data/db.ts", line: 1 }],
    });

    expect(
      breachesOf(
        parseStructureBudget(budgetJson({ dataToSyncEdges: 1 })).budget,
        fresh,
      ),
    ).toEqual([]);
  });

  it("reports a counter whose fresh value exceeds its budget", () => {
    const fresh = metricsOfOffenders({
      ...emptyOffenders(),
      dataToSyncEdges: [{ path: "src/data/db.ts", line: 1 }],
    });
    const breaches = breachesOf(
      parseStructureBudget(budgetJson({ dataToSyncEdges: 0 })).budget,
      fresh,
    );

    expect(breaches).toEqual([{ key: "dataToSyncEdges", budget: 0, fresh: 1 }]);
  });
});

describe("applyExcludes", () => {
  it("removes the excluded path's sites from that counter only", () => {
    const offenders = guardTreeOffenders();
    const filtered = applyExcludes(offenders, {
      filesOver800: ["big.ts"],
    });

    expect(filtered.filesOver800).toEqual([]);
    expect(filtered.filesOver350).toEqual(offenders.filesOver350);
  });

  it("lowers the recomputed max file lines when the largest file is excluded", () => {
    const offenders = guardTreeOffenders();
    const filtered = applyExcludes(offenders, { maxFileLines: ["big.ts"] });

    expect(metricsOfOffenders(filtered).maxFileLines).toBe(1);
  });

  it("returns the offenders unchanged when no exclude list matches", () => {
    const offenders = guardTreeOffenders();

    expect(applyExcludes(offenders, {}).maxFileLines).toEqual(
      offenders.maxFileLines,
    );
  });
});

describe("renderBreaches (guard tree)", () => {
  it("names the data→sync offending import file:line for a breached dataToSyncEdges budget", async () => {
    const offenders = await guardOffenders();
    const fresh = metricsOfOffenders(offenders);
    const breaches = breachesOf({ ...zeroBudget(), dataToSyncEdges: 0 }, fresh);

    expect(breaches.length).toBeGreaterThan(0);
    expect(renderBreaches(breaches, offenders)).toContain("data/db.ts:1");
  });

  it("names the largest file with its line count for a breached max file lines budget", async () => {
    const offenders = await guardOffenders();
    const fresh = metricsOfOffenders(offenders);
    const breaches = breachesOf(
      parseStructureBudget(budgetJson({ maxFileLines: fresh.maxFileLines - 1 }))
        .budget,
      fresh,
    );

    expect(renderBreaches(breaches, offenders)).toContain("big.ts (801 lines)");
  });

  it("states counter label, key, fresh value, and budget per breach", async () => {
    const offenders = await guardOffenders();
    const fresh = metricsOfOffenders(offenders);
    const breaches = breachesOf(zeroBudget(), fresh);

    expect(renderBreaches(breaches, offenders)).toContain(
      "files >800 lines (filesOver800): fresh 1 > budget 0",
    );
  });

  it("caps the site list at ten entries with an overflow count", () => {
    const offenders: StructureOffenders = {
      ...emptyOffenders(),
      parseArgsCopies: Array.from({ length: 12 }, (_, i) => ({
        path: `src/mod${i}.ts`,
        line: i + 1,
      })),
    };
    const fresh = metricsOfOffenders(offenders);
    const text = renderBreaches(breachesOf(zeroBudget(), fresh), offenders);

    expect(text).toContain("src/mod9.ts:10");
    expect(text).toContain("+2 more");
    expect(text).not.toContain("src/mod10.ts");
  });
});

/**
 * True inside Stryker's sandbox, where the instrumented src/ tree
 * carries injected mutant switches that inflate line counts — the
 * live gate must not evaluate that tree (issue #276).
 */
function insideStrykerSandbox(): boolean {
  return (
    import.meta.url.includes(".stryker-tmp") || "__stryker__" in globalThis
  );
}

describe("parseStructureBudget (exact problems, issue #240 kill batch)", () => {
  it("joins multiple unknown counter names with a comma and space", () => {
    const body = JSON.parse(budgetJson());
    body.budget.aa = 1;
    body.budget.bb = 1;

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      "unknown counters aa, bb",
    );
  });

  it("joins the unknown-counter and missing-counter problems with a semicolon", () => {
    const body = JSON.parse(budgetJson());
    body.budget.zz = 1;
    delete body.budget.filesOver800;

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      "structure budget: unknown counters zz; missing counters filesOver800",
    );
  });

  it("rejects a counter value of Infinity as not finite", () => {
    const body = JSON.parse(budgetJson());
    body.budget.maxFileLines = Number.POSITIVE_INFINITY;

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      "counter maxFileLines must be a finite non-negative number",
    );
  });

  it("rejects a negative counter value", () => {
    const body = JSON.parse(budgetJson());
    body.budget.maxFileLines = -1;

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      "counter maxFileLines must be a finite non-negative number",
    );
  });

  it("rejects an exclude entry whose paths value is not a list", () => {
    const body = JSON.parse(budgetJson());
    body.exclude = { parseArgsCopies: "src/legacy/old.ts" };

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      "exclude parseArgsCopies must be a list of paths",
    );
  });

  it("rejects an exclude list that carries a non-string entry", () => {
    const body = JSON.parse(budgetJson());
    body.exclude = { parseArgsCopies: ["src/a.ts", 5] };

    expect(() => parseStructureBudget(JSON.stringify(body))).toThrow(
      "exclude parseArgsCopies must be a list of paths",
    );
  });
});

describe("renderBreaches (exact text, issue #240 kill batch)", () => {
  it("renders every breach header with its counter's own label", async () => {
    const offenders = await guardOffenders();
    const fresh = metricsOfOffenders(offenders);

    expect(renderBreaches(breachesOf(zeroBudget(), fresh), offenders)).toBe(
      [
        "files >800 lines (filesOver800): fresh 1 > budget 0",
        "  big.ts (801 lines)",
        "files >500 lines (filesOver500): fresh 1 > budget 0",
        "  big.ts (801 lines)",
        "files >350 lines (filesOver350): fresh 1 > budget 0",
        "  big.ts (801 lines)",
        "max file lines (maxFileLines): fresh 801 > budget 0",
        "  big.ts (801 lines)",
        "cross-domain edges (excl. cli) (crossDomainEdges): fresh 1 > budget 0",
        "  data/db.ts:1",
        "data→sync edges (dataToSyncEdges): fresh 1 > budget 0",
        "  data/db.ts:1",
      ].join("\n"),
    );
  });

  it("lists only the files at the breached maximum for max file lines", async () => {
    const offenders = await guardOffenders();
    const fresh = metricsOfOffenders(offenders);

    expect(
      renderBreaches(
        breachesOf(
          {
            ...zeroBudget(),
            filesOver800: 2,
            filesOver500: 2,
            filesOver350: 2,
            crossDomainEdges: 2,
            dataToSyncEdges: 2,
            maxFileLines: 800,
          },
          fresh,
        ),
        offenders,
      ),
    ).toBe(
      [
        "max file lines (maxFileLines): fresh 801 > budget 800",
        "  big.ts (801 lines)",
      ].join("\n"),
    );
  });

  it("omits the overflow line when the sites fit under the cap", () => {
    const offenders: StructureOffenders = {
      ...emptyOffenders(),
      parseArgsCopies: [{ path: "src/only.ts", line: 3 }],
    };
    const fresh = metricsOfOffenders(offenders);

    expect(renderBreaches(breachesOf(zeroBudget(), fresh), offenders)).toBe(
      [
        "parseArgs copies (parseArgsCopies): fresh 1 > budget 0",
        "  src/only.ts:3",
      ].join("\n"),
    );
  });

  it("caps the site list at ten entries with an exact overflow line", () => {
    const offenders: StructureOffenders = {
      ...emptyOffenders(),
      parseArgsCopies: Array.from({ length: 12 }, (_, i) => ({
        path: `src/mod${i}.ts`,
        line: i + 1,
      })),
    };
    const fresh = metricsOfOffenders(offenders);

    expect(renderBreaches(breachesOf(zeroBudget(), fresh), offenders)).toBe(
      [
        "parseArgs copies (parseArgsCopies): fresh 12 > budget 0",
        ...Array.from({ length: 10 }, (_, i) => `  src/mod${i}.ts:${i + 1}`),
        "  … +2 more",
      ].join("\n"),
    );
  });
});

describe("structure gate (live src/ tree)", () => {
  it("every counter stays at or below its .structureguard.json budget", async ({
    skip,
  }) => {
    if (insideStrykerSandbox()) {
      skip("Stryker sandbox instruments src/; counts are inflated");

      return;
    }

    const budget = parseStructureBudget(await readFile(guardPath, "utf8"));
    const offenders = applyExcludes(
      await collectOffenders(join(repoRoot, "src")),
      budget.exclude,
    );
    const breaches = breachesOf(budget.budget, metricsOfOffenders(offenders));

    expect(breaches, renderBreaches(breaches, offenders)).toEqual([]);
  });
});

/** An all-zero budget — every nonzero fresh counter breaches. */
function zeroBudget() {
  return parseStructureBudget(budgetJson()).budget;
}

/** Offender sets with every counter empty. */
function emptyOffenders(): StructureOffenders {
  return {
    filesOver800: [],
    filesOver500: [],
    filesOver350: [],
    maxFileLines: [],
    crossDomainEdges: [],
    dataToSyncEdges: [],
    parseArgsCopies: [],
    directoryWalkers: [],
    repoRootDerivations: [],
    unquoteDefinitions: [],
    envSignatures: [],
    envSignatureFiles: [],
    dataRootEnvPairs: [],
    dirnameRawDirDerivations: [],
  };
}

/** The static guard-tree offenders: 801-line big.ts, data→sync edge. */
function guardTreeOffenders(): StructureOffenders {
  return {
    ...emptyOffenders(),
    filesOver800: [{ path: "big.ts", lines: 801 }],
    filesOver500: [{ path: "big.ts", lines: 801 }],
    filesOver350: [{ path: "big.ts", lines: 801 }],
    maxFileLines: [
      { path: "plain.ts", lines: 1 },
      { path: "big.ts", lines: 801 },
    ],
    crossDomainEdges: [{ path: "data/db.ts", line: 1 }],
    dataToSyncEdges: [{ path: "data/db.ts", line: 1 }],
  };
}
