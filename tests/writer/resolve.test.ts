import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDataRootFromArgs } from "../../src/writer/resolve.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveDataRootFromArgs", () => {
  it("prefers the raw-dir positional's parent", async () => {
    const resolution = await resolveDataRootFromArgs(
      "/nowhere/sync.json",
      "/data/raw",
    );

    expect(resolution).toEqual({ dataRoot: "/data" });
  });

  it("reports the config's missing dataRoot as an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resolve-"));
    tempDirs.push(dir);
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    const resolution = await resolveDataRootFromArgs(configPath, undefined);

    expect(resolution).toMatchObject({
      error: expect.stringContaining("dataRoot"),
    });
  });

  it("reports an unreadable config as an error", async () => {
    const resolution = await resolveDataRootFromArgs(
      "/nowhere/sync.json",
      undefined,
    );

    expect(resolution.error).toBeDefined();
  });
});
