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
      tokens.push({ kind: "text", text: match[4] });
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
