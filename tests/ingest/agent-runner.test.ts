import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  codexRunner,
  defaultAuthStorePath,
  ISOLATION_FLAGS,
  isolationLabel,
  npmExtensionDir,
  piInstallRootFromEnv,
  piRunner,
  runnerEnv,
  WEB_EXTENSION_SOURCE,
  WEB_TOOL_ALLOWLIST,
} from "../../src/ingest/agent-runner.ts";
import {
  type AgentSettings,
  formatAgentInvocation,
  formatInvocation,
} from "../../src/ingest/agent-settings.ts";
import { providerEnvVar } from "../../src/schedule/credential-preflight.ts";

/**
 * Golden argv snapshots (issue #434): every array below was captured
 * from the pre-refactor pi wiring BEFORE the agent-runner adapter
 * extraction — the refactor's safety net. The post-refactor wiring
 * must reproduce each snapshot byte-identically: same flags, same
 * order, same values. The assertions are frozen; only the call
 * shapes follow the Runner surface (the pi adapter's
 * args/webEnrichArgs methods replace the pre-refactor free
 * functions agentArgs and webEnrichAgentArgs, whose isolationFlags
 * parameter the adapter now derives from the identity itself). The
 * query core phase and the end-to-end spawn wiring have their own
 * goldens: tests/query/wiki-query.test.ts (core argv) and the e2e
 * recording stub (argv/stdin/env per operation).
 */

describe("golden argv (pre-refactor capture, issue #434)", () => {
  it("agentArgs: the minimal isolated ingest argv", () => {
    expect(
      piRunner.args(
        { command: "pi", model: "GLM-5.2", reasoning: "high" },
        "PROMPT",
      ),
    ).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "PROMPT",
    ]);
  });

  it("agentArgs: the full isolated argv with provider and whitelist", () => {
    expect(
      piRunner.args(
        {
          command: "pi",
          model: "GLM-5.2",
          reasoning: "high",
          provider: "zai",
          isolate: true,
          isolateSkills: ["/data/.agents/skills/obsidian-markdown"],
          isolateExtensions: ["npm:pi-subagents"],
        },
        "PROMPT",
      ),
    ).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--skill",
      "/data/.agents/skills/obsidian-markdown",
      "-e",
      "npm:pi-subagents",
      "--provider",
      "zai",
      "--model",
      "GLM-5.2",
      "--thinking",
      "high",
      "--print",
      "PROMPT",
    ]);
  });

  it("agentArgs: the isolate:false opt-out argv drops isolation and whitelist", () => {
    expect(
      piRunner.args(
        {
          command: "pi",
          model: "m",
          reasoning: "h",
          isolate: false,
          isolateSkills: ["/data/.agents/skills/obsidian-markdown"],
          isolateExtensions: ["npm:pi-subagents"],
        },
        "PROMPT",
      ),
    ).toEqual(["--model", "m", "--thinking", "h", "--print", "PROMPT"]);
  });

  it("agentArgs: the query-only web grant never reaches ingest argv", () => {
    expect(
      piRunner.args(
        {
          command: "pi",
          model: "m",
          reasoning: "h",
          isolateExtensions: ["npm:pi-web-access", "npm:pi-subagents"],
        },
        "PROMPT",
      ),
    ).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "-e",
      "npm:pi-subagents",
      "--model",
      "m",
      "--thinking",
      "h",
      "--print",
      "PROMPT",
    ]);
  });

  it("ISOLATION_FLAGS: the ambient-isolation triple", () => {
    expect([...ISOLATION_FLAGS]).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
    ]);
  });

  it("webEnrichAgentArgs: the enrichment argv with provider and ambient isolation", () => {
    expect(
      piRunner.webEnrichArgs(
        {
          command: "pi",
          model: "M",
          reasoning: "high",
          provider: "zai",
        },
        "COMPOSED",
      ),
    ).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "-e",
      "npm:pi-web-access",
      "--tools",
      "web_search,source_check,fetch_content",
      "--provider",
      "zai",
      "--model",
      "M",
      "--thinking",
      "high",
      "--mode",
      "json",
      "--print",
      "COMPOSED",
    ]);
  });

  it("webEnrichAgentArgs: the enrichment argv without a provider", () => {
    expect(
      piRunner.webEnrichArgs(
        { command: "pi", model: "M", reasoning: "low" },
        "COMPOSED",
      ),
    ).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "-e",
      "npm:pi-web-access",
      "--tools",
      "web_search,source_check,fetch_content",
      "--model",
      "M",
      "--thinking",
      "low",
      "--mode",
      "json",
      "--print",
      "COMPOSED",
    ]);
  });

  it("webEnrichAgentArgs: the isolate:false opt-out drops the ambient isolation prefix", () => {
    expect(
      piRunner.webEnrichArgs(
        { command: "pi", model: "M", reasoning: "low", isolate: false },
        "COMPOSED",
      ),
    ).toEqual([
      "-e",
      "npm:pi-web-access",
      "--tools",
      "web_search,source_check,fetch_content",
      "--model",
      "M",
      "--thinking",
      "low",
      "--mode",
      "json",
      "--print",
      "COMPOSED",
    ]);
  });

  it("formatAgentInvocation: the audited invocation tail with provider and whitelist", () => {
    expect(
      formatAgentInvocation({
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        provider: "zai",
        isolateSkills: ["/data/.agents/skills/obsidian-markdown"],
        isolateExtensions: ["npm:pi-subagents"],
      }),
    ).toBe(
      "pi --provider zai --model GLM-5.2 --thinking high (isolated +1 skill +1 extension)",
    );
  });

  it("defaultAuthStorePath: pi's auth store under the cycle home", () => {
    expect(defaultAuthStorePath("/home/operator")).toBe(
      "/home/operator/.pi/agent/auth.json",
    );
  });

  it("providerEnvVar: the canonical credential env names", () => {
    expect([providerEnvVar("zai"), providerEnvVar("zai-coding-cn")]).toEqual([
      "ZAI_API_KEY",
      "ZAI_CODING_CN_API_KEY",
    ]);
  });

  it("npmExtensionDir: the npm grant dir under pi's install root", () => {
    expect(npmExtensionDir("npm:pi-web-access", "/pi-root")).toBe(
      "/pi-root/npm/node_modules/pi-web-access",
    );
  });

  it("piInstallRootFromEnv: the env override wins over the default root", () => {
    expect(piInstallRootFromEnv({ PI_CODING_AGENT_DIR: "/pi-root" })).toBe(
      "/pi-root",
    );
  });

  it("web grant constants: the query-only extension and tool allowlist", () => {
    expect([WEB_EXTENSION_SOURCE, WEB_TOOL_ALLOWLIST]).toEqual([
      "npm:pi-web-access",
      "web_search,source_check,fetch_content",
    ]);
  });
});

describe("agentArgs", () => {
  it("prepends the pi isolation flags by default", () => {
    const args = piRunner.args(
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
    const args = piRunner.args(
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
    const args = piRunner.args(
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
    const args = piRunner.args(
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
    const args = piRunner.args(
      { command: "pi", model: "m", reasoning: "h", isolate: false },
      "THE PROMPT",
    );

    expect(args[args.indexOf("--print") + 1]).toBe("THE PROMPT");
  });

  it("appends one --skill flag per whitelisted skill after the isolation flags", () => {
    const args = piRunner.args(
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
    const args = piRunner.args(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateSkills: ["/repo/.agents/skills/a"],
        isolateExtensions: ["npm:pi-context-view", "npm:pi-subagents"],
      },
      "PROMPT",
    );

    expect(args.slice(3, 9)).toEqual([
      "--skill",
      "/repo/.agents/skills/a",
      "-e",
      "npm:pi-context-view",
      "-e",
      "npm:pi-subagents",
    ]);
  });

  it("drops the query-only web grant from a whitelisted isolate.extensions entry", () => {
    const args = piRunner.args(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateExtensions: ["npm:pi-web-access", "npm:pi-subagents"],
      },
      "PROMPT",
    );

    expect(args).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "-e",
      "npm:pi-subagents",
      "--model",
      "m",
      "--thinking",
      "h",
      "--print",
      "PROMPT",
    ]);
  });

  it("drops a path-spelled pi-web-access entry from the args", () => {
    const args = piRunner.args(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateExtensions: ["/opt/pi/npm/node_modules/pi-web-access/index.ts"],
      },
      "PROMPT",
    );

    expect(args.join("\u0000")).not.toContain("pi-web-access");
  });

  it("grants no extension for a path-spelled entry", () => {
    const args = piRunner.args(
      {
        command: "pi",
        model: "m",
        reasoning: "h",
        isolateExtensions: ["/opt/pi/npm/node_modules/pi-web-access/index.ts"],
      },
      "PROMPT",
    );

    expect(args).not.toContain("-e");
  });

  it("keeps the whitelist flags ahead of the provider flag", () => {
    const args = piRunner.args(
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
    const args = piRunner.args(
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

describe("agentArgs web-grant isolation", () => {
  const CONFIGURATIONS = [
    {
      name: "default",
      settings: { command: "pi", model: "GLM-5.2", reasoning: "high" },
    },
    {
      name: "isolate true",
      settings: {
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        isolate: true,
      },
    },
    {
      name: "isolate false",
      settings: {
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        isolate: false,
      },
    },
    {
      name: "extension whitelist present",
      settings: {
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        isolateExtensions: ["npm:some-extension"],
      },
    },
    {
      name: "web extension whitelisted by the operator",
      settings: {
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        isolateExtensions: ["npm:pi-web-access"],
      },
    },
  ] as const;

  for (const { name, settings } of CONFIGURATIONS) {
    it(`keeps pi-web-access out of the ingest/lint/scoped argv (${name})`, () => {
      expect(piRunner.args(settings, "PROMPT").join("\u0000")).not.toContain(
        "pi-web-access",
      );
    });
  }
});

const SETTINGS: AgentSettings = {
  command: "pi",
  model: "GLM-5.2",
  reasoning: "high",
};

describe("piRunner.webEnrichArgs", () => {
  it("leads with the ambient isolation flags", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT");

    expect(args.slice(0, 3)).toEqual([
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
    ]);
  });

  it("places the web grant after the isolation flags", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT");

    const grant = args.indexOf("-e");

    expect(grant).toBeGreaterThan(2);
  });

  it("grants exactly the pi-web-access extension", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT");

    expect(args[args.indexOf("-e") + 1]).toBe(WEB_EXTENSION_SOURCE);
  });

  it("grants exactly the search+fetch tool allowlist", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT");

    expect(args[args.indexOf("--tools") + 1]).toBe(WEB_TOOL_ALLOWLIST);
  });

  it("exposes no other extension tool than the allowlist names", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT").join(" ");

    expect(args).not.toContain("get_search_content");
  });

  it("runs the enrichment in json output mode", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT");

    expect(args[args.indexOf("--mode") + 1]).toBe("json");
  });

  it("carries the composed prompt as the print payload", () => {
    const args = piRunner.webEnrichArgs(SETTINGS, "PROMPT");

    expect(args[args.indexOf("--print") + 1]).toBe("PROMPT");
  });

  it("drops the isolation flags under isolate: false", () => {
    const args = piRunner.webEnrichArgs(
      { ...SETTINGS, isolate: false },
      "PROMPT",
    );

    expect(args).not.toContain("--no-extensions");
  });

  it("still grants the web extension under isolate: false", () => {
    const args = piRunner.webEnrichArgs(
      { ...SETTINGS, isolate: false },
      "PROMPT",
    );

    expect(args).toContain("-e");
  });

  it("keeps the provider flag when the settings carry one", () => {
    const args = piRunner.webEnrichArgs(
      { ...SETTINGS, provider: "zai" },
      "PROMPT",
    );

    expect(args[args.indexOf("--provider") + 1]).toBe("zai");
  });
});

/**
 * Golden rendered lines (pre-refactor capture, issue #434): the
 * operator-facing invocation lines, captured from the pre-refactor
 * pi rendering BEFORE the invocation-descriptor refactor. The
 * refactor routes rendering through the descriptor + one rendering
 * site; these fixtures and the per-operation e2e assertions must
 * then match byte-for-byte. The tails are computed through the
 * exported pre-refactor builders (formatAgentInvocation); the
 * wrapper prefixes are the literals the spawn sites render. The
 * lines whose composition is not exported pre-refactor are pinned
 * byte-exact where they are produced: the answer-only query line by
 * tests/query/wiki-query.test.ts, the enrichment run line by
 * tests/query/web-enrich.test.ts, the ingest and expunge heartbeats
 * by tests/ingest/wiki-ingest.test.ts, and every composed line
 * end-to-end by the recording-stub e2e assertions.
 */

describe("golden rendered lines (pre-refactor capture, issue #434)", () => {
  it("formatAgentInvocation: the plain isolated tail", () => {
    expect(
      formatAgentInvocation({
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
      }),
    ).toBe("pi --model GLM-5.2 --thinking high (isolated)");
  });

  it("formatAgentInvocation: the not-isolated tail on the opt-out", () => {
    expect(
      formatAgentInvocation({
        command: "pi",
        model: "m",
        reasoning: "h",
        isolate: false,
      }),
    ).toBe("pi --model m --thinking h (not isolated)");
  });

  it("formatAgentInvocation: the not-isolated tail drops whitelist counts", () => {
    expect(
      formatAgentInvocation({
        command: "pi",
        model: "m",
        reasoning: "h",
        isolate: false,
        isolateSkills: ["/a"],
        isolateExtensions: ["npm:x"],
      }),
    ).toBe("pi --model m --thinking h (not isolated)");
  });

  it("the ingest line carries the mode and the audited tail", () => {
    const tail = formatAgentInvocation({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
    });

    expect(`wiki-ingest: mode full, invoking agent: ${tail}`).toBe(
      "wiki-ingest: mode full, invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
    );
  });

  it("the lint-stage line keeps the em-dash label and the audited tail", () => {
    const tail = formatAgentInvocation({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
    });

    expect(`wiki-sync: lint \u2014 invoking agent: ${tail}`).toBe(
      "wiki-sync: lint \u2014 invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
    );
  });

  it("the standalone lint door re-labels the stage line", () => {
    const tail = formatAgentInvocation({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
    });

    expect(
      `wiki-sync: lint \u2014 invoking agent: ${tail}`.replaceAll(
        "wiki-sync: lint",
        "wiki-lint",
      ),
    ).toBe(
      "wiki-lint \u2014 invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
    );
  });

  it("the propose line prefixes the sandbox label", () => {
    const tail = formatAgentInvocation({
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
    });

    expect(`sandbox: invoking agent: ${tail}`).toBe(
      "sandbox: invoking agent: pi --model GLM-5.2 --thinking high (isolated)",
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

describe("invocation descriptor (issue #434)", () => {
  it("carries the adapter id, identity, and the isolation posture", () => {
    expect(
      piRunner.invocation({
        command: "pi",
        model: "GLM-5.2",
        reasoning: "high",
        provider: "zai",
        isolateSkills: ["/a"],
      }),
    ).toEqual({
      agent: "pi",
      command: "pi",
      model: "GLM-5.2",
      reasoning: "high",
      provider: "zai",
      posture: "isolated +1 skill",
    });
  });

  it("reports the not-isolated posture on the opt-out", () => {
    expect(
      piRunner.invocation({
        command: "pi",
        model: "m",
        reasoning: "h",
        isolate: false,
      }).posture,
    ).toBe("not isolated");
  });

  it("folds the launcher's command override into the descriptor", () => {
    expect(
      piRunner.invocation(
        { command: "pi", model: "m", reasoning: "h" },
        { command: "/abs/resolved/pi" },
      ).command,
    ).toBe("/abs/resolved/pi");
  });

  it("omits the posture on an answer-only surface", () => {
    const invocation = piRunner.invocation(
      { command: "pi", model: "m", reasoning: "h" },
      { posture: false },
    );

    expect(invocation.posture).toBeUndefined();
  });

  it("formatInvocation renders the descriptor as the invoking-agent tail", () => {
    expect(
      formatInvocation({
        agent: "pi",
        command: "/abs/resolved/pi",
        model: "M",
        reasoning: "low",
        provider: "zai",
        posture: "isolated +2 skills",
      }),
    ).toBe(
      "/abs/resolved/pi --provider zai --model M --thinking low (isolated +2 skills)",
    );
  });

  it("formatInvocation omits the posture tail when the descriptor carries none", () => {
    expect(
      formatInvocation({
        agent: "pi",
        command: "pi",
        model: "M",
        reasoning: "low",
      }),
    ).toBe("pi --model M --thinking low");
  });
});

describe("codex Runner adapter", () => {
  const settings = {
    command: "codex",
    agent: "codex",
    model: "gpt-5.6-terra",
    reasoning: "high",
  } as const;

  it("maps settings to Codex exec argv with report capture", () => {
    const args = codexRunner.args(settings, "PROMPT", { root: "/data" });

    expect(args.slice(0, 12)).toEqual([
      "exec",
      "-C",
      "/data",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-terra",
      "-c",
      "model_reasoning_effort=high",
      "-o",
    ]);
  });

  it("keeps the Codex prompt off argv for stdin delivery", () => {
    expect(
      codexRunner.args(settings, "PROMPT", { root: "/data" }),
    ).not.toContain("PROMPT");
  });

  it("delivers the prompt on stdin", () => {
    expect(codexRunner.stdin("PROMPT")).toBe("PROMPT");
  });

  it("adds the query-only web grant only to enrichment argv", () => {
    expect(
      codexRunner.webEnrichArgs(settings, "PROMPT", { root: "/data" }),
    ).toContain("--web");
  });

  it("assembles a managed home with only symlinked skills, auth, and web disabled", () => {
    const fixture = mkdtempSync(join(tmpdir(), "k-wiki-codex-runner-"));
    const source = join(fixture, "source");
    const skill = join(fixture, "obsidian-markdown");

    mkdirSync(source, { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"openai":"seeded"}\n');
    const env = runnerEnv(
      { ...settings, isolateSkills: [skill] },
      { CODEX_HOME: source },
    );
    const home = env.CODEX_HOME ?? "";
    const managedSkill = join(home, ".agents", "skills", "obsidian-markdown");
    const result = {
      auth: readFileSync(join(home, "auth.json"), "utf8"),
      config: readFileSync(join(home, "config.toml"), "utf8"),
      home: env.HOME,
      skillLink: lstatSync(managedSkill).isSymbolicLink(),
    };

    rmSync(fixture, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    expect(result).toEqual({
      auth: '{"openai":"seeded"}\n',
      config: 'web_search = "disabled"\napproval_policy = "never"\n',
      home,
      skillLink: true,
    });
  });

  it("reports auth not seeded when the host has no auth store", () => {
    const fixture = mkdtempSync(join(tmpdir(), "k-wiki-codex-posture-"));
    vi.stubEnv("CODEX_HOME", fixture);

    const posture = codexRunner.invocation(settings).posture ?? "";

    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });

    expect(posture).toContain("auth not seeded");
  });

  it("reports auth seeded when the host auth store exists", () => {
    const fixture = mkdtempSync(join(tmpdir(), "k-wiki-codex-posture-"));
    vi.stubEnv("CODEX_HOME", fixture);
    writeFileSync(join(fixture, "auth.json"), "{}\n");

    const posture = codexRunner.invocation(settings).posture ?? "";

    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });

    expect(posture).toContain("auth seeded");
  });
});
