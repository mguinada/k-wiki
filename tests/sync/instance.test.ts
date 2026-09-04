import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveWikiInstance,
  syncConfigStem,
} from "../../src/sync/instance.ts";

/**
 * The shared instance resolver (issue #306): name → config path →
 * derived triple (raw dir, outputs dir, settings path). One chain
 * serves both doors — the --wiki flag and the binding's wiki key —
 * so every table here pins the contract all three entry points
 * inherit: alias beats stem, derivation keys off the resolved
 * config file (never the typed name), rawDir always from the
 * resolved config's dataRoot, and the miss is the listing.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-instance-"));

  tempDirs.push(dir);

  return dir;
}

interface CheckoutOptions {
  readonly rootInstances?: Record<string, string>;
  readonly meta?: { readonly dataRoot?: string } | null;
  readonly secondBrain?: boolean;
  readonly metaSettings?: boolean;
  readonly extraConfigs?: readonly string[];
  readonly parent?: string;
}

/**
 * A checkout skeleton: sync.json (default instance, optional alias
 * map), sync-meta.json (its own data root), optionally
 * sync-second-brain.json and a settings-meta.yml sibling.
 */
async function makeCheckout(options: CheckoutOptions = {}): Promise<string> {
  const checkout = options.parent
    ? join(options.parent, "co-")
    : await makeTempDir();

  if (options.parent) {
    tempDirs.push(checkout);
    await mkdir(checkout, { recursive: true });
  }

  await writeFile(
    join(checkout, "sync.json"),
    JSON.stringify({
      dataRoot: join(checkout, "default-data"),
      vaults: [],
      ...(options.rootInstances === undefined
        ? {}
        : { instances: options.rootInstances }),
    }),
  );
  await mkdir(join(checkout, "default-data"), { recursive: true });

  if (options.meta !== null) {
    await writeFile(
      join(checkout, "sync-meta.json"),
      JSON.stringify({
        dataRoot: options.meta?.dataRoot ?? join(checkout, "meta-data"),
        vaults: [],
      }),
    );
    await mkdir(options.meta?.dataRoot ?? join(checkout, "meta-data"), {
      recursive: true,
    });
  }

  if (options.secondBrain) {
    await writeFile(
      join(checkout, "sync-second-brain.json"),
      JSON.stringify({ dataRoot: join(checkout, "sb-data"), vaults: [] }),
    );
  }

  if (options.metaSettings) {
    await writeFile(join(checkout, "settings-meta.yml"), "command: x\n");
  }

  for (const name of options.extraConfigs ?? []) {
    await writeFile(join(checkout, name), JSON.stringify({ vaults: [] }));
  }

  return checkout;
}

describe("syncConfigStem", () => {
  it("derives undefined for sync.json (the default instance)", () => {
    expect(syncConfigStem("/co/sync.json")).toBeUndefined();
  });

  it("derives the sync- prefix's remainder for a stem config", () => {
    expect(syncConfigStem("/co/sync-meta.json")).toBe("meta");
  });

  it("derives the plain basename for a non-sync config name", () => {
    expect(syncConfigStem("/co/configs/eng.json")).toBe("eng");
  });

  it("strips only the .json extension", () => {
    expect(syncConfigStem("/co/sync-a.b.json")).toBe("a.b");
  });

  it("rejects a config whose stem would be empty", () => {
    expect(() => syncConfigStem("/co/sync-.json")).toThrow(
      /cannot derive an instance stem/,
    );
  });
});

describe("resolveWikiInstance default", () => {
  it("resolves the default instance without a name", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.name).toBeUndefined();
  });

  it("resolves the checkout's sync.json without a name", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.configPath).toBe(join(checkout, "sync.json"));
  });

  it("derives no stem without a name", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.stem).toBeUndefined();
  });

  it("derives outputs/ for the default instance", async () => {
    const checkout = await makeCheckout({ meta: null });
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.outputsDir).toBe(join(checkout, "outputs"));
  });

  it("derives settings.yml for the default instance", async () => {
    const checkout = await makeCheckout({ meta: null });
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.settingsPath).toBe(join(checkout, "settings.yml"));
  });

  it("takes rawDir from the resolved config's dataRoot", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.rawDir).toBe(join(checkout, "default-data", "raw"));
  });

  it("exposes the loaded sync config", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: undefined,
      home: "/home/alice",
    });

    expect(instance.config.dataRoot).toBe(join(checkout, "default-data"));
  });
});

describe("resolveWikiInstance stems", () => {
  it("carries the stem name it resolved", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.name).toBe("meta");
  });

  it("resolves a stem name to the checkout's sync-<name>.json", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.configPath).toBe(join(checkout, "sync-meta.json"));
  });

  it("derives the stem from the resolved config's name", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.stem).toBe("meta");
  });

  it("derives outputs-<stem>/ for a stem config", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.outputsDir).toBe(join(checkout, "outputs-meta"));
  });

  it("derives the settings-<stem>.yml sibling when it exists", async () => {
    const checkout = await makeCheckout({ metaSettings: true });
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.settingsPath).toBe(join(checkout, "settings-meta.yml"));
  });

  it("falls back to settings.yml when no sibling exists", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.settingsPath).toBe(join(checkout, "settings.yml"));
  });

  it("takes rawDir from the stem config's dataRoot", async () => {
    const checkout = await makeCheckout();
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.rawDir).toBe(join(checkout, "meta-data", "raw"));
  });
});

describe("resolveWikiInstance aliases", () => {
  it("resolves an alias to its target config", async () => {
    const checkout = await makeCheckout({
      rootInstances: { eng: "sync-engineering.json" },
      extraConfigs: ["sync-engineering.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "eng",
      home: "/home/alice",
    });

    expect(instance.configPath).toBe(join(checkout, "sync-engineering.json"));
  });

  it("carries the alias name it resolved", async () => {
    const checkout = await makeCheckout({
      rootInstances: { eng: "sync-engineering.json" },
      extraConfigs: ["sync-engineering.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "eng",
      home: "/home/alice",
    });

    expect(instance.name).toBe("eng");
  });

  it("derives the target's stem, never the alias name", async () => {
    const checkout = await makeCheckout({
      rootInstances: { eng: "sync-engineering.json" },
      extraConfigs: ["sync-engineering.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "eng",
      home: "/home/alice",
    });

    expect(instance.stem).toBe("engineering");
  });

  it("derives the target's outputs dir, never the alias name's", async () => {
    const checkout = await makeCheckout({
      rootInstances: { eng: "sync-engineering.json" },
      extraConfigs: ["sync-engineering.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "eng",
      home: "/home/alice",
    });

    expect(instance.outputsDir).toBe(join(checkout, "outputs-engineering"));
  });

  it("beats a stem of the same name", async () => {
    const checkout = await makeCheckout({
      rootInstances: { meta: "sync-other.json" },
      extraConfigs: ["sync-other.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "meta",
      home: "/home/alice",
    });

    expect(instance.configPath).toBe(join(checkout, "sync-other.json"));
  });

  it("resolves a ~-ful target to its expanded path", async () => {
    const home = await makeTempDir();
    const checkout = await makeCheckout({
      parent: home,
      rootInstances: { ext: "~/co-/sync-nested.json" },
      extraConfigs: ["sync-nested.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "ext",
      home,
    });

    expect(instance.configPath).toBe(join(checkout, "sync-nested.json"));
  });

  it("derives a ~-ful target's stem from its basename", async () => {
    const home = await makeTempDir();
    const checkout = await makeCheckout({
      parent: home,
      rootInstances: { ext: "~/co-/sync-nested.json" },
      extraConfigs: ["sync-nested.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "ext",
      home,
    });

    expect(instance.stem).toBe("nested");
  });

  it("derives a ~-ful target's outputs dir from its basename stem", async () => {
    const home = await makeTempDir();
    const checkout = await makeCheckout({
      parent: home,
      rootInstances: { ext: "~/co-/sync-nested.json" },
      extraConfigs: ["sync-nested.json"],
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "ext",
      home,
    });

    expect(instance.outputsDir).toBe(join(checkout, "outputs-nested"));
  });

  it("resolves a nested relative target to its path inside the checkout", async () => {
    const checkout = await makeCheckout();

    await mkdir(join(checkout, "configs"), { recursive: true });
    await writeFile(
      join(checkout, "configs", "eng.json"),
      JSON.stringify({ vaults: [] }),
    );
    await writeFile(
      join(checkout, "sync.json"),
      JSON.stringify({
        dataRoot: join(checkout, "default-data"),
        vaults: [],
        instances: { eng: "configs/eng.json" },
      }),
    );
    const instance = await resolveWikiInstance({
      checkout,
      name: "eng",
      home: "/home/alice",
    });

    expect(instance.stem).toBe("eng");
  });

  it("derives a nested target's outputs dir from its basename stem", async () => {
    const checkout = await makeCheckout();

    await mkdir(join(checkout, "configs"), { recursive: true });
    await writeFile(
      join(checkout, "configs", "eng.json"),
      JSON.stringify({ vaults: [] }),
    );
    await writeFile(
      join(checkout, "sync.json"),
      JSON.stringify({
        dataRoot: join(checkout, "default-data"),
        vaults: [],
        instances: { eng: "configs/eng.json" },
      }),
    );
    const instance = await resolveWikiInstance({
      checkout,
      name: "eng",
      home: "/home/alice",
    });

    expect(instance.outputsDir).toBe(join(checkout, "outputs-eng"));
  });

  it("resolves an alias to the default config's path", async () => {
    const checkout = await makeCheckout({
      rootInstances: { reg: "sync.json" },
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "reg",
      home: "/home/alice",
    });

    expect(instance.configPath).toBe(join(checkout, "sync.json"));
  });

  it("derives no stem for an alias to the default config", async () => {
    const checkout = await makeCheckout({
      rootInstances: { reg: "sync.json" },
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "reg",
      home: "/home/alice",
    });

    expect(instance.stem).toBeUndefined();
  });

  it("derives the default outputs dir for an alias to the default config", async () => {
    const checkout = await makeCheckout({
      rootInstances: { reg: "sync.json" },
    });
    const instance = await resolveWikiInstance({
      checkout,
      name: "reg",
      home: "/home/alice",
    });

    expect(instance.outputsDir).toBe(join(checkout, "outputs"));
  });

  it("fails naming alias and path when the target file is missing", async () => {
    const checkout = await makeCheckout({
      rootInstances: { eng: "sync-missing.json" },
    });

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(/alias "eng" → "sync-missing\.json": no sync config at/);
  });

  it("rejects a target resolving outside the checkout", async () => {
    const outside = await makeTempDir();
    const checkout = await makeCheckout({
      rootInstances: { eng: join(outside, "sync-x.json") },
    });

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(/resolves outside the checkout/);
  });

  it("rejects a target escaping the checkout with dots", async () => {
    const checkout = await makeCheckout({
      rootInstances: { eng: "../sync-x.json" },
    });

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(/resolves outside the checkout/);
  });
});

describe("resolveWikiInstance misses", () => {
  it("lists aliases with targets, then stems, on a miss", async () => {
    const checkout = await makeCheckout({
      rootInstances: { nbn: "sync-meta.json" },
      secondBrain: true,
    });

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(
      /unknown wiki name "eng"; known names: nbn → sync-meta\.json, meta, second-brain/,
    );
  });

  it("mentions the default instance in the miss listing", async () => {
    const checkout = await makeCheckout();

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(/no --wiki flag selects the default instance/);
  });

  it("handles a miss when no other instance is known", async () => {
    const checkout = await makeCheckout({ meta: null });

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(/no other wiki names are known/);
  });

  it("names the name source in the miss when one is given", async () => {
    const checkout = await makeCheckout();

    await expect(
      resolveWikiInstance({
        checkout,
        name: "eng",
        home: "/home/alice",
        nameSource: ".k-wiki.json",
      }),
    ).rejects.toThrow(/unknown wiki name "eng" \(from \.k-wiki\.json\)/);
  });

  it("discovers stems non-recursively only", async () => {
    const checkout = await makeCheckout();

    await mkdir(join(checkout, "nested"), { recursive: true });
    await writeFile(
      join(checkout, "nested", "sync-deep.json"),
      JSON.stringify({ vaults: [] }),
    );

    await expect(
      resolveWikiInstance({ checkout, name: "eng", home: "/home/alice" }),
    ).rejects.toThrow(/known names: meta \(no --wiki/);
  });

  it("rejects a name with a path separator", async () => {
    const checkout = await makeCheckout();

    await expect(
      resolveWikiInstance({ checkout, name: "../x", home: "/home/alice" }),
    ).rejects.toThrow(/must be letters, digits/);
  });

  it("rejects an empty name", async () => {
    const checkout = await makeCheckout();

    await expect(
      resolveWikiInstance({ checkout, name: "", home: "/home/alice" }),
    ).rejects.toThrow(/must be letters, digits/);
  });
});
