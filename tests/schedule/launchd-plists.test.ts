import { describe, expect, it } from "vitest";
import {
  LAUNCHD_LABEL,
  launchdCalendarPlist,
  launchdPlist,
  launchdWatchdogPlist,
  WATCHDOG_LAUNCHD_LABEL,
} from "../../src/schedule/launchd-plists.ts";

/**
 * The launchd plist builders' tests (moved with the builders out of
 * setup-schedule.test.ts, issue #362): each generated plist is parsed
 * into a semantic model — tests assert meaning, not raw substrings.
 */

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
    scriptPath: "/Users/me/Lab/k-wiki/bin/scheduled-run",
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
      "/Users/me/Lab/k-wiki/bin/scheduled-run",
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
        scriptPath: "/Users/me&Lab/k-wiki/bin/scheduled-run",
        home: "/Users/me<home>",
        logDir: "/Users/me/Library&Logs/k-wiki",
        intervalSeconds: 1800,
      }),
    );

    expect(arrayOf(weird.ProgramArguments)).toEqual([
      "/opt/a<b>&c/node",
      "/Users/me&Lab/k-wiki/bin/scheduled-run",
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
describe("launchdWatchdogPlist (issue #362)", () => {
  const plist = parsePlistDict(
    launchdWatchdogPlist({
      nodePath: "/opt/node/bin/node",
      scriptPath: "/Users/me/Lab/k-wiki/bin/libexec/sync-watchdog",
      intervalSeconds: 3600,
      staleAfter: "90minutes",
      home: "/Users/me",
      logDir: "/Users/me/Library/Logs/k-wiki",
    }),
  );

  it("labels the job with the watchdog label", () => {
    expect(plist.Label).toBe(WATCHDOG_LAUNCHD_LABEL);
  });

  it("runs the watchdog door with the threshold in its arguments", () => {
    expect(arrayOf(plist.ProgramArguments)).toEqual([
      "/opt/node/bin/node",
      "/Users/me/Lab/k-wiki/bin/libexec/sync-watchdog",
      "--stale-after",
      "90minutes",
    ]);
  });

  it("sweeps hourly with RunAtLoad", () => {
    expect(plist.StartInterval).toBe(3600);
    expect(plist.RunAtLoad).toBe(true);
  });

  it("captures launchd output under the watchdog prefix", () => {
    expect(plist.StandardOutPath).toBe(
      "/Users/me/Library/Logs/k-wiki/launchd-watchdog-stdout.log",
    );
    expect(plist.StandardErrorPath).toBe(
      "/Users/me/Library/Logs/k-wiki/launchd-watchdog-stderr.log",
    );
  });
});

describe("launchdCalendarPlist", () => {
  const plist = parsePlistDict(
    launchdCalendarPlist({
      nodePath: "/opt/node/bin/node",
      scriptPath: "/Users/me/Lab/k-wiki/bin/scheduled-run",
      weekly: { weekday: 0, hour: 3, minute: 0 },
      home: "/Users/me",
      logDir: "/Users/me/Library/Logs/k-wiki",
    }),
  );

  it("triggers on the calendar fields with --lint-full", () => {
    expect(dictOf(plist.StartCalendarInterval)).toEqual({
      Weekday: 0,
      Hour: 3,
      Minute: 0,
    });
    expect(arrayOf(plist.ProgramArguments)).toEqual([
      "/opt/node/bin/node",
      "/Users/me/Lab/k-wiki/bin/scheduled-run",
      "--lint-full",
    ]);
  });
});
