import { describe, expect, it } from "vitest";
import { AGENT_COMMAND_ENV } from "../../src/cli/env.ts";

describe("AGENT_COMMAND_ENV", () => {
  it("names the launcher-to-spawn-site agent path contract", () => {
    expect(AGENT_COMMAND_ENV).toBe("KWIKI_AGENT_COMMAND");
  });
});
