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
import {
  DEFAULT_INTERVAL_SECONDS,
  LAUNCHD_LABEL,
  launchdPlist,
  main,
  parseCliArgs,
  parseIntervalDuration,
  plistPath,
  schedulerUnsupportedError,
  stableNodePath,
} from "../src/schedule/setup-schedule.ts";

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

  it.each(["15", "minutes", "abc", "0minutes", "-5minutes", "1.5hours", ""])(
    "rejects %s",
    (text) => {
      expect(parseIntervalDuration(text)).toBeUndefined();
    },
  );
});

/** The plist XML subset as a semantic value: dict → object, array →
 *  array, string → string, integer → number, true/false → boolean. */
type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { readonly [key: string]: PlistValue };

type PlistToken =
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "close"; readonly name: string }
  | { readonly kind: "text"; readonly text: string };

const PLIST_ELEMENTS = "dict|array|key|string|integer|true|false|plist";

/** Decode the entities the generator escapes, so parsed values are
 *  the semantic paths — not the escaped serialization. */
function decodeXmlEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function tokenizePlist(source: string): readonly PlistToken[] {
  const pattern = new RegExp(
    `<!DOCTYPE[^>]*>|<\\?[^?]*\\?>|<(/?)(${PLIST_ELEMENTS})([^>]*)>|([^<]+)`,
    "g",
  );
  const tokens: PlistToken[] = [];
  let match: RegExpExecArray | null = pattern.exec(source);

  while (match !== null) {
    if (match[2] !== undefined) {
      tokens.push({
        kind: match[1] === "/" ? "close" : "open",
        name: match[2],
      });

      if (match[1] !== "/" && match[3]?.endsWith("/")) {
        tokens.push({ kind: "close", name: match[2] });
      }
    } else if (match[4] !== undefined && match[4].trim() !== "") {
      tokens.push({ kind: "text", text: decodeXmlEntities(match[4]) });
    }

    match = pattern.exec(source);
  }

  return tokens;
}

function expectClose(
  tokens: readonly PlistToken[],
  cursor: { index: number },
  name: string,
): void {
  const token = tokens[cursor.index];
  cursor.index += 1;

  if (token?.kind !== "close" || token.name !== name) {
    throw new Error(`expected </${name}>, got ${JSON.stringify(token)}`);
  }
}

function readKey(
  tokens: readonly PlistToken[],
  cursor: { index: number },
): string {
  const [open, text, close] = [
    tokens[cursor.index],
    tokens[cursor.index + 1],
    tokens[cursor.index + 2],
  ];
  cursor.index += 3;

  if (
    open?.kind !== "open" ||
    open.name !== "key" ||
    text?.kind !== "text" ||
    close?.kind !== "close" ||
    close.name !== "key"
  ) {
    throw new Error("dict entry does not start with a <key>…</key>");
  }

  return text.text;
}

function parsePlistValue(
  tokens: readonly PlistToken[],
  cursor: { index: number },
): PlistValue {
  const token = tokens[cursor.index];
  cursor.index += 1;

  if (token?.kind !== "open") {
    throw new Error(
      `expected an opening element, got ${JSON.stringify(token)}`,
    );
  }

  if (token.name === "string" || token.name === "integer") {
    const text = tokens[cursor.index];

    if (text?.kind !== "text") {
      throw new Error(`<${token.name}> without text`);
    }

    cursor.index += 1;
    expectClose(tokens, cursor, token.name);

    return token.name === "string" ? text.text : Number(text.text);
  }

  if (token.name === "true" || token.name === "false") {
    expectClose(tokens, cursor, token.name);

    return token.name === "true";
  }

  if (token.name === "array") {
    const items: PlistValue[] = [];

    while (tokens[cursor.index]?.kind === "open") {
      items.push(parsePlistValue(tokens, cursor));
    }

    expectClose(tokens, cursor, "array");

    return items;
  }

  if (token.name === "plist") {
    const inner = parsePlistValue(tokens, cursor);
    expectClose(tokens, cursor, "plist");

    return inner;
  }

  if (token.name === "dict") {
    const dict: Record<string, PlistValue> = {};

    while (tokens[cursor.index]?.kind === "open") {
      const key = readKey(tokens, cursor);
      dict[key] = parsePlistValue(tokens, cursor);
    }

    expectClose(tokens, cursor, "dict");

    return dict;
  }

  throw new Error(`unsupported element <${token.name}>`);
}

/** Parse a generated plist into its semantic key→value model — tests
 *  assert meaning, not raw substrings. */
function parsePlistDict(source: string): Record<string, PlistValue> {
  const value = parsePlistValue(tokenizePlist(source), { index: 0 });

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plist root is not a dict");
  }

  return value;
}

function dictOf(value: PlistValue | undefined): Record<string, PlistValue> {
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected a dict, got ${JSON.stringify(value)}`);
  }

  return value;
}

function arrayOf(value: PlistValue | undefined): readonly PlistValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, got ${JSON.stringify(value)}`);
  }

  return value;
}

describe("launchdPlist", () => {
  const base = {
    nodePath: "/opt/node/bin/node",
    scriptPath: "/Users/me/Lab/k-wiki/bin/scheduled-run.ts",
    home: "/Users/me",
    logDir: "/Users/me/Library/Logs/k-wiki",
  } as const;
  const plist = parsePlistDict(
    launchdPlist({ ...base, intervalSeconds: 1800 }),
  );

  it("labels the job with the fixed launchd label", () => {
    expect(plist.Label).toBe(LAUNCHD_LABEL);
  });

  it("runs node against the scheduled-run script by absolute path, in order", () => {
    expect(arrayOf(plist.ProgramArguments)).toEqual([
      "/opt/node/bin/node",
      "/Users/me/Lab/k-wiki/bin/scheduled-run.ts",
    ]);
  });

  it("sets StartInterval to the interval in seconds", () => {
    expect(plist.StartInterval).toBe(1800);
  });

  it("binds StartInterval to the given interval, not the default", () => {
    const other = parsePlistDict(
      launchdPlist({ ...base, intervalSeconds: 900 }),
    );

    expect(other.StartInterval).toBe(900);
  });

  it("runs once at load so a boot or wake catch-up is deterministic", () => {
    expect(plist.RunAtLoad).toBe(true);
  });

  it("sets an explicit HOME so a clean launchd env resolves ~ paths", () => {
    expect(dictOf(plist.EnvironmentVariables).HOME).toBe("/Users/me");
  });

  it("sets a minimal PATH — the wrapper builds the rest", () => {
    expect(dictOf(plist.EnvironmentVariables).PATH).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("redirects launchd stdout into the log dir", () => {
    expect(plist.StandardOutPath).toBe(
      "/Users/me/Library/Logs/k-wiki/launchd-stdout.log",
    );
  });

  it("redirects launchd stderr into the log dir", () => {
    expect(plist.StandardErrorPath).toBe(
      "/Users/me/Library/Logs/k-wiki/launchd-stderr.log",
    );
  });

  it("escapes XML-significant characters in the interpolated paths", () => {
    const weird = parsePlistDict(
      launchdPlist({
        nodePath: "/opt/a<b>&c/node",
        scriptPath: "/Users/me&Lab/k-wiki/bin/scheduled-run.ts",
        home: "/Users/me<home>",
        logDir: "/Users/me/Library&Logs/k-wiki",
        intervalSeconds: 1800,
      }),
    );

    expect(arrayOf(weird.ProgramArguments)).toEqual([
      "/opt/a<b>&c/node",
      "/Users/me&Lab/k-wiki/bin/scheduled-run.ts",
    ]);
    expect(dictOf(weird.EnvironmentVariables).HOME).toBe("/Users/me<home>");
    expect(weird.StandardOutPath).toBe(
      "/Users/me/Library&Logs/k-wiki/launchd-stdout.log",
    );
    expect(weird.StandardErrorPath).toBe(
      "/Users/me/Library&Logs/k-wiki/launchd-stderr.log",
    );
  });
});

describe("parseCliArgs", () => {
  it("rejects an unknown option instead of silently using defaults", () => {
    const parsed = parseCliArgs(["--inteval", "15minutes"]);

    expect(parsed.error).toContain("unknown option");
  });

  it("rejects a positional argument", () => {
    const parsed = parseCliArgs(["15minutes"]);

    expect(parsed.error).toContain("unexpected argument");
  });

  it("rejects --interval without a value", () => {
    const parsed = parseCliArgs(["--interval"]);

    expect(parsed.error).toContain("needs a duration value");
  });

  it("rejects an invalid --interval value", () => {
    const parsed = parseCliArgs(["--interval", "soon"]);

    expect(parsed.error).toContain("invalid --interval value");
  });

  it("reads --interval 15minutes", () => {
    const parsed = parseCliArgs(["--interval", "15minutes"]);

    expect(parsed.interval).toBe(900);
  });

  it("defaults the interval to the agreed 30 minutes", () => {
    const parsed = parseCliArgs(["--print"]);

    expect(parsed.interval).toBe(DEFAULT_INTERVAL_SECONDS);
  });

  it("reads --print", () => {
    const parsed = parseCliArgs(["--print"]);

    expect(parsed.print).toBe(true);
  });

  it("reads --uninstall", () => {
    const parsed = parseCliArgs(["--uninstall"]);

    expect(parsed.uninstall).toBe(true);
  });

  it("errors on nothing when only the known flags are passed", () => {
    const parsed = parseCliArgs([
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
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

    await symlink(process.execPath, nodeSymlink);

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(nodeSymlink, [
        join(repoRoot, "bin", "setup-schedule.ts"),
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
      "0|Usage: setup-schedule [-h | --help] [--interval <duration>] [--print] [--uninstall]",
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
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(outs.join("\n")).toContain("uninstalled");

    await rm(home, { recursive: true, force: true });
  });
});
