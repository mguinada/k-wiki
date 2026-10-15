import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSettings } from "../../src/ingest/agent-settings.ts";
import {
  DEFAULT_CYCLE_ESTIMATE_SECONDS,
  QUOTA_PROBE_TIMEOUT_MS,
  quotaPreflight,
  quotaPreflightUnavailable,
  stripSnapshotEnvironment,
} from "../../src/schedule/quota-preflight.ts";

const FIXTURES = join("tests", "fixtures", "quota-axi");

const settings = (extra = "") =>
  parseSettings(
    `command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n${extra}`,
    "settings.yml",
  );

const readFixture = (name: string) => readFile(join(FIXTURES, name), "utf8");

/** A command runner backed by a sanitized v5 fixture file
 *  (issue #463 §1c): the real pre-flight executes against the
 *  capture. */
const fixtureRunner = (name: string) => async () => readFixture(name);

/** Run the real pre-flight with one fixture-named file. */
const probeFixture = (name: string, extra = "") =>
  quotaPreflight({
    settings: settings(extra),
    log: () => {},
    commandRunner: fixtureRunner(name),
  });

/** Build a v5 report for zai whose all_models scope carries one
 *  runway — the minimal faithful nested shape. */
const zaiV5Report = (runway: unknown, windows: unknown[] = []) =>
  JSON.stringify({
    schemaVersion: 5,
    providers: [
      {
        provider: "zai",
        state: { status: "fresh", stale: false },
        windows,
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [
            { scope: "all_models", status: "known", runway },
          ],
        },
      },
    ],
  });

const projectiveRunway = (seconds: number) => ({
  status: "projected_exhaustion",
  usableRunwaySeconds: seconds,
  limitingWindowId: "five_hour",
});

const REQUIRED = DEFAULT_CYCLE_ESTIMATE_SECONDS + 5 * 60;

const probeRunway = (runway: unknown, extra = "") =>
  quotaPreflight({
    settings: settings(extra),
    log: () => {},
    commandRunner: async () => zaiV5Report(runway),
  });

describe("quotaPreflight v5 decisions", () => {
  it("skips an exhausted provider in a faithful v5 capture", async () => {
    const result = await probeFixture("v5-provider-exhausted.json");

    expect(result).toEqual({
      status: "skip",
      reason:
        "quota — ingest provider zai scope all_models (model GLM-5.2) exhausted_now, reset 2026-10-15T00:58:42.000Z",
    });
  });

  it("proceeds from a sufficient v5 capture", async () => {
    const result = await probeFixture("v5-provider-sufficient.json");

    expect(result).toEqual({ status: "proceed" });
  });

  it("skips on the exact model scope while the aggregate is unknown", async () => {
    const result = await probeFixture(
      "v5-model-scope-exhausted-aggregate-unknown.json",
    );

    expect(result.status).toBe("skip");
  });

  it("names the deciding scope as the exact model", async () => {
    const result = await probeFixture(
      "v5-model-scope-exhausted-aggregate-unknown.json",
    );

    expect((result as { reason?: string }).reason).toContain(
      "scope model:GLM-5.2",
    );
  });
});

describe("quotaPreflight runway boundaries", () => {
  it("proceeds at exactly the required runway (35m default)", async () => {
    const result = await probeRunway(projectiveRunway(REQUIRED));

    expect(result).toEqual({ status: "proceed" });
  });

  it("skips one second below the required runway (35m default)", async () => {
    const result = await probeRunway(projectiveRunway(REQUIRED - 1));

    expect(result.status).toBe("skip");
  });

  it("proceeds at exactly the required runway with a 10m buffer", async () => {
    const result = await probeRunway(
      projectiveRunway(DEFAULT_CYCLE_ESTIMATE_SECONDS + 10 * 60),
      "quotaPreflightBuffer: 10m\n",
    );

    expect(result).toEqual({ status: "proceed" });
  });

  it("skips below the required runway with a 10m buffer", async () => {
    const result = await probeRunway(
      projectiveRunway(DEFAULT_CYCLE_ESTIMATE_SECONDS + 10 * 60 - 1),
      "quotaPreflightBuffer: 10m\n",
    );

    expect(result.status).toBe("skip");
  });

  it("proceeds with a 0m buffer at exactly the cycle estimate", async () => {
    const result = await probeRunway(
      projectiveRunway(DEFAULT_CYCLE_ESTIMATE_SECONDS),
      "quotaPreflightBuffer: 0m\n",
    );

    expect(result).toEqual({ status: "proceed" });
  });

  it("proceeds straight through a whole-window through_reset runway", async () => {
    const result = await probeRunway({ status: "through_reset" });

    expect(result).toEqual({ status: "proceed" });
  });

  it("never lets percentages or pace decide a skip", async () => {
    const result = await probeRunway({
      status: "through_reset",
      usableRunwaySeconds: REQUIRED,
      pace: { status: "ahead", reservePercentPoints: -99.9, burnMultiple: 42 },
      effectivePercentRemaining: 0,
    });

    expect(result).toEqual({ status: "proceed" });
  });
});

describe("quotaPreflight reset labels", () => {
  it("labels a skip with the limiting window's actual resetsAt", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings(),
      log: (line) => lines.push(line),
      commandRunner: async () =>
        zaiV5Report(
          {
            ...projectiveRunway(10),
            projectedExhaustedAt: "2026-10-14T19:30:00.000Z",
          },
          [{ id: "five_hour", resetsAt: "2026-10-15T00:58:42.000Z" }],
        ),
    });

    expect({
      skip: result.status,
      named: lines[0]?.includes("reset 2026-10-15T00:58:42.000Z"),
      projected: lines.some((line) =>
        line.includes("2026-10-14T19:30:00.000Z"),
      ),
    }).toEqual({ skip: "skip", named: true, projected: false });
  });

  it("names unknown reset when the limiting window metadata is unusable", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings(),
      log: (line) => lines.push(line),
      commandRunner: async () =>
        zaiV5Report({ status: "exhausted_now", limitingWindowId: "ghost" }),
    });

    expect({
      skip: result.status,
      unknown: lines[0]?.includes("reset unknown"),
    }).toEqual({ skip: "skip", unknown: true });
  });
});

describe("quotaPreflight probe handling", () => {
  it("allows an unreadable optional probe", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async () => "not json",
    });

    expect(result).toEqual({ status: "proceed", preflight: "unavailable" });
  });

  it("emits the dim unavailable line for an unreadable probe", async () => {
    const lines: string[] = [];
    await quotaPreflight({
      settings: settings(),
      log: (line) => lines.push(line),
      commandRunner: async () => "not json",
    });

    expect(lines[0]).toBe(
      "scheduled-run: quota pre-flight unavailable — proceeding",
    );
  });

  it("allows a probe runner that times out or fails", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async () => {
        throw new Error("etimedout");
      },
    });

    expect(result).toEqual({ status: "proceed", preflight: "unavailable" });
  });

  it("allows the explicit off mode without probing", async () => {
    let called = false;
    const result = await quotaPreflight({
      settings: settings("quotaPreflight: off\n"),
      log: () => {},
      commandRunner: async () => {
        called = true;

        return "{}";
      },
    });

    expect({ called, result }).toEqual({
      called: false,
      result: { status: "proceed", preflight: "off" },
    });
  });

  it("treats settings without a provider as nothing to probe", async () => {
    let called = false;
    const result = await quotaPreflight({
      settings: parseSettings(
        "command: pi\nmodel: GLM-5.2\nreasoning: high\n",
        "settings.yml",
      ),
      log: () => {},
      commandRunner: async () => {
        called = true;

        return "{}";
      },
    });

    expect({ called, result }).toEqual({
      called: false,
      result: { status: "proceed", preflight: "no-provider" },
    });
  });

  it("maps an openai-codex first target to the codex quota provider", async () => {
    const configured = parseSettings(
      "command: pi\ntargets: [openai-codex/gpt-5.6-terra, zai/GLM-5.2]\nreasoning: high\n",
      "settings.yml",
    );
    const result = await quotaPreflight({
      settings: configured,
      log: () => {},
      commandRunner: async () => {
        return JSON.stringify({
          schemaVersion: 5,
          providers: [
            {
              provider: "codex",
              state: { status: "fresh", stale: false },
              windows: [],
              quotaSemantics: {
                status: "known",
                effectiveAvailability: [
                  {
                    scope: "model:gpt-5.6-terra",
                    status: "known",
                    runway: { status: "exhausted_now" },
                  },
                ],
              },
            },
          ],
        });
      },
    });

    expect(result.status).toBe("skip");
  });

  it("maps the codex runner's bare model targets to codex quota", async () => {
    const configured = parseSettings(
      "command: pi\nagent: codex\nmodel: gpt-5.6-terra\nreasoning: high\n",
      "settings.yml",
    );
    const result = await quotaPreflight({
      settings: configured,
      log: () => {},
      commandRunner: async () => {
        return JSON.stringify({
          schemaVersion: 5,
          providers: [
            {
              provider: "codex",
              state: { status: "fresh", stale: false },
              windows: [],
              quotaSemantics: {
                status: "known",
                effectiveAvailability: [
                  {
                    scope: "all_models",
                    status: "known",
                    runway: { status: "exhausted_now" },
                  },
                ],
              },
            },
          ],
        });
      },
    });

    expect(result.status).toBe("skip");
  });

  it("keeps a named timeout far above one observed probe", () => {
    expect(QUOTA_PROBE_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it("keeps the escape-hatch line for callers short-circuiting the gate", () => {
    const lines: string[] = [];
    const result = quotaPreflightUnavailable((line) => lines.push(line));

    expect({ result, line: lines[0] }).toEqual({
      result: { status: "proceed", preflight: "unavailable" },
      line: "scheduled-run: quota pre-flight unavailable — proceeding",
    });
  });
});

describe("quotaPreflight environment isolation", () => {
  const envSpy: { last?: NodeJS.ProcessEnv | undefined } = {};

  it("removes inherited snapshot and cache controls from the child env", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async (_command, env) => {
        envSpy.last = { ...env };

        return readFixture("v5-provider-exhausted.json");
      },
      env: {
        PATH: "/usr/bin",
        QUOTA_AXI_MAX_AGE: "600",
        QUOTA_AXI_SNAPSHOT: "/tmp/snapshot.json",
      },
    });

    expect({
      status: result.status,
      maxAge: envSpy.last?.QUOTA_AXI_MAX_AGE,
      snapshot: envSpy.last?.QUOTA_AXI_SNAPSHOT,
      path: envSpy.last?.PATH,
    }).toEqual({
      status: "skip",
      maxAge: undefined,
      snapshot: undefined,
      path: "/usr/bin",
    });
  });

  it("strips only the two control keys", () => {
    const clean = stripSnapshotEnvironment({
      HOME: "/home",
      QUOTA_AXI_MAX_AGE: "600",
      QUOTA_AXI_SNAPSHOT: "/tmp/snap",
      PATH: "/usr/bin",
    });

    expect(clean).toEqual({ HOME: "/home", PATH: "/usr/bin" });
  });
});

describe("quotaPreflight buffer warnings", () => {
  const sufficientRunway = () =>
    projectiveRunway(DEFAULT_CYCLE_ESTIMATE_SECONDS + 300);

  it("warns on a malformed buffer and still reads fresh evidence", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings('quotaPreflightBuffer: "35m extra"\n'),
      log: (line) => lines.push(line),
      commandRunner: async () => zaiV5Report(sufficientRunway()),
    });

    expect({
      status: result.status,
      warned: lines[0]?.includes("WARNING"),
    }).toEqual({
      status: "proceed",
      warned: true,
    });
  });

  it("names the rejected input, the rule, and the fallback in the warning", async () => {
    const lines: string[] = [];
    await quotaPreflight({
      settings: settings('quotaPreflightBuffer: "35m extra"\n'),
      log: (line) => lines.push(line),
      commandRunner: async () => zaiV5Report(sufficientRunway()),
    });

    const warning = lines[0] ?? "";

    expect([
      warning.includes("quotaPreflightBuffer"),
      warning.includes("whole-minute"),
      warning.includes("5m fallback"),
      warning.includes('"35m extra"'),
    ]).toEqual([true, true, true, true]);
  });

  it("bounds the rejected input rendering", async () => {
    const lines: string[] = [];
    const rejected = `35m ${"\u0007".repeat(90)}`;

    await quotaPreflight({
      settings: settings(`quotaPreflightBuffer: ${rejected}\n`),
      log: (line) => lines.push(line),
      commandRunner: async () => zaiV5Report(sufficientRunway()),
    });

    expect(lines[0]).toBe(
      `scheduled-run: WARNING — quotaPreflightBuffer ${JSON.stringify(`35m ${"?".repeat(73)}...`)}: only non-negative whole-minute values are supported; using the 5m fallback`,
    );
  });

  it("warns on an unsupported unit (hours) and uses 5m", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings("quotaPreflightBuffer: 5h\n"),
      log: (line) => lines.push(line),
      commandRunner: async () => zaiV5Report(sufficientRunway()),
    });

    expect({
      status: result.status,
      warned: lines[0]?.includes("WARNING"),
    }).toEqual({
      status: "proceed",
      warned: true,
    });
  });

  it("warns on a numeric overflow and uses 5m", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings("quotaPreflightBuffer: 99999999999999999999m\n"),
      log: (line) => lines.push(line),
      commandRunner: async () => "{}",
    });

    expect({ result, warned: lines[0]?.includes("WARNING") }).toEqual({
      result: { status: "proceed", preflight: "unsupported-schema" },
      warned: true,
    });
  });

  it("warns on a bare number and uses 5m", async () => {
    const lines: string[] = [];
    await quotaPreflight({
      settings: settings("quotaPreflightBuffer: 5\n"),
      log: (line) => lines.push(line),
      commandRunner: async () => zaiV5Report(sufficientRunway()),
    });

    expect(lines[0]).toContain("WARNING");
  });

  it("warns on a negative value and uses 5m", async () => {
    const lines: string[] = [];
    await quotaPreflight({
      settings: settings("quotaPreflightBuffer: -5m\n"),
      log: (line) => lines.push(line),
      commandRunner: async () => zaiV5Report(sufficientRunway()),
    });

    expect(lines[0]).toContain("WARNING");
  });

  it("does not warn or probe when quotaPreflight is off", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings("quotaPreflight: off\nquotaPreflightBuffer: bogus\n"),
      log: (line) => lines.push(line),
      commandRunner: async () => "{}",
    });

    expect({ result, lines }).toEqual({
      result: { status: "proceed", preflight: "off" },
      lines: [],
    });
  });
});
