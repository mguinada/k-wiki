import { describe, expect, it, vi } from "vitest";
import { canAnimate, cliFail, errorMessage, terminalColors } from "../../src/cli/colors.ts";

/** The shared CLI presentation kit: one NO_COLOR policy point and one
 *  usage-error rule for every CLI (docs/references/colors.md). */

describe("terminalColors", () => {
  it("enables colors when NO_COLOR is absent", () => {
    expect(terminalColors({}).red("x")).not.toBe("x");
  });

  it("yields plain text when NO_COLOR is set to a non-empty value", () => {
    expect(terminalColors({ NO_COLOR: "1" }).red("x")).toBe("x");
  });

  it("keeps colors on for an empty NO_COLOR value (the spec: present AND non-empty disables)", () => {
    expect(terminalColors({ NO_COLOR: "" }).red("x")).not.toBe("x");
  });
});

describe("canAnimate", () => {
  it("is true only for a TTY with colors on", () => {
    expect(canAnimate(true, {})).toBe(true);
    expect(canAnimate(false, {})).toBe(false);
    expect(canAnimate(true, { NO_COLOR: "1" })).toBe(false);
  });
});

describe("errorMessage", () => {
  it("unwraps an Error to its message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a thrown non-Error", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("cliFail", () => {
  it("prints '<name>: <message>' red on stderr and sets exit code 1", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(" "));
    });
    const priorExit = process.exitCode;

    try {
      cliFail("check-raw", "bad input");
      expect(errors[0]).toContain("check-raw: bad input");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExit;
      spy.mockRestore();
    }
  });
});
