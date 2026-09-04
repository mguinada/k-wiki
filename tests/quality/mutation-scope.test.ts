import { describe, expect, it, vi } from "vitest";
import {
  buildPatterns,
  collectChangedFiles,
  collectPatterns,
  type GitText,
  main,
  mergeRanges,
  nextIntArg,
  parseNewRanges,
  parseWindowDays,
  resolveBase,
  runGitText,
  windowBase,
} from "../../src/quality/mutation-scope.ts";

const HUNK_FILE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,7 +12,9 @@ function a() {",
  " context",
  "@@ -40,3 +50,0 @@ function b() {",
  "-deleted",
].join("\n");

describe("nextIntArg", () => {
  it("returns the integer value after the flag at the index", () => {
    expect(nextIntArg(["--index", "2"], 0)).toBe(2);
  });

  it("names the flag when the value is missing", () => {
    expect(() => nextIntArg(["--index"], 0)).toThrow(
      "--index requires an integer value",
    );
  });

  it("names the flag when the value is not an integer", () => {
    expect(() => nextIntArg(["--total", "half"], 0)).toThrow(
      "--total requires an integer value",
    );
  });
});

describe("parseNewRanges", () => {
  it("returns the new-side line range of a hunk header", () => {
    expect(parseNewRanges("@@ -10,7 +12,9 @@ ctx")).toEqual([
      { start: 12, end: 20 },
    ]);
  });

  it("maps a one-line hunk to start equal to end", () => {
    expect(parseNewRanges("@@ -1,1 +5,1 @@ ctx")).toEqual([
      { start: 5, end: 5 },
    ]);
  });

  it("skips a pure-deletion hunk that adds no new lines", () => {
    expect(parseNewRanges("@@ -40,3 +50,0 @@ ctx")).toEqual([]);
  });

  it("maps a single-line hunk without a count to start equal to end", () => {
    expect(parseNewRanges("@@ -1 +7 @@ ctx")).toEqual([{ start: 7, end: 7 }]);
  });

  it("returns null for a malformed hunk header", () => {
    expect(parseNewRanges("@@ nonsense here")).toBeNull();
  });
});

describe("mergeRanges", () => {
  it("merges a range that starts on the line after another ends", () => {
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 13, end: 15 },
      ]),
    ).toEqual([{ start: 10, end: 15 }]);
  });

  it("keeps ranges with a gap between them separate", () => {
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 14, end: 15 },
      ]),
    ).toEqual([
      { start: 10, end: 12 },
      { start: 14, end: 15 },
    ]);
  });
});

describe("buildPatterns", () => {
  it("renders one path:range entry per merged range", () => {
    expect(
      buildPatterns([
        { path: "src/a.ts", ranges: [{ start: 1, end: 5 }] },
        { path: "src/b.ts", ranges: [{ start: 7, end: 7 }] },
      ]),
    ).toBe("src/a.ts:1-5,src/b.ts:7-7");
  });

  it("renders a bare path for a file whose diff is unparseable", () => {
    expect(buildPatterns([{ path: "src/a.ts", ranges: null }])).toBe(
      "src/a.ts",
    );
  });

  it("renders nothing for a file with no mutable ranges", () => {
    expect(buildPatterns([{ path: "src/a.ts", ranges: [] }])).toBe("");
  });
});

describe("mergeRanges (issue #240 kill batch)", () => {
  it("sorts ranges by start before merging", () => {
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 1, end: 3 },
        { start: 20, end: 22 },
      ]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 10, end: 12 },
      { start: 20, end: 22 },
    ]);
  });
});

describe("parseNewRanges (issue #240 kill batch)", () => {
  it("reads every hunk header of a multi-line diff", () => {
    expect(parseNewRanges("@@ -1 +2 @@ ctx\nbody\n@@ -5 +6 @@ ctx")).toEqual([
      { start: 2, end: 2 },
      { start: 6, end: 6 },
    ]);
  });
});

describe("buildPatterns (issue #240 kill batch)", () => {
  it("starts the list with the first file's entry, not a stray seed", () => {
    expect(
      buildPatterns([
        { path: "src/new.ts", ranges: null },
        { path: "src/a.ts", ranges: [{ start: 1, end: 2 }] },
      ]),
    ).toBe("src/new.ts,src/a.ts:1-2");
  });
});

describe("collectChangedFiles", () => {
  it("keeps a hunk file and drops a deleted file from the changed list", () => {
    const git: GitText = (args) =>
      args[0] === "diff"
        ? [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,1 +2,2 @@",
            " context",
            "+new",
            "diff --git a/src/gone.ts b/src/gone.ts",
            "deleted file mode 100644",
            "--- a/src/gone.ts",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-old",
          ].join("\n")
        : "";

    expect(collectChangedFiles(git)).toEqual([
      { path: "src/a.ts", ranges: [{ start: 2, end: 3 }] },
    ]);
  });
});

describe("collectPatterns", () => {
  it("returns an empty string when no src file changed and none is untracked", () => {
    const git: GitText = () => "";

    expect(collectPatterns(git)).toBe("");
  });

  it("combines hunk ranges with whole untracked files in one list", () => {
    const git: GitText = (args) =>
      args[0] === "diff" ? HUNK_FILE : "src/new.ts\n";

    expect(collectPatterns(git)).toBe("src/a.ts:12-20,src/new.ts");
  });

  it("skips a diff entry whose new side is /dev/null", () => {
    const git: GitText = (args) =>
      args[0] === "diff"
        ? [
            "diff --git a/src/gone.ts b/src/gone.ts",
            "deleted file mode 100644",
            "--- a/src/gone.ts",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-old",
          ].join("\n")
        : "";

    expect(collectPatterns(git)).toBe("");
  });

  it("falls back to the whole file when its hunk header is malformed", () => {
    const git: GitText = (args) =>
      args[0] === "diff"
        ? [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ broken",
            "+x",
          ].join("\n")
        : "";

    expect(collectPatterns(git)).toBe("src/a.ts");
  });
});

describe("mutation-scope CLI", () => {
  it("prints the usage line for --help without reading the repository", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const git: GitText = () => {
      throw new Error("git must not run for --help");
    };

    try {
      main(["--help"], git);

      expect(log.mock.calls[0]?.[0]).toContain("Usage: mutation-scope");
    } finally {
      log.mockRestore();
    }
  });

  it("prints the same help for -h as for --help", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const git: GitText = () => {
      throw new Error("git must not run for -h");
    };

    try {
      main(["-h"], git);

      expect(spy.mock.calls[0]?.[0]).toContain("Usage: mutation-scope");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an unexpected argument instead of ignoring it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const git: GitText = () => "";

    try {
      main(["bogus"], git);

      expect(error.mock.calls[0]?.[0]).toContain("unexpected argument: bogus");
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("rejects an unknown option instead of ignoring it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const git: GitText = () => "";

    try {
      main(["--bogus"], git);

      expect(error.mock.calls[0]?.[0]).toContain('unknown option "--bogus"');
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("prints nothing when the collected pattern list is empty", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const git: GitText = () => "";

    try {
      main([], git, {});

      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("prints the collected patterns for a changed src file", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const git: GitText = (args) =>
      args[0] === "diff"
        ? [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,1 +12,9 @@",
            "+x",
          ].join("\n")
        : "";

    try {
      main([], git, {});

      expect(log.mock.calls[0]?.[0]).toBe("src/a.ts:12-20");
    } finally {
      log.mockRestore();
    }
  });

  it("runs the real git binary through the production seam", () => {
    expect(runGitText(["--version"])).toMatch(/^git version /);
  });
});

describe("parseWindowDays", () => {
  it("returns the integer for a positive integer string", () => {
    expect(parseWindowDays("7")).toBe(7);
  });

  it("rejects zero with the env name in the message", () => {
    expect(() => parseWindowDays("0")).toThrow(
      "MUTATION_WINDOW_DAYS must be a positive integer",
    );
  });

  it("rejects a non-integer string with the env name in the message", () => {
    expect(() => parseWindowDays("week")).toThrow(
      "MUTATION_WINDOW_DAYS must be a positive integer",
    );
  });
});

describe("windowBase", () => {
  it("resolves the newest origin/main commit before the window", () => {
    const calls: string[][] = [];
    const git: GitText = (args) => {
      calls.push([...args]);

      return "abc123\n";
    };

    expect(windowBase(git, 7)).toBe("abc123");
    expect(calls[0]).toEqual([
      "rev-list",
      "-1",
      "--before=7 days ago",
      "origin/main",
    ]);
  });

  it("falls back to the oldest reachable commit when none is older than the window", () => {
    const git: GitText = (args) =>
      args.join(" ").includes("--before") ? "" : "new1\nmid2\nold3\n";

    expect(windowBase(git, 7)).toBe("old3");
  });
});

describe("resolveBase", () => {
  const emptyEnv: Record<string, string | undefined> = {};
  const git: GitText = () => "abc123\n";

  it("prefers the --base flag over every environment source", () => {
    expect(
      resolveBase(
        "feature/sha",
        { MUTATION_BASE: "env/sha", MUTATION_WINDOW_DAYS: "7" },
        git,
      ),
    ).toBe("feature/sha");
  });

  it("prefers MUTATION_BASE over the window environment", () => {
    expect(
      resolveBase(
        undefined,
        { MUTATION_BASE: "env/sha", MUTATION_WINDOW_DAYS: "7" },
        git,
      ),
    ).toBe("env/sha");
  });

  it("resolves MUTATION_WINDOW_DAYS to the window base sha", () => {
    expect(resolveBase(undefined, { MUTATION_WINDOW_DAYS: "7" }, git)).toBe(
      "abc123",
    );
  });

  it("defaults to origin/main with no base sources", () => {
    expect(resolveBase(undefined, emptyEnv, git)).toBe("origin/main");
  });
});

describe("base-parameterized scoping", () => {
  it("diffs against the given base instead of origin/main", () => {
    const diffs: string[][] = [];
    const git: GitText = (args) => {
      if (args[0] === "diff") {
        diffs.push([...args]);

        return "";
      }

      return "";
    };

    collectPatterns(git, "abc123");

    expect(diffs[0]?.slice(0, 4)).toEqual([
      "diff",
      "-U0",
      "--diff-filter=ACMRT",
      "abc123",
    ]);
  });

  it("scopes main's diff to the window base from the environment", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const diffs: string[][] = [];
    const git: GitText = (args) => {
      if (args[0] === "diff") {
        diffs.push([...args]);

        return [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,1 +12,9 @@",
          "+x",
        ].join("\n");
      }

      return args[0] === "rev-list" ? "abc123\n" : "";
    };

    try {
      main([], git, { MUTATION_WINDOW_DAYS: "7" });

      expect(diffs[0]?.[3]).toBe("abc123");
      expect(log.mock.calls[0]?.[0]).toBe("src/a.ts:12-20");
    } finally {
      log.mockRestore();
    }
  });

  it("exits 1 naming MUTATION_WINDOW_DAYS when it is not a positive integer", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      main([], () => "", { MUTATION_WINDOW_DAYS: "week" });

      expect(error.mock.calls[0]?.[0]).toContain(
        "MUTATION_WINDOW_DAYS must be a positive integer",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
  });
});

describe("mutation-scope --base and --print-base", () => {
  it("scopes the diff to the --base flag value", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const diffs: string[][] = [];
    const git: GitText = (args) => {
      if (args[0] === "diff") {
        diffs.push([...args]);

        return [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,1 +12,9 @@",
          "+x",
        ].join("\n");
      }

      return "";
    };

    try {
      main(["--base", "feature/sha"], git);

      expect(diffs[0]?.[3]).toBe("feature/sha");
      expect(log.mock.calls[0]?.[0]).toBe("src/a.ts:12-20");
    } finally {
      log.mockRestore();
    }
  });

  it("exits 1 naming --base when its value is absent", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      main(["--base"], () => "");

      expect(error.mock.calls[0]?.[0]).toContain("--base requires a value");
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("prints only the resolved base for --print-base", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      main(["--print-base"], () => "", {});

      expect(log.mock.calls[0]?.[0]).toBe("origin/main");
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
