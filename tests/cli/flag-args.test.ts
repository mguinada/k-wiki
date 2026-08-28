import { describe, expect, it } from "vitest";
import { flagValueError } from "../../src/cli/flag-args.ts";

function values(entries: [string, string | undefined][] = []) {
  return new Map(entries);
}

describe("flagValueError", () => {
  it("is undefined when no flags are given", () => {
    expect(flagValueError(values())).toBeUndefined();
  });

  it("names the flag that lacks a path value", () => {
    expect(flagValueError(values([["--settings", undefined]]))).toBe(
      "--settings needs a path value",
    );
  });

  it("names the first flag that lacks a value", () => {
    expect(
      flagValueError(
        values([
          ["--settings", "/a"],
          ["--raw-dir", undefined],
          ["--outputs", undefined],
        ]),
      ),
    ).toBe("--raw-dir needs a path value");
  });

  it("exempts --timeout from the path-value check", () => {
    expect(flagValueError(values([["--timeout", "30"]]))).toBeUndefined();
  });

  it("rejects --timeout without a value", () => {
    expect(flagValueError(values([["--timeout", undefined]]))).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("rejects --timeout zero", () => {
    expect(flagValueError(values([["--timeout", "0"]]))).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("rejects --timeout with leading junk", () => {
    expect(flagValueError(values([["--timeout", "5s"]]))).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("reports a missing --sources value", () => {
    expect(flagValueError(values(), ["/notes/a.md", undefined])).toBe(
      "--sources needs a path value",
    );
  });

  it("accepts present --sources values", () => {
    expect(flagValueError(values(), ["/notes/a.md", "/notes/b.md"])).toBe(
      undefined,
    );
  });

  it("checks the path flags before the sources values", () => {
    expect(
      flagValueError(values([["--settings", undefined]]), [undefined]),
    ).toBe("--settings needs a path value");
  });

  it("checks the sources values before --timeout", () => {
    expect(flagValueError(values([["--timeout", "x"]]), [undefined])).toBe(
      "--sources needs a path value",
    );
  });

  it("accepts a fully valid flag set with sources", () => {
    expect(
      flagValueError(
        values([
          ["--settings", "/repo/settings.yml"],
          ["--timeout", "90"],
        ]),
        ["/notes/a.md"],
      ),
    ).toBeUndefined();
  });
});
