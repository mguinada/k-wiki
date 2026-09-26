import { describe, expect, it } from "vitest";
import { parseSettings } from "../../src/ingest/agent-settings.ts";
import {
  DEFAULT_CYCLE_ESTIMATE_SECONDS,
  quotaPreflight,
} from "../../src/schedule/quota-preflight.ts";

const settings = (extra = "") =>
  parseSettings(
    `command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n${extra}`,
    "settings.yml",
  );

describe("quotaPreflight", () => {
  it("skips an exhausted configured provider", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings(),
      log: (line) => lines.push(line),
      commandRunner: async () =>
        JSON.stringify({
          quota: [
            { provider: "zai", scope: "all_models", runway: "exhausted_now" },
          ],
          exhaustion: [
            {
              provider: "zai",
              usableRunwaySeconds: 0,
              projectedExhaustedAt: "2026-09-26T05:00:00.000Z",
            },
          ],
        }),
    });

    expect({ status: result.status, line: lines[0] }).toEqual({
      status: "skip",
      line: expect.stringContaining("zai"),
    });
  });

  it("allows a provider with through-reset runway", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async () =>
        JSON.stringify({
          quota: [
            { provider: "zai", scope: "all_models", runway: "through_reset" },
          ],
          exhaustion: [],
        }),
    });

    expect(result).toEqual({ status: "proceed" });
  });

  it("allows an unreadable optional probe", async () => {
    const lines: string[] = [];
    const result = await quotaPreflight({
      settings: settings(),
      log: (line) => lines.push(line),
      commandRunner: async () => "not json",
    });

    expect({ status: result.status, lines }).toEqual({
      status: "proceed",
      lines: ["scheduled-run: quota pre-flight unavailable — proceeding"],
    });
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
      result: { status: "proceed" },
    });
  });

  it("uses the conservative cycle estimate for finite runway", async () => {
    const result = await quotaPreflight({
      settings: settings(),
      log: () => {},
      commandRunner: async () =>
        JSON.stringify({
          quota: [
            {
              provider: "zai",
              scope: "all_models",
              runway: "projected_exhaustion",
            },
          ],
          exhaustion: [
            {
              provider: "zai",
              usableRunwaySeconds: DEFAULT_CYCLE_ESTIMATE_SECONDS - 1,
              projectedExhaustedAt: "2026-09-26T05:00:00.000Z",
            },
          ],
        }),
    });

    expect(result.status).toBe("skip");
  });
});
