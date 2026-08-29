import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  expandHome,
  loadSyncConfig,
  parseExclude,
  resolveRawDir,
} from "../src/sync/config.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-config-"));

  tempDirs.push(dir);

  return dir;
}

async function writeConfig(json: unknown): Promise<string> {
  const dir = await makeTempDir();
  const path = join(dir, "sync.json");

  await writeFile(path, JSON.stringify(json));

  return path;
}

const ONE_VAULT = {
  vaults: [
    {
      name: "Documents",
      root: "~/vaults/Documents",
      exclude: "wiki:false",
    },
  ],
};

describe("expandHome", () => {
  it("expands a lone tilde to the home directory", () => {
    expect(expandHome("~", "/home/alice")).toBe("/home/alice");
  });

  it("expands a tilde-prefixed path against the home directory", () => {
    expect(expandHome("~/vaults/My Vault", "/home/alice")).toBe(
      "/home/alice/vaults/My Vault",
    );
  });

  it("leaves a path with a tilde-prefixed username unchanged", () => {
    expect(expandHome("~bob/notes", "/home/alice")).toBe("~bob/notes");
  });

  it("leaves an absolute path unchanged", () => {
    expect(expandHome("/vaults/Documents", "/home/alice")).toBe(
      "/vaults/Documents",
    );
  });

  it("leaves a relative path unchanged", () => {
    expect(expandHome("vaults/Documents", "/home/alice")).toBe(
      "vaults/Documents",
    );
  });
});

describe("parseExclude", () => {
  it("rejects an expression with anything before the key", () => {
    expect(() => parseExclude(" wiki:false")).toThrow(
      /unsupported exclude expression/,
    );
  });

  it("rejects an expression with anything after the value", () => {
    expect(() => parseExclude("wiki:false today")).toThrow(
      /unsupported exclude expression/,
    );
  });
});

describe("loadSyncConfig", () => {
  it("loads the vault name", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_VAULT),
      "/home/alice",
    );

    expect(config.vaults[0]?.name).toBe("Documents");
  });

  it("expands the vault root against home", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_VAULT),
      "/home/alice",
    );

    expect(config.vaults[0]?.root).toBe("/home/alice/vaults/Documents");
  });

  it("parses the exclude expression into key and value", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_VAULT),
      "/home/alice",
    );

    expect(config.vaults[0]).toMatchObject({
      exclude: { key: "wiki", value: "false" },
    });
  });

  it("expands the publish mirror against home", async () => {
    const config = await loadSyncConfig(
      await writeConfig({
        ...ONE_VAULT,
        publish: { mirror: "~/KWiki", include: ["wiki/**"] },
      }),
      "/home/alice",
    );

    expect(config.publish?.mirror).toBe("/home/alice/KWiki");
  });

  it("keeps the publish include list", async () => {
    const config = await loadSyncConfig(
      await writeConfig({
        ...ONE_VAULT,
        publish: { mirror: "~/KWiki", include: ["wiki/**"] },
      }),
      "/home/alice",
    );

    expect(config.publish?.include).toEqual(["wiki/**"]);
  });

  it("parses the publish re-root segment", async () => {
    const config = await loadSyncConfig(
      await writeConfig({
        ...ONE_VAULT,
        publish: { mirror: "/mirror", include: ["wiki/**"], root: "wiki" },
      }),
      "/home/alice",
    );

    expect(config.publish?.root).toBe("wiki");
  });

  it("leaves the publish re-root undefined when the config omits it", async () => {
    const config = await loadSyncConfig(
      await writeConfig({
        ...ONE_VAULT,
        publish: { mirror: "/mirror", include: ["wiki/**"] },
      }),
      "/home/alice",
    );

    expect(config.publish?.root).toBeUndefined();
  });

  it("allows a config without a publish section", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_VAULT),
      "/home/alice",
    );

    expect(config.publish).toBeUndefined();
  });

  it("allows an empty vault list", async () => {
    const config = await loadSyncConfig(
      await writeConfig({ vaults: [] }),
      "/home/alice",
    );

    expect(config.vaults).toEqual([]);
  });

  it("rejects a missing config file", async () => {
    const dir = await makeTempDir();

    await expect(
      loadSyncConfig(join(dir, "nope.json"), "/home/alice"),
    ).rejects.toThrow(/cannot read sync config/);
  });

  it("rejects config text that is not valid JSON", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "sync.json");

    await writeFile(path, "{ not json");

    await expect(loadSyncConfig(path, "/home/alice")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects a config whose root is not an object", async () => {
    await expect(
      loadSyncConfig(await writeConfig([]), "/home/alice"),
    ).rejects.toThrow(/expected a JSON object/);
  });

  it("rejects a vault name that contains a slash", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: "a/b" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/vault name/);
  });

  it("rejects a vault name that is a reserved object key", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: "__proto__" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/vault name/);
  });

  it("rejects a vault named constructor", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: "constructor" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/plain path segment/);
  });

  it("rejects a vault named prototype", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: "prototype" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/plain path segment/);
  });

  it("rejects a vault named a single dot", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: "." }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/plain path segment/);
  });

  it("rejects a vault named two dots", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: ".." }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/plain path segment/);
  });

  it("rejects a vault with an empty name", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: "" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/non-empty string/);
  });

  it("rejects a vault name that is an array", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: ["x"] }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/non-empty string/);
  });

  it("rejects duplicate vault names", async () => {
    const bad = { vaults: [ONE_VAULT.vaults[0], ONE_VAULT.vaults[0]] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/duplicate vault name/);
  });

  it("rejects a vault with an empty root", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], root: "" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/root/);
  });

  it("rejects an exclude expression other than <key>:false", async () => {
    const bad = {
      vaults: [{ ...ONE_VAULT.vaults[0], root: "/v", exclude: "wiki:true" }],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/unsupported exclude expression/);
  });

  it("rejects a vault entry that still sets select", async () => {
    const bad = {
      vaults: [{ ...ONE_VAULT.vaults[0], select: "wiki:true" }],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"select" was replaced by "exclude"/);
  });

  it("rejects a vault entry that sets both select and exclude", async () => {
    const bad = {
      vaults: [
        {
          ...ONE_VAULT.vaults[0],
          select: "wiki:true",
          exclude: "wiki:false",
        },
      ],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"select" was replaced by "exclude"/);
  });

  it("rejects a config whose root is null", async () => {
    await expect(
      loadSyncConfig(await writeConfig(null), "/home/alice"),
    ).rejects.toThrow(/expected a JSON object/);
  });

  it("rejects a publish section that is not an object", async () => {
    const bad = { ...ONE_VAULT, publish: 7 };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/publish" must be an object/);
  });

  it("rejects a publish include list with one non-string entry", async () => {
    const bad = {
      ...ONE_VAULT,
      publish: { mirror: "/mirror", include: ["wiki/**", 3] },
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/include" must be an array of non-empty strings/);
  });

  it("keeps the read error as the cause when the config file is missing", async () => {
    const dir = await makeTempDir();
    const error: unknown = await loadSyncConfig(
      join(dir, "nope.json"),
      "/home/alice",
    ).catch((reason: unknown) => reason);

    expect((error as NodeJS.ErrnoException).cause).toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the JSON parse error as the cause when the config is not valid JSON", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "sync.json");

    await writeFile(path, "{ not json");

    const error: unknown = await loadSyncConfig(path, "/home/alice").catch(
      (reason: unknown) => reason,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("keeps the validation error as the cause when a vault entry is invalid", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "sync.json");

    await writeFile(path, JSON.stringify({ vaults: [{}] }));

    const error: unknown = await loadSyncConfig(path, "/home/alice").catch(
      (reason: unknown) => reason,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("keeps the validation error as the cause when a vault field is invalid", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "sync.json");

    await writeFile(
      path,
      JSON.stringify({ vaults: [{ name: "V", root: "/v", exclude: 3 }] }),
    );

    const error: unknown = await loadSyncConfig(path, "/home/alice").catch(
      (reason: unknown) => reason,
    );

    expect(
      (error as { cause?: { cause?: unknown } }).cause?.cause,
    ).toBeInstanceOf(Error);
  });

  it("keeps the validation error as the cause when a vault entry is not an object", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "sync.json");

    await writeFile(path, JSON.stringify({ vaults: [7] }));

    const error: unknown = await loadSyncConfig(path, "/home/alice").catch(
      (reason: unknown) => reason,
    );

    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("rejects a vault name that is not a string", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], name: 7 }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/vault "name" must be a non-empty string/);
  });

  it("rejects a vault list that is not an array", async () => {
    await expect(
      loadSyncConfig(await writeConfig({ vaults: 7 }), "/home/alice"),
    ).rejects.toThrow(/"vaults" must be an array/);
  });

  it("rejects a vault entry that is not an object", async () => {
    const bad = { vaults: ["Documents"] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/vaults\[0\] must be an object/);
  });

  it("rejects an exclude expression that is not a string", async () => {
    const bad = {
      vaults: [{ ...ONE_VAULT.vaults[0], root: "/v", exclude: 3 }],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"exclude" must be a string/);
  });

  it("rejects a publish mirror that is not a non-empty string", async () => {
    const bad = { ...ONE_VAULT, publish: { mirror: "", include: [] } };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/publish "mirror" must be a non-empty string/);
  });

  it("rejects a publish include list that is not strings", async () => {
    const bad = { ...ONE_VAULT, publish: { mirror: "/mirror", include: [3] } };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/include" must be an array of non-empty strings/);
  });

  it("rejects an empty publish include list", async () => {
    const bad = { ...ONE_VAULT, publish: { mirror: "/mirror", include: [] } };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/publish "include" must list at least one pattern/);
  });

  it("rejects a publish root that is not a non-empty string", async () => {
    const bad = {
      ...ONE_VAULT,
      publish: { mirror: "/mirror", include: ["wiki/**"], root: "" },
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/publish "root" must be a non-empty string/);
  });

  it("rejects a publish root that is not a single path segment", async () => {
    const bad = {
      ...ONE_VAULT,
      publish: { mirror: "/mirror", include: ["wiki/**"], root: "wiki/sub" },
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(
      /publish "root" must be a non-empty string naming a single top-level path segment/,
    );
  });

  it("rejects a publish root the include patterns do not match", async () => {
    const bad = {
      ...ONE_VAULT,
      publish: { mirror: "/mirror", include: ["other/**"], root: "wiki" },
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/must match the include patterns/);
  });

  it("rejects a publish root only some include patterns match", async () => {
    const bad = {
      ...ONE_VAULT,
      publish: {
        mirror: "/mirror",
        include: ["wiki/**", "other/**"],
        root: "wiki",
      },
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/must match the include patterns/);
  });

  it("rejects a publish include pattern with an empty path segment", async () => {
    const bad = {
      ...ONE_VAULT,
      publish: { mirror: "/mirror", include: ["wiki//**"] },
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/empty path segment/);
  });
});

describe("dataRoot", () => {
  it("is undefined when the config omits it", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_VAULT),
      "/home/alice",
    );

    expect(config.dataRoot).toBeUndefined();
  });

  it("expands a tilde-prefixed data root against home", async () => {
    const config = await loadSyncConfig(
      await writeConfig({ ...ONE_VAULT, dataRoot: "~/Lab/k-wiki-data" }),
      "/home/alice",
    );

    expect(config.dataRoot).toBe("/home/alice/Lab/k-wiki-data");
  });

  it("rejects a data root that is not a non-empty string", async () => {
    const bad = { ...ONE_VAULT, dataRoot: "" };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"dataRoot" must be a non-empty string/);
  });
});

const ONE_REPO = {
  vaults: [
    {
      source: "repo",
      name: "k-wiki",
      root: "~/Lab/k-wiki",
      include: ["README.md", "src/**/*.ts"],
    },
  ],
};

describe("loadSyncConfig discriminated sources", () => {
  it("parses an entry with source repo as a repo source", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_REPO),
      "/home/alice",
    );

    expect(config.vaults[0]).toEqual({
      kind: "repo",
      name: "k-wiki",
      root: "/home/alice/Lab/k-wiki",
      include: ["README.md", "src/**/*.ts"],
    });
  });

  it("defaults an entry without a source key to the vault kind", async () => {
    const config = await loadSyncConfig(
      await writeConfig(ONE_VAULT),
      "/home/alice",
    );

    expect(config.vaults[0]).toEqual({
      kind: "vault",
      name: "Documents",
      root: "/home/alice/vaults/Documents",
      exclude: { key: "wiki", value: "false" },
    });
  });

  it("accepts an explicit source vault entry", async () => {
    const config = await loadSyncConfig(
      await writeConfig({
        vaults: [{ ...ONE_VAULT.vaults[0], source: "vault" }],
      }),
      "/home/alice",
    );

    expect(config.vaults[0]?.kind).toBe("vault");
  });

  it("rejects a source value other than vault or repo", async () => {
    const bad = { vaults: [{ ...ONE_VAULT.vaults[0], source: "git" }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"source" must be "vault" or "repo", got "git"/);
  });

  it("rejects a repo source without an include list", async () => {
    const bad = {
      vaults: [
        {
          source: "repo",
          name: "k-wiki",
          root: "~/Lab/k-wiki",
        },
      ],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/repo source needs an "include" allowlist/);
  });

  it("rejects a repo source with an empty include list", async () => {
    const bad = { vaults: [{ ...ONE_REPO.vaults[0], include: [] }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/repo source needs an "include" allowlist/);
  });

  it("rejects a repo source whose include list holds a non-string", async () => {
    const bad = { vaults: [{ ...ONE_REPO.vaults[0], include: [42] }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"include" must be an array of non-empty strings/);
  });

  it("rejects a repo source whose include list holds an empty string", async () => {
    const bad = { vaults: [{ ...ONE_REPO.vaults[0], include: [""] }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/"include" must be an array of non-empty strings/);
  });

  it("rejects a repo source whose include pattern has a leading slash", async () => {
    const bad = {
      vaults: [{ ...ONE_REPO.vaults[0], include: ["/docs/**/*.md"] }],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/empty path segment/);
  });

  it("rejects a repo source whose include pattern has a trailing slash", async () => {
    const bad = { vaults: [{ ...ONE_REPO.vaults[0], include: ["docs/"] }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/empty path segment/);
  });

  it("rejects a repo source whose include pattern has a doubled slash", async () => {
    const bad = { vaults: [{ ...ONE_REPO.vaults[0], include: ["src//a.ts"] }] };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/empty path segment/);
  });

  it("rejects a repo source that also sets exclude", async () => {
    const bad = {
      vaults: [{ ...ONE_REPO.vaults[0], exclude: "wiki:false" }],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/repo source takes "include", not "exclude"/);
  });

  it("rejects a vault source that also sets include", async () => {
    const bad = {
      vaults: [{ ...ONE_VAULT.vaults[0], include: ["README.md"] }],
    };

    await expect(
      loadSyncConfig(await writeConfig(bad), "/home/alice"),
    ).rejects.toThrow(/vault source takes "exclude", not "include"/);
  });
});

describe("resolveRawDir", () => {
  it("resolves to the raw tree inside the data root when set", () => {
    expect(resolveRawDir("/data/k-wiki-data", "/code/repo")).toBe(
      "/data/k-wiki-data/raw",
    );
  });

  it("resolves to the code repo raw tree when no data root is set", () => {
    expect(resolveRawDir(undefined, "/code/repo")).toBe("/code/repo/raw");
  });
});
