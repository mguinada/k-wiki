import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAuthStorePath } from "../../src/ingest/agent-runner.ts";
import { parseSettings } from "../../src/ingest/agent-settings.ts";
import {
  type CredentialPreflightOptions,
  credentialGate,
  credentialPreflight,
  providerEnvVar,
} from "../../src/schedule/credential-preflight.ts";

const settings = (text: string) => parseSettings(text, "settings.yml");

/** Overrides that may explicitly pass `undefined` to drop the
 *  helper's default (exactOptionalPropertyTypes-safe), so a test
 *  can exercise the real auth-store reader. */
type OptionsOverride = {
  [K in keyof CredentialPreflightOptions]?:
    | CredentialPreflightOptions[K]
    | undefined;
};

const zaiSettings = () =>
  settings("command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n");

const targetsSettings = () =>
  settings(
    "command: pi\nreasoning: high\ntargets: zai/GLM-5.2, openrouter/QSEN\n",
  );

const options = (overrides: OptionsOverride): CredentialPreflightOptions =>
  ({
    settings: zaiSettings(),
    log: () => {},
    env: {},
    readAuthStore: async () => ({ kind: "absent" }),
    ...overrides,
  }) as CredentialPreflightOptions;

describe("providerEnvVar", () => {
  it("maps a simple provider id to its canonical env var", () => {
    expect(providerEnvVar("zai")).toBe("ZAI_API_KEY");
  });

  it("maps a hyphenated provider id to an upper-snake env var", () => {
    expect(providerEnvVar("zai-coding-cn")).toBe("ZAI_CODING_CN_API_KEY");
  });
});

describe("defaultAuthStorePath", () => {
  it("resolves pi's default auth store against the given home", () => {
    expect(defaultAuthStorePath("/home/op")).toBe(
      join("/home/op", ".pi", "agent", "auth.json"),
    );
  });

  it("defaults to this process's own home", () => {
    expect(defaultAuthStorePath()).toBe(
      join(process.env.HOME ?? "", ".pi", "agent", "auth.json"),
    );
  });
});

describe("credentialPreflight", () => {
  it("skips when the env var is absent and the auth store has no entry", async () => {
    const lines: string[] = [];
    const result = await credentialPreflight(
      options({ log: (line) => lines.push(line) }),
    );

    expect({ ...result, line: lines[0] }).toEqual({
      status: "skip",
      reason:
        "no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry",
      line: "scheduled-run: credential pre-flight skipped — no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry",
    });
  });

  it("proceeds when the provider's credential env var is present in a mode the env reaches", async () => {
    const result = await credentialPreflight(
      options({ env: { ZAI_API_KEY: "k" }, envReachesCycle: true }),
    );

    expect(result).toEqual({ status: "proceed" });
  });

  it("skips an env-var-only target when the env does not reach the cycle", async () => {
    const result = await credentialPreflight(
      options({ env: { ZAI_API_KEY: "k" } }),
    );

    expect(result).toEqual({
      status: "skip",
      reason:
        "no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry",
    });
  });

  it("proceeds on an auth-store entry alone", async () => {
    const result = await credentialPreflight(
      options({
        readAuthStore: async () => ({ kind: "entries", providers: ["zai"] }),
      }),
    );

    expect(result).toEqual({ status: "proceed" });
  });

  it("treats an empty env var value as absent", async () => {
    const result = await credentialPreflight(
      options({ env: { ZAI_API_KEY: "" }, envReachesCycle: true }),
    );

    expect(result).toEqual({
      status: "skip",
      reason: expect.stringContaining("no ZAI_API_KEY in cycle env"),
    });
  });

  it("proceeds when one of several targets is authenticatable", async () => {
    const result = await credentialPreflight(
      options({
        settings: targetsSettings(),
        env: { OPENROUTER_API_KEY: "k" },
        envReachesCycle: true,
      }),
    );

    expect(result).toEqual({ status: "proceed" });
  });

  it("names every unauthenticatable target in the skip reason", async () => {
    const result = await credentialPreflight(
      options({ settings: targetsSettings() }),
    );

    expect(result).toEqual({
      status: "skip",
      reason:
        "no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry; openrouter/QSEN: no OPENROUTER_API_KEY in cycle env, no auth.json entry",
    });
  });

  it("matches the auth-store entry exactly, not by prefix", async () => {
    const result = await credentialPreflight(
      options({
        settings: targetsSettings(),
        readAuthStore: async () => ({
          kind: "entries",
          providers: ["zai-coding"],
        }),
      }),
    );

    expect(result).toEqual({
      status: "skip",
      reason: expect.stringContaining("zai/GLM-5.2"),
    });
  });

  it("proceeds fail-open when the auth store cannot be judged", async () => {
    const lines: string[] = [];
    const result = await credentialPreflight(
      options({
        log: (line) => lines.push(line),
        readAuthStore: async () => ({ kind: "unreadable" }),
      }),
    );

    expect({ ...result, line: lines[0] }).toEqual({
      status: "proceed",
      line: "scheduled-run: credential pre-flight could not read the pi auth store — proceeding",
    });
  });

  it("proceeds without reading the store when no target names a provider", async () => {
    let reads = 0;
    const result = await credentialPreflight(
      options({
        settings: settings("command: pi\nmodel: M\nreasoning: low\n"),
        readAuthStore: async () => {
          reads += 1;

          return { kind: "unreadable" as const };
        },
      }),
    );

    expect({ ...result, reads }).toEqual({
      status: "proceed",
      reads: 0,
    });
  });

  it("reads the default auth-store path when none is given", async () => {
    let asked: string | undefined;
    const result = await credentialPreflight(
      options({
        env: { ZAI_API_KEY: "k" },
        envReachesCycle: true,
        readAuthStore: async (path) => {
          asked = path;

          return { kind: "absent" as const };
        },
      }),
    );

    expect({ ...result, asked }).toEqual({
      status: "proceed",
      asked: defaultAuthStorePath(),
    });
  });
});

describe("credentialPreflight default auth-store reader", () => {
  it("reads the providers of a real auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-store-"));
    const store = join(dir, "auth.json");

    await writeFile(store, JSON.stringify({ zai: { type: "api", key: "k" } }));

    const result = await credentialPreflight(
      options({ authStorePath: store, readAuthStore: undefined }),
    );

    await rm(dir, { recursive: true, force: true });

    expect(result).toEqual({ status: "proceed" });
  });

  it("judges an absent store as no stored credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-store-"));

    const result = await credentialPreflight(
      options({
        authStorePath: join(dir, "absent.json"),
        readAuthStore: undefined,
      }),
    );

    await rm(dir, { recursive: true, force: true });

    expect(result).toEqual({
      status: "skip",
      reason: expect.stringContaining("no auth.json entry"),
    });
  });

  it("proceeds fail-open on a corrupt store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-store-"));
    const store = join(dir, "auth.json");

    await writeFile(store, "{not json");

    const lines: string[] = [];
    const result = await credentialPreflight(
      options({
        authStorePath: store,
        log: (line) => lines.push(line),
        readAuthStore: undefined,
      }),
    );

    await rm(dir, { recursive: true, force: true });

    expect({
      ...result,
      failed: lines.join("\n").includes("could not read"),
    }).toEqual({
      status: "proceed",
      failed: true,
    });
  });

  it("proceeds fail-open on a store that parses to a non-object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-store-"));
    const store = join(dir, "auth.json");

    await writeFile(store, '["zai"]');

    const lines: string[] = [];
    const result = await credentialPreflight(
      options({
        authStorePath: store,
        log: (line) => lines.push(line),
        readAuthStore: undefined,
      }),
    );

    await rm(dir, { recursive: true, force: true });

    expect({
      ...result,
      failed: lines.join("\n").includes("could not read"),
    }).toEqual({
      status: "proceed",
      failed: true,
    });
  });
});

describe("credentialGate", () => {
  it("skips through real settings when no target is authenticatable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-gate-"));
    const settingsPath = join(dir, "settings.yml");

    await writeFile(
      settingsPath,
      "command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n",
    );

    const lines: string[] = [];
    const result = await credentialGate(
      settingsPath,
      (line) => lines.push(line),
      { cycleEnv: {}, authStorePath: join(dir, "absent-auth.json") },
    );

    await rm(dir, { recursive: true, force: true });

    expect({ ...result, log: lines[0] }).toEqual({
      status: "skip",
      reason:
        "no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry",
      log: "scheduled-run: credential pre-flight skipped — no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry",
    });
  });

  it("proceeds fail-open when the settings cannot load", async () => {
    const lines: string[] = [];
    const result = await credentialGate("/kw409-absent/settings.yml", (line) =>
      lines.push(line),
    );

    expect({ ...result, line: lines[0] }).toEqual({
      status: "proceed",
      line: "scheduled-run: agent settings unreadable — credential pre-flight unavailable — proceeding",
    });
  });
  it("proceeds through real settings whose targets all carry no provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-gate-"));
    const settingsPath = join(dir, "settings.yml");

    await writeFile(settingsPath, "command: pi\nmodel: M\nreasoning: low\n");

    const result = await credentialGate(settingsPath, () => {}, {
      cycleEnv: {},
      authStorePath: join(dir, "absent-auth.json"),
    });

    await rm(dir, { recursive: true, force: true });

    expect(result).toEqual({ status: "proceed" });
  });

  it("passes the env-var clause through scoped by envReachesCycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kw409-gate-"));
    const settingsPath = join(dir, "settings.yml");

    await writeFile(
      settingsPath,
      "command: pi\nprovider: zai\nmodel: GLM-5.2\nreasoning: high\n",
    );

    const scoped = await credentialGate(settingsPath, () => {}, {
      cycleEnv: { ZAI_API_KEY: "k" },
      authStorePath: join(dir, "absent-auth.json"),
    });
    const reaching = await credentialGate(settingsPath, () => {}, {
      cycleEnv: { ZAI_API_KEY: "k" },
      authStorePath: join(dir, "absent-auth.json"),
      envReachesCycle: true,
    });

    await rm(dir, { recursive: true, force: true });

    expect({ scoped, reaching }).toEqual({
      scoped: {
        status: "skip",
        reason:
          "no authenticatable agent target — zai/GLM-5.2: no ZAI_API_KEY in cycle env, no auth.json entry",
      },
      reaching: { status: "proceed" },
    });
  });
});
