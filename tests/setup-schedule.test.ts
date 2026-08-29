import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVAL_SECONDS,
  LAUNCHD_LABEL,
  launchdPlist,
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

describe("launchdPlist", () => {
  const plist = launchdPlist({
    nodePath: "/opt/node/bin/node",
    scriptPath: "/Users/me/Lab/k-wiki/bin/scheduled-run.ts",
    intervalSeconds: 1800,
    home: "/Users/me",
    logDir: "/Users/me/Library/Logs/k-wiki",
  });

  it("labels the job with the fixed launchd label", () => {
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });

  it("runs node against the scheduled-run script by absolute path", () => {
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain(
      "<string>/Users/me/Lab/k-wiki/bin/scheduled-run.ts</string>",
    );
  });

  it("sets StartInterval to the interval in seconds", () => {
    expect(plist).toContain(`<integer>${1800}</integer>`);
  });

  it("sets an explicit HOME so a clean launchd env resolves ~ paths", () => {
    expect(plist).toContain("<string>/Users/me</string>");
  });

  it("sets a minimal PATH — the wrapper builds the rest", () => {
    expect(plist).toContain("<string>/usr/bin:/bin:/usr/sbin:/sbin</string>");
  });

  it("redirects launchd-level output into the log dir", () => {
    expect(plist).toContain(
      "<string>/Users/me/Library/Logs/k-wiki/launchd-stdout.log</string>",
    );
    expect(plist).toContain(
      "<string>/Users/me/Library/Logs/k-wiki/launchd-stderr.log</string>",
    );
  });

  it("runs once at load so a boot or wake catch-up is deterministic", () => {
    expect(plist).toContain("<key>RunAtLoad</key>");
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
  it("points linux at the systemd follow-up", () => {
    const message = schedulerUnsupportedError("linux");

    expect(message).toContain("linux");
    expect(message).toContain("systemd");
  });

  it("points win32 at the Task Scheduler follow-up", () => {
    const message = schedulerUnsupportedError("win32");

    expect(message).toContain("win32");
    expect(message).toContain("Task Scheduler");
  });
});
