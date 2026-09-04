import { describe, expect, it } from "vitest";
import {
  bootstrapEntries,
  identity,
  type Ledger,
  type LedgerEntry,
  ledgerBlockLine,
  ledgerFromBody,
  ledgerLines,
  mergeLedger,
} from "../../src/quality/mutation-ledger.ts";
import type { Report } from "../../src/quality/mutation-survivors.ts";

const survived = (
  file: string,
  line: number,
  mutator: string,
): LedgerEntry => ({
  file,
  line,
  mutator,
  status: "Survived",
});

const report = (files: Report["files"]): Report => ({ files });

const mutant = (mutator: string, status: string, line: number) => ({
  mutatorName: mutator,
  status,
  location: { start: { line } },
});

describe("identity", () => {
  it("keys one ledger entry by file:line and mutator", () => {
    expect(identity(survived("src/a.ts", 7, "Mut"))).toBe("src/a.ts:7|Mut");
  });
});

describe("ledgerLines", () => {
  it("formats each entry as status, file:line, mutator — sorted", () => {
    const ledger: Ledger = {
      entries: [
        survived("src/b.ts", 3, "BlockStatement"),
        { ...survived("src/a.ts", 42, "StringLiteral"), status: "NoCoverage" },
        survived("src/a.ts", 7, "ConditionalExpression"),
      ],
    };

    expect(ledgerLines(ledger)).toEqual([
      "Survived  src/a.ts:7  ConditionalExpression",
      "NoCoverage  src/a.ts:42  StringLiteral",
      "Survived  src/b.ts:3  BlockStatement",
    ]);
  });

  it("formats an empty ledger as no lines", () => {
    expect(ledgerLines({ entries: [] })).toEqual([]);
  });
});

describe("ledgerBlockLine", () => {
  it("embeds the full ledger as one hidden HTML comment", () => {
    const line = ledgerBlockLine({ entries: [survived("src/a.ts", 7, "Mut")] });

    expect(line).toBe(
      '<!-- k-wiki-mutants-ledger: {"schema":1,"entries":' +
        '{"src/a.ts:7|Mut":{"file":"src/a.ts","line":7,"mutator":"Mut","status":"Survived"}}} -->',
    );
  });

  it("round-trips losslessly through ledgerFromBody", () => {
    const ledger: Ledger = {
      entries: [
        survived("src/a.ts", 7, "Mut"),
        { ...survived("src/b.ts", 9, "Other"), status: "NoCoverage" },
      ],
    };

    expect(ledgerFromBody(`body\n${ledgerBlockLine(ledger)}\n`)).toEqual(
      ledger,
    );
  });
});

describe("ledgerFromBody", () => {
  it("bootstraps entries from a pre-block rendered body", () => {
    const body = [
      "Actionable mutants (2) — kill or record as equivalent:",
      "```",
      "Survived  src/sync/config.ts:42  StringLiteral",
      "NoCoverage  src/sync/scan.ts:3  MethodExpression",
      "```",
    ].join("\n");

    expect(ledgerFromBody(body)).toEqual({
      entries: [
        {
          file: "src/sync/config.ts",
          line: 42,
          mutator: "StringLiteral",
          status: "Survived",
        },
        {
          file: "src/sync/scan.ts",
          line: 3,
          mutator: "MethodExpression",
          status: "NoCoverage",
        },
      ],
    });
  });

  it("yields an empty ledger for a body with neither block nor entries", () => {
    expect(ledgerFromBody("No actionable mutants — nothing survived.")).toEqual(
      { entries: [] },
    );
  });

  it("ignores rendered look-alike lines when a block is present", () => {
    const ledger: Ledger = { entries: [survived("src/a.ts", 1, "Only")] };
    const body = [
      "```",
      "Survived  src/old.ts:99  Stale",
      "```",
      ledgerBlockLine(ledger),
    ].join("\n");

    expect(ledgerFromBody(body)).toEqual(ledger);
  });

  it("falls back to the rendered list when the block carries a wrong shape", () => {
    const body = [
      "```",
      "Survived  src/old.ts:99  Stale",
      "```",
      '<!-- k-wiki-mutants-ledger: {"schema":1,"entries":["not","an","object"]} -->',
    ].join("\n");

    expect(ledgerFromBody(body)).toEqual({
      entries: [survived("src/old.ts", 99, "Stale")],
    });
  });

  it("reads an empty-entries block as an empty ledger", () => {
    const body = [
      "No actionable mutants — nothing survived, nothing uncovered.",
      '<!-- k-wiki-mutants-ledger: {"schema":1,"entries":{}} -->',
    ].join("\n");

    expect(ledgerFromBody(body)).toEqual({ entries: [] });
  });
});

describe("bootstrapEntries", () => {
  it("ignores lines that do not carry the rendered actionable format", () => {
    const body = [
      "Killed  src/a.ts:1  MethodExpression",
      "Survived src/a.ts:2 NotSpaced",
      "Survived  src/a.ts:three  NotALine",
    ].join("\n");

    expect(bootstrapEntries(body)).toEqual([]);
  });
});

describe("mergeLedger", () => {
  const prior: Ledger = {
    entries: [
      survived("src/kept.ts", 10, "StillSurvived"),
      survived("src/killed.ts", 20, "NowKilled"),
      survived("src/absent.ts", 30, "OutOfScope"),
    ],
  };

  const fresh = report({
    "src/kept.ts": { mutants: [mutant("StillSurvived", "Survived", 10)] },
    "src/killed.ts": { mutants: [mutant("NowKilled", "Killed", 20)] },
    "src/new.ts": {
      mutants: [mutant("FreshSurvivor", "Survived", 5)],
    },
  });

  it("keeps an absent entry by default — out of the run's scope", () => {
    expect(
      mergeLedger(prior, fresh, { absenceKills: false }).entries.map(
        (e) => e.file,
      ),
    ).toContain("src/absent.ts");
  });

  it("removes an absent entry when absence means death", () => {
    expect(
      mergeLedger(prior, fresh, { absenceKills: true }).entries.map(
        (e) => e.file,
      ),
    ).not.toContain("src/absent.ts");
  });

  it("removes an entry the fresh report lists as Killed", () => {
    expect(
      mergeLedger(prior, fresh, { absenceKills: false }).entries.map(
        (e) => e.file,
      ),
    ).not.toContain("src/killed.ts");
  });

  it("keeps an entry the fresh report still lists as Survived", () => {
    expect(
      mergeLedger(prior, fresh, { absenceKills: false }).entries.map(
        (e) => e.file,
      ),
    ).toContain("src/kept.ts");
  });

  it("adds a fresh report survivor the ledger did not list", () => {
    expect(
      mergeLedger(prior, fresh, { absenceKills: false }).entries.map(
        (e) => e.file,
      ),
    ).toContain("src/new.ts");
  });

  it("removes an entry the fresh report lists as Timeout", () => {
    const timeouted = report({
      "src/absent.ts": { mutants: [mutant("OutOfScope", "Timeout", 30)] },
    });

    expect(
      mergeLedger(prior, timeouted, { absenceKills: false }).entries.map(
        (e) => e.file,
      ),
    ).not.toContain("src/absent.ts");
  });

  it("keeps an entry the fresh report lists as CompileError", () => {
    const errored = report({
      "src/absent.ts": { mutants: [mutant("OutOfScope", "CompileError", 30)] },
    });

    expect(
      mergeLedger(prior, errored, { absenceKills: false }).entries.map(
        (e) => e.file,
      ),
    ).toContain("src/absent.ts");
  });

  it("updates an entry's status when the fresh report uncovered it", () => {
    const uncovered = report({
      "src/kept.ts": { mutants: [mutant("StillSurvived", "NoCoverage", 10)] },
    });

    expect(
      mergeLedger(prior, uncovered, { absenceKills: false }).entries.find(
        (e) => e.file === "src/kept.ts",
      )?.status,
    ).toBe("NoCoverage");
  });

  it("yields an empty ledger from an empty windowed report and empty prior", () => {
    expect(
      mergeLedger({ entries: [] }, report({}), { absenceKills: false }),
    ).toEqual({ entries: [] });
  });
});
