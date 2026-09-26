import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let help: string;

beforeAll(() => {
  help = execFileSync(
    process.execPath,
    [join(repoRoot, "bin", "libexec", "sync-watchdog"), "--help"],
    { encoding: "utf8" },
  );
});

describe("sync-watchdog help (printed by the launcher)", () => {
  /** The help text with wrapping normalized away, so phrase
   *  assertions are about wording, not line breaks. */
  const text = () => help.replace(/\s+/g, " ");

  it("documents the staleness threshold override with its default", () => {
    expect(text()).toContain("--stale-after <duration>");
    expect(text()).toContain("the default: three 30-minute run intervals");
  });

  it("documents that a quota-skipped stamp is benign while ticks arrive", () => {
    expect(text()).toContain(
      "quota-skipped stamp is benign while its ticks keep arriving",
    );
  });

  it("documents the persistent-skip alert naming the cause", () => {
    expect(text()).toContain(
      "the last successful cycle ages past the threshold the watchdog alerts naming that cause",
    );
  });

  it("documents the never-succeeded alert", () => {
    expect(text()).toContain("no successful cycle on record");
  });

  it("documents that a dead scheduler is not masked by benign skips", () => {
    expect(text()).toContain("a scheduler that died — alerts like any other");
  });

  it("documents the dormant pre-flight note", () => {
    expect(text()).toContain('"pre-flight: off" note');
  });

  it("states that it writes nothing", () => {
    expect(text()).toContain("writes nothing");
  });
});
