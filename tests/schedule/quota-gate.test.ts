/**
 * The direct-run quota gate (issue #463 §5): the manual-confirmation
 * UI in front of the schedule-domain decision core. Direct
 * `wiki-sync` runs it before any lock, lease, stage, write, or
 * publish; a scheduled child never reaches it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSettings } from "../../src/ingest/agent-settings.ts";
import {
  directQuotaGate,
  type DirectQuotaGateInput,
  terminalConfirm,
} from "../../src/schedule/quota-gate.ts";

/** The first-target low-quota payload (issue #463 §5): a faithful
 *  v5 capture from the sanitized fixture set — zai exhausted now,
 *  limiting window five_hour. */
const FIXTURE_DIR = join("tests", "fixtures", "quota-axi");

const LOW_QUOTA_PAYLOAD = await readFile(
  join(FIXTURE_DIR, "v5-provider-exhausted.json"),
  "utf8",
);

/** Agent settings naming the first ingest target the gate judges. */
const TARGET_SETTINGS = parseSettings(
  "command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n",
  "settings.yml",
);

describe("directQuotaGate (issue #463 manual confirmation)", () => {
  const gateInput = (
    overrides: Partial<
      Omit<DirectQuotaGateInput, "settings"> & {
        readonly settings: ReturnType<typeof parseSettings>;
      }
    > = {},
  ) => {
    const messages: string[] = [];

    return directQuotaGate({
      noQuotaCheck: overrides.noQuotaCheck ?? false,
      interactive: overrides.interactive ?? false,
      confirm: overrides.confirm ?? (async () => false),
      commandRunner: overrides.commandRunner ?? (async () => LOW_QUOTA_PAYLOAD),
      settings: overrides.settings ?? TARGET_SETTINGS,
      onProgress: (message) => messages.push(message),
    }).then((outcome) => ({ outcome, messages }));
  };

  it("declines a non-terminal low-quota run before anything starts", async () => {
    const confirm = vi.fn(async () => false);
    const { outcome } = await gateInput({ confirm });

    expect(outcome).toBe("declined");
  });

  it("never prompts a non-terminal run", async () => {
    const confirm = vi.fn(async () => false);
    await gateInput({ confirm });

    expect(confirm.mock.calls.length).toBe(0);
  });

  it("warns low quota with the first-target evidence", async () => {
    const { messages } = await gateInput({
      commandRunner: async () => LOW_QUOTA_PAYLOAD,
    });

    expect(messages[0]).toContain("WARNING — low quota");
  });

  it("names provider, scope, and the actual reset in the warning", async () => {
    const { messages } = await gateInput({
      commandRunner: async () => LOW_QUOTA_PAYLOAD,
    });

    expect(messages[0]).toContain("ingest provider zai scope all_models");
  });

  it("names the limiting window's resetsAt in the warning", async () => {
    const { messages } = await gateInput({
      commandRunner: async () => LOW_QUOTA_PAYLOAD,
    });

    expect(messages[0]).toContain("reset 2026-10-15T00:58:42.000Z");
  });

  it("prompts with the negative-default question under a terminal", async () => {
    const prompts: string[] = [];
    await gateInput({
      interactive: true,
      confirm: async (prompt) => {
        prompts.push(prompt);

        return true;
      },
      commandRunner: async () => LOW_QUOTA_PAYLOAD,
    });

    expect(prompts).toEqual(["Proceed despite low quota? [y/N] "]);
  });

  it("proceeds on an explicit y and declines otherwise", async () => {
    const yes = (
      await gateInput({
        interactive: true,
        confirm: async () => true,
        commandRunner: async () => LOW_QUOTA_PAYLOAD,
      })
    ).outcome;
    const no = (
      await gateInput({
        interactive: true,
        confirm: async () => false,
        commandRunner: async () => LOW_QUOTA_PAYLOAD,
      })
    ).outcome;

    expect({ yes, no }).toEqual({ yes: "proceed", no: "declined" });
  });

  it("bypasses with a terminal warning under --no-quota-check", async () => {
    const { outcome, messages } = await gateInput({
      noQuotaCheck: true,
      interactive: true,
    });

    expect({ outcome, messages }).toEqual({
      outcome: "proceed",
      messages: [
        "wiki-sync: WARNING — quota checking explicitly bypassed (--no-quota-check)",
      ],
    });
  });

  it("bypasses silently when the setting is off", async () => {
    const off = parseSettings(
      "command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\nquotaPreflight: off\n",
      "settings.yml",
    );
    const { outcome, messages } = await gateInput({
      noQuotaCheck: true,
      interactive: true,
      settings: off,
    });

    expect({ outcome, messages }).toEqual({ outcome: "proceed", messages: [] });
  });

  it("stays fail-open and silent on non-authoritative evidence", async () => {
    const unavailable = parseSettings(
      "command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\nquotaPreflight: /no/such/quota-axi\n",
      "settings.yml",
    );
    const confirm = vi.fn(async () => false);
    const { outcome, messages } = await gateInput({
      interactive: true,
      settings: unavailable,
      confirm,
      commandRunner: async () => {
        throw new Error("cannot execute");
      },
    });

    expect({
      outcome,
      confirmCalls: confirm.mock.calls.length,
      messages,
    }).toEqual({
      outcome: "proceed",
      confirmCalls: 0,
      messages: [],
    });
  });

  it("renders a malformed buffer warning through the gate", async () => {
    const buffered = parseSettings(
      "command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\nquotaPreflightBuffer: nope\n",
      "settings.yml",
    );
    const { outcome, messages } = await gateInput({
      settings: buffered,
      commandRunner: async () => LOW_QUOTA_PAYLOAD,
    });

    expect({
      outcome,
      warning: messages[0]?.includes("WARNING"),
      named: messages[0]?.includes("quotaPreflightBuffer"),
    }).toEqual({
      outcome: "declined",
      warning: true,
      named: true,
    });
  });
});
