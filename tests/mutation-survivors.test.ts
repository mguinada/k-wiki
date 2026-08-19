import { describe, expect, it } from "vitest";
import { actionableLines } from "../scripts/mutation-survivors.ts";

const report = {
  files: {
    "src/sync/config.ts": {
      mutants: [
        {
          mutatorName: "EqualityOperator",
          status: "Killed",
          location: { start: { line: 10 } },
        },
        {
          mutatorName: "StringLiteral",
          status: "Survived",
          location: { start: { line: 42 } },
        },
        {
          mutatorName: "ConditionalExpression",
          status: "Survived",
          location: { start: { line: 7 } },
        },
      ],
    },
    "src/sync/scan.ts": {
      mutants: [
        {
          mutatorName: "MethodExpression",
          status: "NoCoverage",
          location: { start: { line: 3 } },
        },
        {
          mutatorName: "ArrowFunction",
          status: "Timeout",
          location: { start: { line: 9 } },
        },
      ],
    },
  },
};

describe("actionableLines", () => {
  it("lists exactly the survived and no-coverage mutants as file:line entries sorted by file and line", () => {
    expect(actionableLines(report)).toEqual([
      "Survived  src/sync/config.ts:7  ConditionalExpression",
      "Survived  src/sync/config.ts:42  StringLiteral",
      "NoCoverage  src/sync/scan.ts:3  MethodExpression",
    ]);
  });
});
