import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRunOptions } from "../../src/schedule/scheduled-run.ts";
import { parseScheduledRunArgs } from "../../src/schedule/scheduled-run.ts";
import {
  runSharedPipeline,
  scheduledSharedMode,
} from "../../src/schedule/shared-cycle.ts";
import {
  type CoordWorld,
  enabledDataRepo,
} from "../writer/coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "../writer/git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function optionsFor(cw: CoordWorld): ScheduledRunOptions {
  return {
    dataRoot: cw.dataRoot,
    repoRoot: cw.scratch,
    lockPath: join(cw.dataRoot, ".scheduled-run.lock"),
    // Explicit instance arguments — never the repo's own sync.json.
    args: [cw.configPath, join(cw.dataRoot, "raw")],
  };
}

describe("scheduledSharedMode", () => {
  it("detects an enabled marker", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    expect(await scheduledSharedMode(optionsFor(cw))).toBe(true);
  });

  it("reports not-enabled without a marker", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { rm: rmDir } = await import("node:fs/promises");

    await rmDir(join(cw.dataRoot, ".k-wiki"), { recursive: true, force: true });

    expect(await scheduledSharedMode(optionsFor(cw))).toBe(false);
  });

  it("fails loud on a malformed marker (fail closed)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { writeFile } = await import("node:fs/promises");

    await writeFile(join(cw.dataRoot, ".k-wiki", "shared-writer.json"), "{");

    await expect(scheduledSharedMode(optionsFor(cw))).rejects.toThrow(
      /failing closed/,
    );
  });
});

describe("runSharedPipeline", () => {
  it("delegates the cycle to the coordinator and completes a no-op run", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const logs: string[] = [];

    await runSharedPipeline(optionsFor(cw), (line) => logs.push(line));

    expect(logs.join("\n")).toContain("delegating to the coordinator");
  }, 30000);

  it("surfaces a coordinator refusal as a thrown error", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { writeFile } = await import("node:fs/promises");

    // A dirty tree trips the coordinator's precondition refusal.
    await writeFile(join(cw.dataRoot, "junk.md"), "junk\n");

    await expect(runSharedPipeline(optionsFor(cw), () => {})).rejects.toThrow(
      /dirty/,
    );
  }, 30000);
});

describe("scheduled-run flag surface (issue #390 steering repair 2)", () => {
  it("rejects --removal-receipt as an unknown flag before any cycle work", () => {
    const parsed = parseScheduledRunArgs([
      "--removal-receipt",
      "/tmp/receipt.json",
      "sync.json",
      "raw",
    ]);

    expect(parsed.error).toMatch(/--removal-receipt/);
  });

  it("keeps accepting the forwarding flags scheduled-run owns", () => {
    const parsed = parseScheduledRunArgs([
      "--settings",
      "s.yml",
      "--lint-full",
    ]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.flags.has("--lint-full")).toBe(true);
  });
});
