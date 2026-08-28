import { describe, expect, it } from "vitest";
import {
  flagValueError,
  isIsoDate,
  readDateFlag,
  timeoutArgError,
} from "../../src/cli/flag-args.ts";

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

describe("timeoutArgError", () => {
  it("is undefined for a positive integer of seconds", () => {
    expect(timeoutArgError("5")).toBeUndefined();
  });

  it("rejects undefined (the caller must only pass a present flag)", () => {
    expect(timeoutArgError(undefined)).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("rejects zero", () => {
    expect(timeoutArgError("0")).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("rejects a leading zero", () => {
    expect(timeoutArgError("05")).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("rejects non-numeric text", () => {
    expect(timeoutArgError("soon")).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("rejects an empty value", () => {
    expect(timeoutArgError("")).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });
});

describe("readDateFlag", () => {
  it("defaults to today's calendar date when the flag is absent", () => {
    const { date, consumed } = readDateFlag(["wiki"]);

    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...consumed]).toEqual([]);
  });

  it("reads the flag's value and marks both indexes consumed", () => {
    const { date, consumed } = readDateFlag([
      "wiki",
      "--date",
      "2026-08-28",
      "raw",
    ]);

    expect(date).toBe("2026-08-28");
    expect([...consumed]).toEqual([1, 2]);
  });

  it("yields an undefined date when the flag ends argv", () => {
    const { date, consumed } = readDateFlag(["--date"]);

    expect(date).toBeUndefined();
    expect([...consumed]).toEqual([0, 1]);
  });
});

describe("isIsoDate", () => {
  it("accepts a calendar-shaped value", () => {
    expect(isIsoDate("2026-08-28")).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isIsoDate(undefined)).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(isIsoDate("")).toBe(false);
  });

  it("rejects slash-separated dates", () => {
    expect(isIsoDate("2026/08/28")).toBe(false);
  });

  it("rejects a short year", () => {
    expect(isIsoDate("26-08-28")).toBe(false);
  });

  it("rejects trailing text after the date", () => {
    expect(isIsoDate("2026-08-28x")).toBe(false);
  });

  it("rejects leading text before the date", () => {
    expect(isIsoDate("x2026-08-28")).toBe(false);
  });
});
