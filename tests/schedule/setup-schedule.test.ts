import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { pathExists } from "../../src/cli/shared.ts";
import {
  LAUNCHD_LABEL,
  plistPath,
  WATCHDOG_LAUNCHD_LABEL,
  watchdogPlistPath,
} from "../../src/schedule/launchd-plists.ts";
import {
  type CheckoutFacts,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_SECONDS,
  main,
  originRefusal,
  parseIntervalDuration,
  parseScheduleArgs,
  parseWeeklyAt,
  schedulerUnsupportedError,
  stableNodePath,
  staleAfterTextFor,
} from "../../src/schedule/setup-schedule.ts";
import { insideStrykerSandbox } from "../quality/src-tree.ts";

/** A git probe reporting the canonical main checkout — the origin
 *  guard's default, injected so tests do not depend on where the
 *  suite's own checkout sits (a linked worktree locally, the main
 *  checkout in CI). */
const canonicalGit = async (
  _dir: string,
  args: readonly string[],
): Promise<string> => {
  const last = args.at(-1);

  if (last === "--git-common-dir") return "/repo/.git";
  if (last === "--git-dir") return "/repo/.git";

  return "refs/heads/main";
};

describe("parseIntervalDuration", () => {
  it.each([
    ["15minutes", 900],
    ["30minutes", 1800],
    ["1hour", 3600],
    ["2hours", 7200],
    ["45seconds", 45],
    ["30MINUTES", 1800],
    ["1minute", 60],
  ] as const)("parses %s into %i seconds", (text, seconds) => {
    expect(parseIntervalDuration(text)).toBe(seconds);
  });

  it("rejects trailing junk after the unit", () => {
    expect(parseIntervalDuration("15minutesx")).toBeUndefined();
  });

  it("parses a singular second", () => {
    expect(parseIntervalDuration("1second")).toBe(1);
  });

  it("parses an interval with surrounding whitespace", () => {
    expect(parseIntervalDuration(" 15minutes ")).toBe(900);
  });

  it.each(["15", "minutes", "abc", "0minutes", "-5minutes", "1.5hours", ""])(
    "rejects %s",
    (text) => {
      expect(parseIntervalDuration(text)).toBeUndefined();
    },
  );
});

describe("parseScheduleArgs", () => {
  it("rejects an unknown option instead of silently using defaults", () => {
    const parsed = parseScheduleArgs(["--inteval", "15minutes"]);

    expect(parsed.error).toContain("unknown option");
  });

  it("rejects a positional argument", () => {
    const parsed = parseScheduleArgs(["15minutes"]);

    expect(parsed.error).toContain("unexpected argument");
  });

  it("rejects --interval without a value", () => {
    const parsed = parseScheduleArgs(["--interval"]);

    expect(parsed.error).toContain("needs a duration value");
  });

  it("rejects --stale-after without a value", () => {
    const parsed = parseScheduleArgs(["--watchdog", "--stale-after"]);

    expect(parsed.error).toContain("needs a duration value");
  });

  it("rejects an invalid --interval value", () => {
    const parsed = parseScheduleArgs(["--interval", "soon"]);

    expect(parsed.error).toContain("invalid --interval value");
  });

  it("reads --interval 15minutes", () => {
    const parsed = parseScheduleArgs(["--interval", "15minutes"]);

    expect(parsed.interval).toBe(900);
  });

  it("defaults the interval to the agreed 30 minutes", () => {
    const parsed = parseScheduleArgs(["--print"]);

    expect(parsed.interval).toBe(DEFAULT_INTERVAL_SECONDS);
  });

  it("reads --print", () => {
    const parsed = parseScheduleArgs(["--print"]);

    expect(parsed.print).toBe(true);
  });

  it("reads --uninstall", () => {
    const parsed = parseScheduleArgs(["--uninstall"]);

    expect(parsed.uninstall).toBe(true);
  });

  it("errors on nothing when only the known flags are passed", () => {
    const parsed = parseScheduleArgs([
      "--interval",
      "45seconds",
      "--print",
      "--uninstall",
    ]);

    expect(parsed.error).toBeUndefined();
  });
});

describe("main --print", () => {
  it("prints the macOS plist on a platform without a scheduler backend", async () => {
    const printed: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((line) => void printed.push(String(line)));

    try {
      await main(["--print"], "linux");
    } finally {
      spy.mockRestore();
    }

    expect(printed.join("\n")).toContain(LAUNCHD_LABEL);
  });
});

describe("plistPath", () => {
  it("places the plist in ~/Library/LaunchAgents", () => {
    expect(plistPath("/Users/me")).toBe(
      `/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
  });
});

describe("DEFAULT_INTERVAL_SECONDS", () => {
  it("is the agreed 30 minutes", () => {
    expect(DEFAULT_INTERVAL_SECONDS).toBe(1800);
  });
});

describe("stableNodePath", () => {
  it("pins the invocation path when it is absolute and existing", () => {
    expect(
      stableNodePath(
        "/opt/homebrew/bin/node",
        "/opt/homebrew/Cellar/node/26.7.0/bin/node",
        () => true,
      ),
    ).toBe("/opt/homebrew/bin/node");
  });

  it("falls back to the resolved binary for a relative invocation path", () => {
    const execPath = "/opt/homebrew/Cellar/node/26.7.0/bin/node";

    expect(stableNodePath("node", execPath, () => true)).toBe(execPath);
  });

  it("falls back to the resolved binary when the invocation path no longer exists", () => {
    const execPath = "/opt/homebrew/Cellar/node/26.7.0/bin/node";

    expect(stableNodePath("/gone/bin/node", execPath, () => false)).toBe(
      execPath,
    );
  });
});

describe("main --print node path pinning", () => {
  it("pins the symlinked invocation path, not the resolved binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-argv0-"));
    const nodeSymlink = join(dir, "node-stable");
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

    await symlink(process.execPath, nodeSymlink);

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(nodeSymlink, [
        join(repoRoot, "bin", "setup-schedule"),
        "--print",
      ]);
      let out = "";

      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`)),
      );
    });

    await rm(dir, { recursive: true, force: true });

    expect(stdout).toContain(`<string>${nodeSymlink}</string>`);
    expect(stdout).not.toContain(
      `<string>${realpathSync(process.execPath)}</string>`,
    );
  });
});

describe("schedulerUnsupportedError", () => {
  it("points linux at the systemd follow-up and the --print escape hatch", () => {
    const message = schedulerUnsupportedError("linux");

    expect(message).toContain("linux");
    expect(message).toContain("systemd");
    expect(message).toContain("--print");
  });

  it("points win32 at the Task Scheduler follow-up", () => {
    const message = schedulerUnsupportedError("win32");

    expect(message).toContain("win32");
    expect(message).toContain("Task Scheduler");
  });
});

describe("parseIntervalDuration killers", () => {
  it("rejects a zero interval", () => {
    expect(parseIntervalDuration("0minutes")).toBeUndefined();
  });

  it("rejects a bare number", () => {
    expect(parseIntervalDuration("15")).toBeUndefined();
  });

  it("rejects a fractional interval", () => {
    expect(parseIntervalDuration("1.5hours")).toBeUndefined();
  });

  it("parses units case-insensitively", () => {
    expect(parseIntervalDuration("15MINUTES")).toBe(900);
  });

  it("parses a singular hour", () => {
    expect(parseIntervalDuration("1hour")).toBe(3600);
  });

  it("parses plural seconds", () => {
    expect(parseIntervalDuration("45seconds")).toBe(45);
  });
});

describe("schedulerUnsupportedError backends", () => {
  it("does not name systemd for win32", () => {
    expect(schedulerUnsupportedError("win32")).not.toContain("systemd");
  });

  it("does not name Task Scheduler for linux", () => {
    expect(schedulerUnsupportedError("linux")).not.toContain("Task Scheduler");
  });

  it("falls back to naming the platform for an unknown OS", () => {
    expect(schedulerUnsupportedError("solaris")).toContain(
      "a solaris scheduler",
    );
  });
});

describe("setup-schedule help", () => {
  async function runMain(
    args: readonly string[],
    platform: NodeJS.Platform = "darwin",
    runLaunchctl?: (args: readonly string[]) => Promise<void>,
  ): Promise<{ out: string; err: string; exitCode: string }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), ...args];
    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main(args, platform, runLaunchctl);
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return {
      out: out.join("\n"),
      err: err.join("\n"),
      exitCode: process.exitCode === undefined ? "0" : String(process.exitCode),
    };
  }

  it("prints the usage line for --help", async () => {
    const { out, exitCode } = await runMain(["--help"]);

    expect(`${exitCode}|${out.split("\n")[0]}`).toBe(
      "0|Usage: setup-schedule [-h | --help] [--calendar [--weekly-at <day-HH:MM>]] [--watchdog [--stale-after <duration>]] [--interval <duration>] [--print] [--uninstall]",
    );
  });

  it("documents the interval default in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("Default: 30minutes");
  });

  it("documents the non-installing --print mode in the help text", async () => {
    const { out } = await runMain(["--help"]);

    expect(out).toContain("without installing or loading");
  });
});

describe("setup-schedule main: failure rendering", () => {
  /** Run main() with captured stderr and a clean exit code. */
  async function runFail(
    args: readonly string[],
    platform: NodeJS.Platform,
  ): Promise<string> {
    const err: string[] = [];

    process.exitCode = undefined;

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main(args, platform, undefined, "/unused-home", canonicalGit);
    } finally {
      errorSpy.mockRestore();
    }

    const exitCode = process.exitCode === undefined ? "0" : process.exitCode;

    return `${exitCode}|${err.join("\n")}`;
  }

  it("renders a usage error red on stderr with exit 1", async () => {
    expect(await runFail(["--bogus"], "darwin")).toBe(
      '1|\u001b[31msetup-schedule: unknown option "--bogus"\u001b[39m',
    );
  });

  it("renders the unsupported-platform refusal red on stderr with exit 1", async ({
    skip,
  }) => {
    if (insideStrykerSandbox()) {
      skip("origin guard shadows the platform refusal in the Stryker sandbox");

      return;
    }

    expect(await runFail([], "linux")).toBe(
      "1|\u001b[31msetup-schedule: scheduling on linux is not implemented yet — the backend is a systemd timer, a follow-up issue (out of scope); use --print to inspect the macOS artifact or run wiki-sync manually\u001b[39m",
    );
  });
});

describe("setup-schedule origin guard (issue #361)", () => {
  /** Git facts for the canonical main checkout on a branch. */
  const canonicalFacts: CheckoutFacts = {
    commonDir: "/repo/.git",
    gitDir: "/repo/.git",
    head: "refs/heads/main",
  };

  /** A git probe reporting a linked worktree on a branch. */
  const worktreeGit = async (
    _dir: string,
    args: readonly string[],
  ): Promise<string> => {
    const last = args.at(-1);

    if (last === "--git-common-dir") return "/repo/.git";
    if (last === "--git-dir") return "/repo/.git/worktrees/issue-x";

    return "refs/heads/issue-x";
  };

  /** Run main() with the origin guard's outcome captured: stderr,
   *  exit code, the launchctl calls made, and whether anything landed
   *  under the temp home. */
  async function runGuarded(
    args: readonly string[],
    platform: NodeJS.Platform,
    git: (dir: string, args: readonly string[]) => Promise<string>,
    sandboxed = false,
  ): Promise<{
    err: string;
    exitCode: number | undefined;
    launchctl: string[][];
    home: string;
  }> {
    const home = await mkdtemp(join(tmpdir(), "k-wiki-setup-origin-"));
    const err: string[] = [];
    const launchctl: string[][] = [];

    process.exitCode = undefined;

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      if (sandboxed) {
        (globalThis as Record<string, unknown>).__stryker__ = {};
      }

      await main(
        args,
        platform,
        async (callArgs) => void launchctl.push([...callArgs]),
        home,
        git,
      );
    } finally {
      if (sandboxed) {
        delete (globalThis as Record<string, unknown>).__stryker__;
      }

      errorSpy.mockRestore();
    }

    return {
      err: err.join("\n"),
      exitCode: process.exitCode,
      launchctl,
      home,
    };
  }

  it("accepts the main checkout on a branch", () => {
    expect(originRefusal(false, canonicalFacts, "/repo")).toBeUndefined();
  });

  it("refuses a Stryker sandbox, naming the k-wiki verb to run instead", () => {
    const refusal = originRefusal(true, canonicalFacts, "/repo");

    expect(refusal).toContain("Stryker sandbox");
    expect(refusal).toContain("k-wiki setup-schedule");
  });

  it("refuses a linked worktree, naming the main checkout path", () => {
    const refusal = originRefusal(
      false,
      {
        commonDir: "/repo/.git",
        gitDir: "/repo/.git/worktrees/issue-x",
        head: "refs/heads/issue-x",
      },
      "/repo-wt",
    );

    expect(refusal).toContain("linked worktree");
    expect(refusal).toContain("/repo");
  });

  it("refuses a detached HEAD", () => {
    const refusal = originRefusal(
      false,
      { commonDir: "/repo/.git", gitDir: "/repo/.git", head: undefined },
      "/repo",
    );

    expect(refusal).toContain("detached");
  });

  it("refuses a checkout git cannot inspect", () => {
    const refusal = originRefusal(
      false,
      { commonDir: undefined, gitDir: undefined, head: undefined },
      "/repo",
    );

    expect(refusal).toContain("not inside a git repository");
  });

  it("refuses install from a linked worktree: exit 1, the refusal, and nothing written", async () => {
    const { err, exitCode, launchctl, home } = await runGuarded(
      [],
      "darwin",
      worktreeGit,
    );

    expect(exitCode).toBe(1);
    expect(err).toContain("linked worktree");
    expect(launchctl).toEqual([]);
    await expect(pathExists(join(home, "Library"))).resolves.toBe(false);

    await rm(home, { recursive: true, force: true });
  });

  it("refuses uninstall from a linked worktree the same way", async () => {
    const { err, exitCode, launchctl, home } = await runGuarded(
      ["--uninstall"],
      "darwin",
      worktreeGit,
    );

    expect(exitCode).toBe(1);
    expect(err).toContain("linked worktree");
    expect(launchctl).toEqual([]);

    await rm(home, { recursive: true, force: true });
  });

  it("refuses install inside a Stryker sandbox even on an unsupported platform", async () => {
    const { err, exitCode, launchctl, home } = await runGuarded(
      [],
      "linux",
      canonicalGit,
      true,
    );

    expect(exitCode).toBe(1);
    expect(err).toContain("Stryker sandbox");
    expect(err).not.toContain("systemd");
    expect(launchctl).toEqual([]);

    await rm(home, { recursive: true, force: true });
  });

  it("lets --print through from a sandboxed origin (it writes nothing)", async () => {
    const home = await mkdtemp(join(tmpdir(), "k-wiki-setup-print-"));
    const printed: string[] = [];

    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      (globalThis as Record<string, unknown>).__stryker__ = {};

      await main(["--print"], "linux", async () => {}, home, canonicalGit);
    } finally {
      delete (globalThis as Record<string, unknown>).__stryker__;
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain(LAUNCHD_LABEL);
    expect(process.exitCode).toBeUndefined();

    await rm(home, { recursive: true, force: true });
  });

  it("installs and replaces cleanly from the main checkout on a branch", async () => {
    const { exitCode, launchctl, home } = await runGuarded(
      [],
      "darwin",
      canonicalGit,
    );

    expect(exitCode).toBeUndefined();
    expect(launchctl.length).toBe(3);
    await expect(
      pathExists(
        join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      ),
    ).resolves.toBe(true);

    await rm(home, { recursive: true, force: true });
  });

  it("documents the origin guard in the help text", async () => {
    const printed: string[] = [];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--help"]);
    } finally {
      logSpy.mockRestore();
    }

    const help = printed.join("\n");

    expect(help).toContain("main working tree");
    expect(help).toContain("Stryker sandbox");
    expect(help).toContain("linked worktree");
  });
});

describe("setup-schedule main: install and uninstall", () => {
  async function tempHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "k-wiki-setup-"));
  }

  it("writes the plist, registers it, and verifies it from the clean launchd view", async () => {
    const home = await tempHome();
    const recorded: string[][] = [];
    const { out, exitCode } = await (async () => {
      const argv = process.argv;
      const out: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

      try {
        await main(
          [],
          "darwin",
          async (args) => {
            recorded.push([...args]);
          },
          home,
          canonicalGit,
        );
      } finally {
        process.argv = argv;
        logSpy.mockRestore();
      }

      return { out: out.join("\n"), exitCode: "0" };
    })();

    const plist = await readFile(
      join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      "utf8",
    );
    const domain = `gui/${process.getuid?.() ?? 501}`;

    expect(recorded).toEqual([
      [
        "bootout",
        domain,
        join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      ],
      [
        "bootstrap",
        domain,
        join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      ],
      ["print", `${domain}/${LAUNCHD_LABEL}`],
    ]);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(out).toContain("installed");
    expect(exitCode).toBe("0");

    await rm(home, { recursive: true, force: true });
  });

  it("fails loud when launchctl cannot bootstrap the job", async () => {
    const home = await tempHome();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        main(
          [],
          "darwin",
          async (args) => {
            if (args[0] === "bootstrap") {
              throw new Error("bootstrap refused");
            }
          },
          home,
          canonicalGit,
        ),
      ).rejects.toThrow("bootstrap refused");
    } finally {
      errors.mockRestore();
    }

    await rm(home, { recursive: true, force: true });
  });

  it("removes the plist and boots the job out on --uninstall", async () => {
    const home = await tempHome();
    const target = join(
      home,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    );
    const recorded: string[][] = [];
    const outs: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => outs.push(parts.join(" ")));

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "<plist/>");

    try {
      await main(
        ["--uninstall"],
        "darwin",
        async (args) => {
          recorded.push([...args]);
        },
        home,
        canonicalGit,
      );
    } finally {
      logSpy.mockRestore();
    }

    await expect(readFile(target, "utf8")).rejects.toThrow();
    expect(recorded).toEqual([
      ["bootout", `gui/${process.getuid?.() ?? 501}`, target],
    ]);
    expect(outs.join("\n")).toContain("uninstalled");

    await rm(home, { recursive: true, force: true });
  });

  it("tolerates a failed bootout during uninstall (nothing was installed)", async () => {
    const home = await tempHome();
    const outs: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => outs.push(parts.join(" ")));

    try {
      await main(
        ["--uninstall"],
        "darwin",
        async () => {
          throw new Error("no such job");
        },
        home,
        canonicalGit,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(outs.join("\n")).toContain("uninstalled");

    await rm(home, { recursive: true, force: true });
  });
});

describe("setup-schedule main wiring (issue #240 kill batch)", () => {
  async function tempHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "k-wiki-setup-wiring-"));
  }

  it("prints the plist with the repo's scheduled-run script path", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--print"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain("bin/scheduled-run</string>");

    await rm(home, { recursive: true, force: true });
  });

  it("prints the plist with the launchd log dir under the given home", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--print"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain(`${home}/Library/Logs/k-wiki`);

    await rm(home, { recursive: true, force: true });
  });

  it("prints the usage line for -h as for --help", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["-h"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain("Usage: setup-schedule");

    await rm(home, { recursive: true, force: true });
  });
});

describe("parseWeeklyAt", () => {
  it("parses a weekday-time into launchd calendar fields", () => {
    expect(parseWeeklyAt("sun-03:00")).toEqual({
      weekday: 0,
      hour: 3,
      minute: 0,
    });
    expect(parseWeeklyAt("SAT-16:45")).toEqual({
      weekday: 6,
      hour: 16,
      minute: 45,
    });
  });

  it("rejects malformed values", () => {
    expect(parseWeeklyAt("sunday-03:00")).toBeUndefined();
    expect(parseWeeklyAt("sun-3:00")).toBeUndefined();
    expect(parseWeeklyAt("sun-24:00")).toBeUndefined();
    expect(parseWeeklyAt("sun-03:60")).toBeUndefined();
    expect(parseWeeklyAt("")).toBeUndefined();
  });
});

describe("calendar registration (issue #359)", () => {
  async function tempHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "k-wiki-cal-"));
  }

  it("prints the sweep plist with a StartCalendarInterval trigger", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--calendar", "--print"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    const plist = printed.join("\n");

    expect(plist).toContain("<string>com.kwiki.scheduled-lint</string>");
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<integer>0</integer>");
    expect(plist).toContain("<integer>3</integer>");
    expect(plist).toContain("<string>--lint-full</string>");
    expect(plist).not.toContain("StartInterval");

    await rm(home, { recursive: true, force: true });
  });

  it("honors --weekly-at for the trigger fields", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(
        ["--calendar", "--weekly-at", "sat-04:30", "--print"],
        "linux",
        async () => {},
        home,
      );
    } finally {
      logSpy.mockRestore();
    }

    const plist = printed.join("\n");

    expect(plist).toContain("<integer>6</integer>");
    expect(plist).toContain("<integer>4</integer>");
    expect(plist).toContain("<integer>30</integer>");

    await rm(home, { recursive: true, force: true });
  });

  it("installs, replaces, and uninstalls only the sweep plist", async () => {
    const home = await tempHome();
    const calls: string[][] = [];

    await main(
      ["--calendar"],
      "darwin",
      async (args) => {
        calls.push([...args]);
      },
      home,
      canonicalGit,
    );

    const target = join(
      home,
      "Library",
      "LaunchAgents",
      "com.kwiki.scheduled-lint.plist",
    );

    expect(calls).toEqual([
      ["bootout", expect.any(String), target],
      ["bootstrap", expect.any(String), target],
      ["print", expect.any(String)],
    ]);
    expect(calls[2]?.[1]).toContain("com.kwiki.scheduled-lint");
    expect(await readFile(target, "utf8")).toContain("--lint-full");
    expect(await pathExists(plistPath(home))).toBe(false);

    await main(
      ["--calendar", "--uninstall"],
      "darwin",
      async (args) => {
        calls.push([...args]);
      },
      home,
      canonicalGit,
    );

    expect(calls.at(-1)).toEqual(["bootout", expect.any(String), target]);
    expect(await pathExists(target)).toBe(false);

    await rm(home, { recursive: true, force: true });
  });

  it("rejects --weekly-at without --calendar", async () => {
    const parsed = parseScheduleArgs(["--weekly-at", "sun-03:00"]);

    expect(parsed.error).toContain("--weekly-at needs --calendar");
  });

  it("rejects an invalid --weekly-at value", async () => {
    const parsed = parseScheduleArgs(["--calendar", "--weekly-at", "whenever"]);

    expect(parsed.error).toContain("invalid --weekly-at value");
  });
});

describe("watchdog registration (issue #362)", () => {
  async function tempHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "k-wiki-wd-"));
  }

  it("prints the watchdog plist with the libexec door and hourly trigger", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--watchdog", "--print"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain(
      `<string>${WATCHDOG_LAUNCHD_LABEL}</string>`,
    );

    await rm(home, { recursive: true, force: true });
  });

  it("bakes the default staleness threshold into the door's arguments", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--watchdog", "--print"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain("<string>--stale-after</string>");

    await rm(home, { recursive: true, force: true });
  });

  it("bakes an explicit threshold verbatim", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(
        ["--watchdog", "--stale-after", "3hours", "--print"],
        "linux",
        async () => {},
        home,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(printed.join("\n")).toContain("<string>3hours</string>");

    await rm(home, { recursive: true, force: true });
  });

  it("runs the libexec door hourly, not the cycle wrapper", async () => {
    const home = await tempHome();
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) =>
        printed.push(parts.join(" ")),
      );

    try {
      await main(["--watchdog", "--print"], "linux", async () => {}, home);
    } finally {
      logSpy.mockRestore();
    }

    const plist = printed.join("\n");

    expect(plist).toContain("/bin/libexec/sync-watchdog</string>");

    await rm(home, { recursive: true, force: true });
  });

  it("installs, replaces, and uninstalls only the watchdog plist", async () => {
    const home = await tempHome();
    const calls: string[][] = [];
    const anchored: string[] = [];

    await main(
      ["--watchdog"],
      "darwin",
      async (args) => {
        calls.push([...args]);
      },
      home,
      canonicalGit,
      async (dataRoot) => {
        anchored.push(dataRoot);
      },
    );

    const target = watchdogPlistPath(home);

    expect(calls).toEqual([
      ["bootout", expect.any(String), target],
      ["bootstrap", expect.any(String), target],
      ["print", expect.any(String)],
    ]);
    expect(anchored).toHaveLength(1);

    await rm(home, { recursive: true, force: true });
  });

  it("stamps the grace anchor only on a real watchdog install", async () => {
    const home = await tempHome();
    const anchored: string[] = [];
    const writeAnchor = async (dataRoot: string) => {
      anchored.push(dataRoot);
    };

    await main(
      ["--watchdog", "--print"],
      "linux",
      async () => {},
      home,
      undefined,
      writeAnchor,
    );
    await main(
      ["--watchdog", "--uninstall"],
      "darwin",
      async () => {},
      home,
      canonicalGit,
      writeAnchor,
    );

    expect(anchored).toEqual([]);

    await rm(home, { recursive: true, force: true });
  });

  it("leaves the interval and sweep plists untouched by a watchdog install", async () => {
    const home = await tempHome();

    await main(["--watchdog", "--print"], "linux", async () => {}, home);

    expect(await pathExists(plistPath(home))).toBe(false);

    await rm(home, { recursive: true, force: true });
  });

  it("rejects --stale-after without --watchdog", () => {
    const parsed = parseScheduleArgs(["--stale-after", "3hours"]);

    expect(parsed.error).toContain("--stale-after needs --watchdog");
  });

  it("rejects an invalid --stale-after value", () => {
    const parsed = parseScheduleArgs(["--watchdog", "--stale-after", "soon"]);

    expect(parsed.error).toContain("invalid --stale-after value");
  });

  it("rejects --interval alongside --watchdog", () => {
    const parsed = parseScheduleArgs(["--watchdog", "--interval", "1hour"]);

    expect(parsed.error).toContain(
      "--interval configures the cycle registration only",
    );
  });

  it("rejects --calendar alongside --watchdog", () => {
    const parsed = parseScheduleArgs(["--calendar", "--watchdog"]);

    expect(parsed.error).toContain("choose one registration per invocation");
  });
});

describe("staleAfterTextFor (issue #362)", () => {
  it("renders whole minutes as minutes", () => {
    expect(staleAfterTextFor(5400)).toBe("90minutes");
  });

  it("renders a sub-minute remainder in seconds", () => {
    expect(staleAfterTextFor(135)).toBe("135seconds");
  });

  it("renders the default threshold as three run intervals in minutes", () => {
    expect(staleAfterTextFor(DEFAULT_STALE_AFTER_SECONDS)).toBe("90minutes");
  });
});
