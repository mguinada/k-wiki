import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentArgs,
  formatAgentInvocation,
  isolationLabel,
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

  it("omits the isolate whitelist keys when unset", () => {
    expect(
      parseSettings("command: pi\nmodel: m\nreasoning: h\n", "s"),
    ).not.toHaveProperty("isolateSkills");
  });

  it("parses a bracketed isolate.skills list", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.skills: [.agents/skills/obsidian-markdown, .agents/skills/obsidian-bases]\n",
      "s",
    );

    expect(settings.isolateSkills).toEqual([
      ".agents/skills/obsidian-markdown",
      ".agents/skills/obsidian-bases",
    ]);
  });

  it("parses an unbracketed isolate.skills list of one item", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.skills: .agents/skills/obsidian-markdown\n",
      "s",
    );

    expect(settings.isolateSkills).toEqual([
      ".agents/skills/obsidian-markdown",
    ]);
  });

  it("parses a bracketed isolate.extensions list", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.extensions: [npm:pi-web-access, npm:pi-subagents]\n",
      "s",
    );

    expect(settings.isolateExtensions).toEqual([
      "npm:pi-web-access",
      "npm:pi-subagents",
    ]);
  });

  it("unquotes isolate.skills items", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.skills: [\".agents/skills/a\", '.agents/skills/b']\n",
      "s",
    );

    expect(settings.isolateSkills).toEqual([
      ".agents/skills/a",
      ".agents/skills/b",
    ]);
  });

  it("allows an empty explicit isolate.skills list (no whitelist)", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.skills: []\n",
      "s",
    );

    expect(settings.isolateSkills).toEqual([]);
  });

  it("allows an empty explicit isolate.extensions list (no whitelist)", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.extensions: []\n",
      "s",
    );

    expect(settings.isolateExtensions).toEqual([]);
  });

  it("drops empty items in any list position", () => {
    const settings = parseSettings(
      "command: pi\nmodel: m\nreasoning: h\nisolate.skills: [, .agents/skills/a, ,]\n",
      "s",
    );

    expect(settings.isolateSkills).toEqual([".agents/skills/a"]);
  });

  it("rejects a duplicate isolate.skills key", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nisolate.skills: /a\nisolate.skills: /b\n",
        "s",
      ),
    ).toThrow('duplicate setting "isolate.skills"');
  });

  it("rejects a duplicate isolate.extensions key", () => {
    expect(() =>
      parseSettings(
        "command: pi\nmodel: m\nreasoning: h\nisolate.extensions: npm:a\nisolate.extensions: npm:b\n",
        "s",
      ),
    ).toThrow('duplicate setting "isolate.extensions"');
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

  it("appends one --skill flag per whitelisted skill after the isolation flags", () => {
    const args = agentArgs(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateSkills: ["/repo/.agents/skills/a", "/repo/.agents/skills/b"],
      },
      "PROMPT",
    );

    expect(args.slice(0, 7)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--skill",
      "/repo/.agents/skills/a",
      "--skill",
      "/repo/.agents/skills/b",
    ]);
  });

  it("appends one -e flag per whitelisted extension after the skills", () => {
    const args = agentArgs(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateSkills: ["/repo/.agents/skills/a"],
        isolateExtensions: ["npm:pi-web-access", "npm:pi-subagents"],
      },
      "PROMPT",
    );

    expect(args.slice(3, 9)).toEqual([
      "--skill",
      "/repo/.agents/skills/a",
      "-e",
      "npm:pi-web-access",
      "-e",
      "npm:pi-subagents",
    ]);
  });

  it("keeps the whitelist flags ahead of the provider flag", () => {
    const args = agentArgs(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        provider: "zai",
        isolateSkills: ["/s"],
        isolateExtensions: ["npm:x"],
      },
      "PROMPT",
    );

    expect(args.slice(0, 8)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--skill",
      "/s",
      "-e",
      "npm:x",
      "--provider",
    ]);
  });

  it("builds the exact pre-isolation argv on isolate: false even with whitelist keys set", () => {
    const args = agentArgs(
      {
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        isolate: false,
        isolateSkills: ["/s"],
        isolateExtensions: ["npm:x"],
      },
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

  it("records the whitelist state in the isolation state", () => {
    expect(
      formatAgentInvocation({
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        isolateSkills: ["/a", "/b"],
        isolateExtensions: ["npm:x", "npm:y"],
      }),
    ).toBe(
      "pi --model GLM-5.2 --thinking high (isolated +2 skills +2 extensions)",
    );
  });
});

describe("isolationLabel", () => {
  it("stays plain isolated with no whitelist", () => {
    expect(isolationLabel({ command: "pi", model: "m", reasoning: "h" })).toBe(
      "isolated",
    );
  });

  it("counts whitelisted skills and extensions", () => {
    expect(
      isolationLabel({
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateSkills: ["/a", "/b"],
        isolateExtensions: ["npm:x", "npm:y"],
      }),
    ).toBe("isolated +2 skills +2 extensions");
  });

  it("uses the singular for one skill and one extension", () => {
    expect(
      isolationLabel({
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateSkills: ["/a"],
        isolateExtensions: ["npm:x"],
      }),
    ).toBe("isolated +1 skill +1 extension");
  });

  it("ignores the whitelist keys on an isolate: false opt-out", () => {
    expect(
      isolationLabel({
        command: "pi",
        model: "m",
        reasoning: "h",
        isolate: false,
        isolateSkills: ["/a"],
        isolateExtensions: ["npm:x"],
      }),
    ).toBe("not isolated");
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

describe("loadAgentSettings whitelist resolution (issue #144)", () => {
  const whitelistDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(
      whitelistDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /** A temp dir with settings.yml plus the named present entries:
   *  skills/<name>/SKILL.md dirs and ext/<name> files. Returns the
   *  settings path and the pi install root with fake npm packages. */
  async function makeWhitelistFixture(options: {
    readonly presentSkills?: readonly string[];
    readonly missingSkills?: readonly string[];
    readonly presentExtensions?: readonly string[];
    readonly missingExtensions?: readonly string[];
  }): Promise<{ settingsPath: string; piInstallRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-whitelist-"));

    whitelistDirs.push(root);

    const skills = [
      ...(options.presentSkills ?? []),
      ...(options.missingSkills ?? []),
    ];
    const extensions = [
      ...(options.presentExtensions ?? []),
      ...(options.missingExtensions ?? []),
    ];

    await mkdir(join(root, "skills"), { recursive: true });

    for (const skill of options.presentSkills ?? []) {
      await mkdir(join(root, "skills", skill), { recursive: true });
      await writeFile(join(root, "skills", skill, "SKILL.md"), "# skill\n");
    }

    for (const source of options.presentExtensions ?? []) {
      if (source.startsWith("npm:")) {
        continue;
      }

      await mkdir(join(root, "ext"), { recursive: true });
      await writeFile(
        join(root, "ext", source.replaceAll("/", "_")),
        "export {};\n",
      );
    }

    const piInstallRoot = join(root, "pi-root");

    await mkdir(join(piInstallRoot, "npm", "node_modules"), {
      recursive: true,
    });

    for (const source of options.presentExtensions ?? []) {
      if (!source.startsWith("npm:")) {
        continue;
      }

      await mkdir(join(piInstallRoot, "npm", "node_modules", source.slice(4)), {
        recursive: true,
      });
    }

    const settingsPath = join(root, "settings.yml");

    await writeFile(
      settingsPath,
      [
        "command: pi",
        "model: m",
        "reasoning: h",
        ...(skills.length > 0
          ? [`isolate.skills: [${skills.map((s) => `skills/${s}`).join(", ")}]`]
          : []),
        ...(extensions.length > 0
          ? [`isolate.extensions: [${extensions.join(", ")}]`]
          : []),
      ].join("\n"),
      "utf8",
    );

    return { settingsPath, piInstallRoot };
  }

  it("resolves skill entries against the settings file's directory", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      presentSkills: ["obsidian-markdown"],
    });

    const settings = await loadAgentSettings(settingsPath, {
      piInstallRoot,
    });

    expect(settings.isolateSkills).toEqual([
      join(dirnameOf(settingsPath), "skills", "obsidian-markdown"),
    ]);
  });

  it("warns once and omits a missing skill entry", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      presentSkills: ["present"],
      missingSkills: ["absent"],
    });
    const warnings: string[] = [];

    const settings = await loadAgentSettings(settingsPath, {
      piInstallRoot,
      onProgress: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      `WARNING — isolate.skills entry "${join(dirnameOf(settingsPath), "skills", "absent")}" not found; omitted`,
    ]);
    expect(settings.isolateSkills).toEqual([
      join(dirnameOf(settingsPath), "skills", "present"),
    ]);
  });

  it("keeps an installed npm: extension and strips a missing one with a warning", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      presentExtensions: ["npm:pi-web-access"],
      missingExtensions: ["npm:pi-not-installed"],
    });
    const warnings: string[] = [];

    const settings = await loadAgentSettings(settingsPath, {
      piInstallRoot,
      onProgress: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      'WARNING — isolate.extensions entry "npm:pi-not-installed" not installed under the pi install root; omitted',
    ]);
    expect(settings.isolateExtensions).toEqual(["npm:pi-web-access"]);
  });

  it("warns and omits a path-like extension entry that does not exist", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      missingExtensions: ["ext/absent.ts"],
    });
    const warnings: string[] = [];

    const settings = await loadAgentSettings(settingsPath, {
      piInstallRoot,
      onProgress: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      `WARNING — isolate.extensions entry "${join(dirnameOf(settingsPath), "ext", "absent.ts")}" not found; omitted`,
    ]);
    expect(settings.isolateExtensions).toEqual([]);
  });

  it("passes git: extension sources through without a pre-flight", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      presentExtensions: ["git:github.com/example/ext"],
    });
    const warnings: string[] = [];

    const settings = await loadAgentSettings(settingsPath, {
      piInstallRoot,
      onProgress: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(settings.isolateExtensions).toEqual(["git:github.com/example/ext"]);
  });

  it("emits no warnings when every entry is present", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      presentSkills: ["obsidian-markdown", "obsidian-bases"],
      presentExtensions: ["npm:pi-web-access"],
    });
    const warnings: string[] = [];

    await loadAgentSettings(settingsPath, {
      piInstallRoot,
      onProgress: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it("skips the pre-flight entirely on an isolate: false opt-out", async () => {
    const { settingsPath, piInstallRoot } = await makeWhitelistFixture({
      missingSkills: ["absent"],
      missingExtensions: ["npm:pi-not-installed"],
    });
    const warnings: string[] = [];

    await writeFile(
      settingsPath,
      `${await readFile(settingsPath, "utf8").then((t) => (t.endsWith("\n") ? t : `${t}\n`))}isolate: false\n`,
      "utf8",
    );

    const settings = await loadAgentSettings(settingsPath, {
      piInstallRoot,
      onProgress: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(settings.isolate).toBe(false);
  });

  it("expands a leading ~ in skill entries against home", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-whitelist-home-"));

    whitelistDirs.push(root);

    const settingsPath = join(root, "settings.yml");

    await writeFile(
      settingsPath,
      "command: pi\nmodel: m\nreasoning: h\nisolate.skills: ~/definitely-missing-skill\n",
      "utf8",
    );

    const settings = await loadAgentSettings(settingsPath, {
      onProgress: () => {},
    });

    expect(settings.isolateSkills).toEqual([]);
  });

  it("expands a leading ~ in path-like extension entries against home", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-whitelist-home-"));

    whitelistDirs.push(root);

    const settingsPath = join(root, "settings.yml");
    const warnings: string[] = [];

    await writeFile(
      settingsPath,
      "command: pi\nmodel: m\nreasoning: h\nisolate.extensions: ~/definitely-missing-ext.ts\n",
      "utf8",
    );

    const settings = await loadAgentSettings(settingsPath, {
      onProgress: (message) => warnings.push(message),
    });

    expect(settings.isolateExtensions).toEqual([]);
    expect(warnings[0]).toContain(
      `entry "${join(homedir(), "definitely-missing-ext.ts")}"`,
    );
  });
});

function dirnameOf(path: string): string {
  const separator = path.lastIndexOf("/");

  return separator === -1 ? "." : path.slice(0, separator) || "/";
}
