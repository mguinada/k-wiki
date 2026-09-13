import { describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers.ts";

/**
 * setup-schedule e2e: the plist emitters as real child processes.
 * Only `--print` runs here — install and uninstall touch the
 * operator's launchd state and stay unit-tested against an injected
 * launcher and a temp home. The interval plist pins the registration
 * the schedule has always had; the calendar plist (issue #359) pins
 * the weekly full-lint sweep's label, trigger, and --lint-full
 * argument.
 */

const SETUP_SCRIPT = `${repoRoot}/bin/setup-schedule`;

describe("setup-schedule e2e", () => {
  it("prints the interval plist with the label and the node invocation", async () => {
    const result = await runCli(SETUP_SCRIPT, ["--print"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("com.kwiki.scheduled-run");
    expect(result.out).toContain("<key>StartInterval</key>");
    expect(result.out).toContain("<integer>1800</integer>");
    expect(result.out).not.toContain("--lint-full");
    expect(result.err).toBe("");
  });

  it("prints the weekly sweep plist with a calendar trigger and --lint-full", async () => {
    const result = await runCli(SETUP_SCRIPT, ["--calendar", "--print"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("com.kwiki.scheduled-lint");
    expect(result.out).toContain("<key>StartCalendarInterval</key>");
    expect(result.out).toContain("<integer>0</integer>");
    expect(result.out).toContain("<integer>3</integer>");
    expect(result.out).toContain("<string>--lint-full</string>");
    expect(result.err).toBe("");
  });

  it("honors --weekly-at in the calendar plist", async () => {
    const result = await runCli(SETUP_SCRIPT, [
      "--calendar",
      "--weekly-at",
      "sat-04:30",
      "--print",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("<integer>6</integer>");
    expect(result.out).toContain("<integer>4</integer>");
    expect(result.out).toContain("<integer>30</integer>");
  });

  it("rejects --weekly-at without --calendar", async () => {
    const result = await runCli(SETUP_SCRIPT, ["--weekly-at", "sun-03:00"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--weekly-at needs --calendar");
  });
});
