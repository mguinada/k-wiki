import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let help: string;

beforeAll(() => {
  help = execFileSync(
    process.execPath,
    [join(repoRoot, "bin", "setup-schedule"), "--help"],
    { encoding: "utf8" },
  );
});

describe("setup-schedule help (printed by the launcher)", () => {
  it("documents the three independent registrations", () => {
    expect(help).toContain("Three independent");
  });

  it("documents the watchdog staleness threshold switch", () => {
    expect(help).toContain("--stale-after <duration>");
  });

  it("documents the --print exemption from the origin guard", () => {
    expect(help).toContain("--print is exempt");
  });

  it("documents the agent-resolution step of the scheduled pipeline", () => {
    expect(help).toContain("agent resolution");
  });
});
