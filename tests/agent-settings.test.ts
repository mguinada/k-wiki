import { describe, expect, it } from "vitest";
import {
  agentArgs,
  formatAgentInvocation,
  loadAgentSettings,
  parseSettings,
} from "../src/ingest/agent-settings.ts";

const SETTINGS_YML = `# Agent configuration (issue #11).
command: pi
model: GLM-5.2 # trailing comment
reasoning: "high"
`;

describe("parseSettings", () => {
  it("parses the command, model, and reasoning scalars", () => {
    expect(parseSettings(SETTINGS_YML, "settings.yml")).toEqual({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
      provider: undefined,
    });
  });

  it("skips any number of indented comment lines", () => {
    expect(
      parseSettings(
        "command: pi\n  # first note\n  # second note\nmodel: M\nreasoning: low\n",
        "settings.yml",
      ),
    ).toEqual({
      command: "pi",
      model: "M",
      reasoning: "low",
      provider: undefined,
    });
  });

  it("parses an optional provider setting", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nprovider: zai\nreasoning: h\n",
      "s",
    );

    expect(settings.provider).toBe("zai");
  });

  it("parses an explicit isolate: true setting", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate: true\n",
      "s",
    );

    expect(settings.isolate).toBe(true);
  });

  it("parses an explicit isolate: false opt-out", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate: false\n",
      "s",
    );

    expect(settings.isolate).toBe(false);
  });

  it("leaves isolate unset when the key is absent (isolated by default)", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n",
      "s",
    );

    expect(settings.isolate).toBeUndefined();
  });

  it("rejects a non-boolean isolate value", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nisolate: maybe\n",
        "s",
      ),
    ).toThrow('setting "isolate" must be true or false');
  });

  it("unquotes single-quoted values", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: 'high'\n",
      "s",
    );

    expect(settings.reasoning).toBe("high");
  });

  it("accepts an indented comment line", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n  # indented note\n",
      "s",
    );

    expect(settings.model).toBe("m");
  });

  it("accepts a whitespace-only line", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\n   \n",
      "s",
    );

    expect(settings.command).toBe("pi");
  });

  it("accepts a space between key and colon", () => {
    const settings = parseSettings(
      "command : pi\nmodel: m\nreasoning: h\n",
      "s",
    );

    expect(settings.command).toBe("pi");
  });

  it("parses a bracketed secondBrain.domains list", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: [~/Lab/k-wiki-data/wiki, ~/Lab/other/wiki]\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual([
      "~/Lab/k-wiki-data/wiki",
      "~/Lab/other/wiki",
    ]);
  });

  it("parses an unbracketed secondBrain.domains list of one dir", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: ~/Lab/k-wiki-data/wiki\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual(["~/Lab/k-wiki-data/wiki"]);
  });

  it("unquotes secondBrain.domains items", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: [\"/a/wiki\", '/b/wiki']\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual(["/a/wiki", "/b/wiki"]);
  });

  it("rejects an empty secondBrain.domains list", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: []\n",
        "s",
      ),
    ).toThrow(
      'invalid agent settings at s: setting "secondBrain.domains" needs at least one wiki dir',
    );
  });

  it("keeps brackets inside a domain path", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: /opt/[d]/wiki\n",
      "s",
    );

    expect(settings.secondBrainDomains).toEqual(["/opt/[d]/wiki"]);
  });

  it("rejects a duplicate secondBrain.domains key", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nsecondBrain.domains: /a/wiki\nsecondBrain.domains: /b/wiki\n",
        "s",
      ),
    ).toThrow('duplicate setting "secondBrain.domains"');
  });

  it("rejects an unknown key", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: high\nextra: x\n", "s"),
    ).toThrow('invalid agent settings at s: unknown setting "extra"');
  });

  it("reports a one-character key as unknown, not malformed", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: h\nx: v\n", "s"),
    ).toThrow('invalid agent settings at s: unknown setting "x"');
  });

  it("rejects a missing required key", () => {
    expect(() => parseSettings("command: pi\nreasoning: high\n", "s")).toThrow(
      'invalid agent settings at s: missing setting "model"',
    );
  });

  it("rejects a missing command key", () => {
    expect(() => parseSettings("model: m\nreasoning: h\n", "s")).toThrow(
      'missing setting "command"',
    );
  });

  it("rejects a missing reasoning key", () => {
    expect(() => parseSettings("command: pi\nmodel: m\n", "s")).toThrow(
      'missing setting "reasoning"',
    );
  });

  it("rejects an empty value", () => {
    expect(() =>
      parseSettings("command:\nmodel: m\nreasoning: h\n", "s"),
    ).toThrow('setting "command" needs a value');
  });

  it("rejects nested (indented) lines", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\n  nested: true\n",
        "s",
      ),
    ).toThrow("nested values are not supported");
  });

  it("rejects duplicate keys", () => {
    expect(() =>
      parseSettings("command: pi\ncommand: pi\nmodel: m\nreasoning: h\n", "s"),
    ).toThrow('duplicate setting "command"');
  });

  it("rejects a line without a colon separator", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: high\nbroken\n", "s"),
    ).toThrow("expected `key: value`");
  });

  it("trims trailing whitespace before reporting a malformed line", () => {
    expect(() =>
      parseSettings("command: pi\nmodel: m\nreasoning: h\nbroken   \n", "s"),
    ).toThrow('expected `key: value`, got "broken"');
  });

  it("names the settings file in every error", () => {
    expect(() => parseSettings("command: pi\n", "my-settings.yml")).toThrow(
      "my-settings.yml",
    );
  });

  it("omits provider, isolate, and secondBrainDomains keys when unset", () => {
    expect(
      parseSettings("command: pi\nmodel: m\nreasoning: h\n", "s"),
    ).toStrictEqual({
      command: "pi",
      model: "m",
      reasoning: "h",
    });
  });
});

describe("agentArgs", () => {
  it("prepends the pi isolation flags by default", () => {
    const args = agentArgs(
      { command: "pi", model: "GLM-5.2", reasoning: "high" },
      "PROMPT",
    );

    expect(args.slice(0, 3)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
    ]);
  });

  it("prepends the pi isolation flags on an explicit isolate: true", () => {
    const args = agentArgs(
      { command: "pi", model: "GLM-5.2", reasoning: "high", isolate: true },
      "PROMPT",
    );

    expect(args.slice(0, 3)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
    ]);
  });

  it("keeps the isolation flags ahead of the provider flag", () => {
    const args = agentArgs(
      { command: "pi", model: "m", reasoning: "h", provider: "zai" },
      "PROMPT",
    );

    expect(args.slice(0, 5)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--provider",
      "zai",
    ]);
  });

  it("builds the exact pre-isolation argv on an isolate: false opt-out", () => {
    const args = agentArgs(
      { command: "pi", model: "GLM-5.2", reasoning: "high", isolate: false },
      "PROMPT",
    );

    expect(args).toEqual([
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "PROMPT",
    ]);
  });

  it("carries the prompt as the --print payload in every mode", () => {
    const args = agentArgs(
      { command: "pi", model: "m", reasoning: "h", isolate: false },
      "THE PROMPT",
    );

    expect(args[args.indexOf("--print") + 1]).toBe("THE PROMPT");
  });
});

describe("formatAgentInvocation", () => {
  it("renders the command, provider, model, reasoning, and isolation state", () => {
    expect(
      formatAgentInvocation({
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        provider: "zai",
      }),
    ).toBe("pi --provider zai --model GLM-5.2 --thinking high (isolated)");
  });
});

describe("loadAgentSettings", () => {
  it("fails naming the file when it cannot be read", async () => {
    await expect(loadAgentSettings("/no/such/settings.yml")).rejects.toThrow(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("keeps the underlying read error as the cause", async () => {
    let cause: unknown;

    try {
      await loadAgentSettings("/no/such/settings.yml");
    } catch (error) {
      cause = (error as Error).cause;
    }

    expect(cause).toBeInstanceOf(Error);
  });
});
