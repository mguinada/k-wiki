import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceEntries } from "../../src/writer/cycle-steps.ts";
import { observeLease } from "../../src/writer/lease.ts";
import { acquireLease } from "../../src/writer/lease-ops.ts";
import { readSharedWriterMarker } from "../../src/writer/marker.ts";
import {
  divergenceMessage,
  divergenceOf,
  evaluateSurface,
  readRecoveryRecord,
  recordDirtyFailureSurface,
  recoveryRecordPath,
  type SurfaceEvaluation,
  surfacePaths,
  writeRecord,
} from "../../src/writer/recovery-record.ts";
import {
  type CoordWorld,
  enabledDataRepo,
  LEASE_REF,
  NOW,
} from "./coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The enabled world with a live lease (held by writer-b) and a
 *  dirty fix surface on the data repo: one untracked file plus one
 *  untracked wiki page — the recorded-failure state. */
async function failedWorld(): Promise<{ world: WriterWorld; cw: CoordWorld }> {
  const world = await makeWriterWorld();
  worlds.push(world);
  const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

  await world.a.git(["fetch", "origin", "refs/heads/main"]);
  const attempt = await acquireLease({
    git: world.b.git,
    remote: "origin",
    leaseRef: LEASE_REF,
    treeOid: (await world.b.git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
    base: (await world.b.git(["rev-parse", "HEAD"])).stdout.trim(),
    now: NOW,
    holder: "failed-mac:9",
  });

  expect(attempt.status).toBe("acquired");

  await writeFile(join(cw.dataRoot, "wiki", "tracked.md"), "partial\n");
  await writeFile(join(cw.dataRoot, "untracked.md"), "partial\n");

  const marker = await markerOf(cw);

  await recordDirtyFailureSurface({ git: world.a.git, marker });

  return { world, cw };
}

async function markerOf(cw: CoordWorld) {
  const marker = await readSharedWriterMarker(cw.dataRoot);

  if (marker.kind !== "enabled") {
    throw new Error("setup: the world's marker must be enabled");
  }

  return marker.marker;
}

describe("recordDirtyFailureSurface", () => {
  it("records the dirty paths, sorted", async () => {
    const { world } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    expect(record?.paths).toEqual(["untracked.md", "wiki/tracked.md"]);
  });

  it("starts the refused-tick count at zero", async () => {
    const { world } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    expect(record?.refusedTicks).toBe(0);
  });

  it("stamps the record with a cycle id", async () => {
    const { world } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    expect(record?.cycleId).toEqual(expect.any(String));
  });

  it("binds the record to the live retained lease by OID", async () => {
    const { world, cw } = await failedWorld();
    const marker = await markerOf(cw);
    const record = await readRecoveryRecord(world.a.git);
    const live = await observeLease(
      world.a.git,
      marker.remote,
      marker.leaseRef,
    );

    expect(record?.lease?.oid).toBe(live?.oid);
  });

  it("names the recorded lease holder", async () => {
    const { world } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    expect(record?.lease?.holder).toBe("failed-mac:9");
  });

  it("records nothing on a clean tree", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await recordDirtyFailureSurface({
      git: world.a.git,
      marker: await markerOf(cw),
    });

    expect(await readRecoveryRecord(world.a.git)).toBeUndefined();
  });

  it("overwrites an existing record with the newest failure's paths", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "later.md"), "second failure\n");
    await recordDirtyFailureSurface({
      git: world.a.git,
      marker: await markerOf(cw),
    });

    const record = await readRecoveryRecord(world.a.git);

    expect(record?.paths).toEqual([
      "later.md",
      "untracked.md",
      "wiki/tracked.md",
    ]);
  });

  it("resets the tick count on the newest failure", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "later.md"), "second failure\n");
    await recordDirtyFailureSurface({
      git: world.a.git,
      marker: await markerOf(cw),
    });

    const record = await readRecoveryRecord(world.a.git);

    expect(record?.refusedTicks).toBe(0);
  });

  it("keeps the record invisible to git status", async () => {
    const { world } = await failedWorld();

    const paths = surfacePaths(await surfaceEntries(world.a.git));

    expect(
      paths.filter((path) => path.includes("recovery-fix-surface")),
    ).toEqual([]);
  });

  it("fails closed on a malformed record", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const path = await recoveryRecordPath(world.a.git);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{oops");

    await expect(readRecoveryRecord(world.a.git)).rejects.toThrow(
      /failing closed/,
    );
  });
});

describe("evaluateSurface", () => {
  it("finds no divergence while the surface is untouched", async () => {
    const { world, cw } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    if (record === undefined) {
      throw new Error("setup: the record must exist");
    }

    const evaluation = await evaluateSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      record,
    });

    expect(divergenceOf(evaluation)).toEqual([]);
  });

  it("names a path a human added after the failure", async () => {
    const { world, cw } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    if (record === undefined) {
      throw new Error("setup: the record must exist");
    }

    await writeFile(join(cw.dataRoot, "human-note.md"), "by hand\n");

    const evaluation = await evaluateSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      record,
    });

    expect(divergenceOf(evaluation)).toEqual(["human-note.md"]);
  });

  it("names a recorded path a human deleted", async () => {
    const { world, cw } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    if (record === undefined) {
      throw new Error("setup: the record must exist");
    }

    await rm(join(cw.dataRoot, "untracked.md"));

    const evaluation = await evaluateSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      record,
    });

    expect(divergenceOf(evaluation)).toEqual(["untracked.md"]);
  });

  it("names a recorded path a human re-edited (content hash moved)", async () => {
    const { world, cw } = await failedWorld();
    const record = await readRecoveryRecord(world.a.git);

    if (record === undefined) {
      throw new Error("setup: the record must exist");
    }

    await writeFile(join(cw.dataRoot, "wiki", "tracked.md"), "re-edited\n");

    const evaluation = await evaluateSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      record,
    });

    expect(divergenceOf(evaluation)).toEqual(["wiki/tracked.md"]);
  });
});

describe("divergenceMessage", () => {
  it("names the differing paths in one line", () => {
    expect(divergenceMessage(["a.md", "b.md"])).toContain("a.md, b.md");
  });
});

describe("divergenceOf", () => {
  it("sorts and deduplicates the divergence set", () => {
    const evaluation = {
      livePaths: [],
      missing: ["b.md"],
      reedited: ["a.md"],
      added: ["b.md", "c.md"],
      lease: undefined,
    } as SurfaceEvaluation;

    expect(divergenceOf(evaluation)).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("surfacePaths", () => {
  it("includes rename origins and sorts the set", () => {
    expect(
      surfacePaths([
        { path: "new.md", origin: "old.md" },
        { path: "zeta.md", origin: undefined },
        { path: "new.md", origin: undefined },
      ]),
    ).toEqual(["new.md", "old.md", "zeta.md"]);
  });
});

describe("recoveryRecordPath", () => {
  it("resolves under the data repo's git dir", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const gitDir = (
      await world.a.git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();

    expect(await recoveryRecordPath(world.a.git)).toBe(
      join(gitDir, "k-wiki", "recovery-fix-surface.json"),
    );
  });

  it("reads back a record written through the module (round trip)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await writeRecord(world.a.git, {
      cycleId: "cycle-1",
      recordedAt: NOW().toISOString(),
      paths: ["wiki/x.md"],
      hashes: { "wiki/x.md": "absent" },
      lease: null,
      refusedTicks: 2,
    });

    expect(await readRecoveryRecord(world.a.git)).toMatchObject({
      cycleId: "cycle-1",
      paths: ["wiki/x.md"],
      refusedTicks: 2,
      lease: null,
    });
  });
});
