import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSettings } from "../../src/ingest/agent-settings.ts";
import {
  DEFAULT_CYCLE_ESTIMATE_SECONDS,
  quotaPreflight,
} from "../../src/schedule/quota-preflight.ts";
import {
  decideQuotaReport,
  parseQuotaPreflightBuffer,
} from "../../src/schedule/quota-schema-v5.ts";

const FIXTURES = join("tests", "fixtures", "quota-axi");

const settings = (extra = "") =>
  parseSettings(
    `command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n${extra}`,
    "settings.yml",
  );

const readFixture = (name: string) => readFile(join(FIXTURES, name), "utf8");

/** The real pre-flight executing against one sanitized v5 capture —
 *  the same facade call the scheduler wires (issue #463 §1c); the
 *  normalizer's decision shape is what this file pins. */
const probeFixture = (name: string) =>
  quotaPreflight({
    settings: settings(),
    log: () => {},
    commandRunner: async () => readFixture(name),
  });

const REQUIRED = DEFAULT_CYCLE_ESTIMATE_SECONDS + 5 * 60;

describe("quota-schema-v5 authority gates", () => {
  it("fails open on an unsupported higher schema (v6)", async () => {
    const result = await probeFixture("v5-unsupported-schema-v6.json");

    expect(result).toEqual({
      status: "proceed",
      preflight: "unsupported-schema",
    });
  });

  it("fails open without quoting the payload on an unsupported schema", async () => {
    const lines: string[] = [];
    await quotaPreflight({
      settings: settings(),
      log: (line) => lines.push(line),
      commandRunner: async () => readFixture("v5-unsupported-schema-v6.json"),
    });

    expect({
      unsupported: lines[0]?.includes("unsupported schema"),
      raw: lines.some((line) => line.includes('"providers"')),
    }).toEqual({
      unsupported: true,
      raw: false,
    });
  });

  it("fails open on a lower schema version", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async () =>
        JSON.stringify({ schemaVersion: 4, providers: [] }),
    });

    expect(result).toEqual({
      status: "proceed",
      preflight: "unsupported-schema",
    });
  });

  it("fails open when the supported schema names no provider record", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async () =>
        JSON.stringify({ schemaVersion: 5, providers: [] }),
    });

    expect(result).toEqual({ status: "proceed", preflight: "unavailable" });
  });

  it("fails open on unauthenticated provider state", async () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: false, authStatus: "unusable" },
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
    };

    expect(decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED)).toEqual({
      kind: "unavailable",
      cause: "unavailable",
    });
  });

  it("fails open on stale provider state", async () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: true },
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
    };

    expect(decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED)).toEqual({
      kind: "unavailable",
      cause: "unavailable",
    });
  });

  it("fails open on named unmeasurable (unknown) runway", async () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: false },
          windows: [],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_models",
                status: "known",
                runway: { status: "unknown", unmeasurableWindowIds: ["w"] },
              },
            ],
          },
        },
      ],
    };

    expect(decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED)).toEqual({
      kind: "unavailable",
      cause: "unavailable",
    });
  });

  it("fails open when no model-relevant scope matches (all_products)", async () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: false },
          windows: [],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_products",
                status: "known",
                runway: { status: "exhausted_now" },
              },
            ],
          },
        },
      ],
    };

    expect(decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED)).toEqual({
      kind: "unavailable",
      cause: "unavailable",
    });
  });

  it("ignores percentages and pace in every decision", async () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: false },
          windows: [],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_models",
                status: "known",
                effectivePercentRemaining: 0,
                pace: { status: "ahead", burnMultiple: 99 },
                runway: { status: "through_reset" },
              },
            ],
          },
        },
      ],
    };

    expect(decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED)).toEqual({
      kind: "proceed",
    });
  });

  it("never decides from an unrecognized field alone", async () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: false },
          windows: [],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_models",
                status: "known",
                runway: { status: "through_reset" },
              },
            ],
          },
          unmodeledExtras: { exhausted: true },
        },
      ],
    };

    expect(decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED)).toEqual({
      kind: "proceed",
    });
  });
});

describe("skip reason reset label", () => {
  it("renders a hostile resetsAt bounded and sanitized in the skip reason", () => {
    const report = {
      schemaVersion: 5,
      providers: [
        {
          provider: "zai",
          state: { status: "fresh", stale: false },
          windows: [
            {
              id: "five_hour",
              resetsAt: `2026-10-15T00:58:42.000Z\nALERT — forged line ${"x".repeat(200)}`,
            },
          ],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_models",
                status: "known",
                runway: {
                  status: "exhausted_now",
                  limitingWindowId: "five_hour",
                },
              },
            ],
          },
        },
      ],
    };
    const decision = decideQuotaReport(report, "zai", "GLM-5.2", REQUIRED);
    const reason = decision.kind === "skip" ? decision.reason : "";

    expect({
      skip: decision.kind,
      provider: reason.includes("ingest provider zai"),
      singleLine: !reason.includes("\n"),
      controlReplaced: reason.includes("?"),
      rawEchoGone: !reason.includes("x".repeat(50)),
    }).toEqual({
      skip: "skip",
      provider: true,
      singleLine: true,
      controlReplaced: true,
      rawEchoGone: true,
    });
  });
});

describe("parseQuotaPreflightBuffer", () => {
  it("accepts zero minutes", () => {
    expect(parseQuotaPreflightBuffer("0m")).toEqual({
      seconds: 0,
      warnings: [],
    });
  });

  it("never reinterprets a bare number as minutes", () => {
    const parsed = parseQuotaPreflightBuffer("5");

    expect({
      seconds: parsed.seconds,
      warnings: parsed.warnings.length,
    }).toEqual({
      seconds: 300,
      warnings: 1,
    });
  });

  it("uses 5m when the key is absent", () => {
    expect(parseQuotaPreflightBuffer(undefined)).toEqual({
      seconds: 300,
      warnings: [],
    });
  });

  it("keeps the fallback body worded for the shared renderer", () => {
    const parsed = parseQuotaPreflightBuffer("nope");

    expect(parsed.warnings[0]).toContain(
      "only non-negative whole-minute values are supported",
    );
  });
});
