import { describe, expect, it } from "vitest";
import {
  agentArgs,
  formatAgentInvocation,
  npmExtensionDir,
  piInstallRootFromEnv,
  ISOLATION_FLAGS,
} from "../../src/ingest/agent-settings.ts";
import {
  WEB_EXTENSION_SOURCE,
  WEB_TOOL_ALLOWLIST,
  webEnrichAgentArgs,
} from "../../src/query/web-enrich.ts";
import {
  defaultAuthStorePath,
  providerEnvVar,
} from "../../src/schedule/credential-preflight.ts";

/**
 * Golden argv snapshots (issue #434): every array below was captured
 * from the pre-refactor pi wiring BEFORE the agent-runner adapter
 * extraction — the refactor's safety net. The post-refactor wiring
 * must reproduce each snapshot byte-identically: same flags, same
 * order, same values. Only this file's import block may move when
 * the pinned symbols relocate to the pi adapter
 * (src/ingest/agent-runner.ts); the assertions themselves are
 * frozen. The query core phase and the end-to-end spawn wiring have
 * their own goldens: tests/query/wiki-query.test.ts (core argv) and
 * the e2e recording stub (argv/stdin/env per operation).
 */

describe("golden argv (pre-refactor capture, issue #434)", () => {
  it("agentArgs: the minimal isolated ingest argv", () => {
    expect(
      agentArgs(
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
      agentArgs(
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
      agentArgs(
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
      agentArgs(
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
      webEnrichAgentArgs(
        {
          command: "pi",
          model: "M",
          reasoning: "high",
          provider: "zai",
        },
        [...ISOLATION_FLAGS],
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
      webEnrichAgentArgs(
        { command: "pi", model: "M", reasoning: "low" },
        [...ISOLATION_FLAGS],
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
      webEnrichAgentArgs(
        { command: "pi", model: "M", reasoning: "low", isolate: false },
        [],
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
