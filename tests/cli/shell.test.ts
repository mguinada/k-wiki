import { describe, expect, it } from "vitest";
import { agentRunFlags, parseArgs } from "../../src/cli/shell.ts";

/**
 * The shared CLI shell (issue #254): one argv parser every CLI
 * consumes — value flags, boolean flags, positionals under a count
 * rule, and the one unknown-arg policy (reject, flag named) — plus
 * the agent-run flag set as one parsed-and-validated result object
 * (RF-2), derived once at the CLI boundary.
 */

describe("parseArgs", () => {
  it("collects the value of each value flag", () => {
    const parsed = parseArgs(["--settings", "a.yml", "--outputs", "o"], {
      value: ["--settings", "--outputs"],
    });

    expect(parsed.values.get("--settings")).toBe("a.yml");
  });

  it("collects the value of the second value flag", () => {
    const parsed = parseArgs(["--settings", "a.yml", "--outputs", "o"], {
      value: ["--settings", "--outputs"],
    });

    expect(parsed.values.get("--outputs")).toBe("o");
  });

  it("keeps a value flag present with an undefined value when it ends argv", () => {
    const parsed = parseArgs(["--settings"], { value: ["--settings"] });

    expect(parsed.values.get("--settings")).toBeUndefined();
  });

  it("never reads a value flag's value as a positional, dash included", () => {
    const parsed = parseArgs(["--timeout", "-5"], { value: ["--timeout"] });

    expect(parsed.values.get("--timeout")).toBe("-5");
    expect(parsed.positional).toEqual([]);
  });

  it("lets a repeated value flag's last value win", () => {
    const parsed = parseArgs(["--settings", "a.yml", "--settings", "b.yml"], {
      value: ["--settings"],
    });

    expect(parsed.values.get("--settings")).toBe("b.yml");
  });

  it("reads a value flag's inline = form as its value", () => {
    const parsed = parseArgs(["--timeout=5", "q"], { value: ["--timeout"] });

    expect(parsed.values.get("--timeout")).toBe("5");
    expect(parsed.positional).toEqual(["q"]);
  });

  it("keeps the value whole when it contains further = signs", () => {
    const parsed = parseArgs(["--settings=a=b.yml"], { value: ["--settings"] });

    expect(parsed.values.get("--settings")).toBe("a=b.yml");
  });

  it("records the boolean flags that are present", () => {
    const parsed = parseArgs(["--dry-run", "pos", "--json"], {
      boolean: ["--dry-run", "--json"],
    });

    expect([...parsed.flags].sort()).toEqual(["--dry-run", "--json"]);
  });

  it("omits the boolean flags that are absent", () => {
    const parsed = parseArgs(["pos"], { boolean: ["--dry-run"] });

    expect(parsed.flags.has("--dry-run")).toBe(false);
  });

  it("collects the positionals in argv order", () => {
    const parsed = parseArgs(["a", "--dry-run", "b"], {
      boolean: ["--dry-run"],
    });

    expect(parsed.positional).toEqual(["a", "b"]);
  });

  it("names an unknown long option in the usage error", () => {
    const parsed = parseArgs(["--nope"], { value: ["--settings"] });

    expect(parsed.error).toBe('unknown option "--nope"');
  });

  it("names an unknown short option in the usage error", () => {
    const parsed = parseArgs(["-x"], { boolean: ["-o"] });

    expect(parsed.error).toBe('unknown option "-x"');
  });

  it("reports no error for a valid argv", () => {
    const parsed = parseArgs(["--settings", "a.yml", "config"], {
      value: ["--settings"],
    });

    expect(parsed.error).toBeUndefined();
  });

  it("reports the spec's message for a positional beyond the maximum", () => {
    const parsed = parseArgs(["a", "b", "c"], {
      positionals: {
        max: 2,
        error: (arg, count) =>
          `expected at most two arguments (<config> and <raw-dir>), got ${count} first ${arg}`,
      },
    });

    expect(parsed.error).toBe(
      "expected at most two arguments (<config> and <raw-dir>), got 3 first c",
    );
  });

  it("skips a hole in the argv array without recording an argument", () => {
    const parsed = parseArgs(["a", undefined, "b"]);

    expect(parsed.positional).toEqual(["a", "b"]);
    expect(parsed.error).toBeUndefined();
  });

  it("accepts any number of positionals without a maximum", () => {
    const parsed = parseArgs(["a", "b", "c"]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.positional).toEqual(["a", "b", "c"]);
  });

  it("rejects a dash-prefixed argument as an unknown option under an empty spec", () => {
    const parsed = parseArgs(["--weird", "pos"]);

    expect(parsed.error).toBe('unknown option "--weird"');
  });

  it("names an inline = form of an unknown flag with the whole token", () => {
    const parsed = parseArgs(["--nope=5"], { value: ["--timeout"] });

    expect(parsed.error).toBe('unknown option "--nope=5"');
  });

  it("rejects an inline = value on a boolean flag as unknown", () => {
    const parsed = parseArgs(["--print=x"], { boolean: ["--print"] });

    expect(parsed.error).toBe('unknown option "--print=x"');
  });

  it("collects every token after -- verbatim as positionals", () => {
    const parsed = parseArgs(["read", "--", "-weird-slug"]);

    expect(parsed.positional).toEqual(["read", "-weird-slug"]);
    expect(parsed.error).toBeUndefined();
  });

  it("stops flag parsing at -- even for known flags", () => {
    const parsed = parseArgs(["--", "--dry-run"], { boolean: ["--dry-run"] });

    expect(parsed.flags.has("--dry-run")).toBe(false);
    expect(parsed.positional).toEqual(["--dry-run"]);
  });

  it("keeps a later -- a positional after the first", () => {
    const parsed = parseArgs(["--", "--"]);

    expect(parsed.positional).toEqual(["--"]);
  });

  it("applies the count rule to positionals gathered after --", () => {
    const parsed = parseArgs(["--", "a", "b", "c"], {
      positionals: { max: 2, error: (_arg, count) => `got ${count}` },
    });

    expect(parsed.error).toBe("got 3");
  });
});

describe("parseArgs repeatable flags", () => {
  it("collects every occurrence's value in argv order", () => {
    const parsed = parseArgs(["--sources", "a/x.md", "--sources", "b/y.md"], {
      repeat: ["--sources"],
    });

    expect(parsed.repeated.get("--sources")).toEqual(["a/x.md", "b/y.md"]);
  });

  it("keeps an undefined entry when a repeat flag ends argv", () => {
    const parsed = parseArgs(["--sources", "a/x.md", "--sources"], {
      repeat: ["--sources"],
    });

    expect(parsed.repeated.get("--sources")).toEqual(["a/x.md", undefined]);
  });

  it("reads the inline = form as one collected value", () => {
    const parsed = parseArgs(["--sources=a/x.md", "pos"], {
      repeat: ["--sources"],
    });

    expect(parsed.repeated.get("--sources")).toEqual(["a/x.md"]);
    expect(parsed.positional).toEqual(["pos"]);
  });

  it("never reads a repeat flag's value as a positional", () => {
    const parsed = parseArgs(["--sources", "-weird"], {
      repeat: ["--sources"],
    });

    expect(parsed.repeated.get("--sources")).toEqual(["-weird"]);
    expect(parsed.positional).toEqual([]);
  });

  it("collects repeat values beside single value flags and positionals", () => {
    const parsed = parseArgs(
      [
        "--settings",
        "a.yml",
        "--sources",
        "a/x.md",
        "raw",
        "--sources",
        "b/y.md",
      ],
      { value: ["--settings"], repeat: ["--sources"] },
    );

    expect(parsed.values.get("--settings")).toBe("a.yml");
    expect(parsed.repeated.get("--sources")).toEqual(["a/x.md", "b/y.md"]);
    expect(parsed.positional).toEqual(["raw"]);
  });

  it("omits a repeat flag that never occurs", () => {
    const parsed = parseArgs(["pos"], { repeat: ["--sources"] });

    expect(parsed.repeated.has("--sources")).toBe(false);
  });
});

describe("agentRunFlags", () => {
  it("maps the settings flag's value", () => {
    const flags = agentRunFlags(new Map([["--settings", "a.yml"]]));

    expect(flags.settings).toBe("a.yml");
  });

  it("maps the outputs flag's value", () => {
    const flags = agentRunFlags(new Map([["--outputs", "o"]]));

    expect(flags.outputs).toBe("o");
  });

  it("converts the timeout seconds to milliseconds", () => {
    const flags = agentRunFlags(new Map([["--timeout", "5"]]));

    expect(flags.timeoutMs).toBe(5000);
  });

  it("leaves every field undefined for an empty flag set", () => {
    const flags = agentRunFlags(new Map());

    expect(flags).toEqual({
      settings: undefined,
      outputs: undefined,
      timeoutMs: undefined,
      error: undefined,
    });
  });

  it("surfaces the path-value error for a flag without a value", () => {
    const flags = agentRunFlags(new Map([["--settings", undefined]]));

    expect(flags.error).toBe("--settings needs a path value");
  });

  it("surfaces the timeout error for a non-numeric timeout", () => {
    const flags = agentRunFlags(new Map([["--timeout", "abc"]]));

    expect(flags.error).toBe(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("surfaces the path-value error of a sibling flag such as --raw-dir", () => {
    const flags = agentRunFlags(
      new Map([
        ["--settings", "a.yml"],
        ["--raw-dir", undefined],
      ]),
    );

    expect(flags.error).toBe("--raw-dir needs a path value");
  });
});
