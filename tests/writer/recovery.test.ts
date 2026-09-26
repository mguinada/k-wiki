import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceEntries } from "../../src/writer/cycle-steps.ts";
import { observeLease } from "../../src/writer/lease.ts";
import { acquireLease, replaceLease } from "../../src/writer/lease-ops.ts";
import { readSharedWriterMarker } from "../../src/writer/marker.ts";
import {
  AUTO_RECOVERY_REFUSED_TICKS,
  noteRefusedTick,
  recoverRecordedSurface,
} from "../../src/writer/recovery.ts";
import { readRecoveryRecord } from "../../src/writer/recovery-record.ts";
import {
  type CoordWorld,
  enabledDataRepo,
  LEASE_REF,
  NOW,
} from "./coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

/** Five hours after NOW — past the fixture lease's four-hour TTL
 *  (the fifteen-minute dead-man behavior is covered by the retake
 *  test's short-TTL assertion). */
const LATER = () => new Date("2026-01-01T05:00:00Z");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The enabled world with a live lease (held by writer-b) and a
 *  dirty fix surface on the data repo: one tracked edit (the seeded
 *  wiki/index.md) plus one untracked file — the recorded-failure
 *  state. */
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

  await writeFile(join(cw.dataRoot, "wiki", "index.md"), "edited\n");
  await writeFile(join(cw.dataRoot, "untracked.md"), "partial\n");

  const marker = await markerOf(cw);
  const { recordDirtyFailureSurface } = await import(
    "../../src/writer/recovery-record.ts"
  );

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

/** Read a file's text, undefined when absent. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The recorded world with two ticks already counted (the third
 *  tick is the recovery threshold). */
async function countedWorld(): Promise<{
  world: WriterWorld;
  cw: CoordWorld;
  hook: (now?: () => Date, log?: (line: string) => void) => Promise<boolean>;
}> {
  const { world, cw } = await failedWorld();
  const marker = await markerOf(cw);
  const hook = (
    now: () => Date = NOW,
    log: (line: string) => void = () => {},
  ) =>
    noteRefusedTick({
      git: world.a.git,
      marker,
      now,
      holder: "coord:1",
      log,
    });

  await hook();
  await hook();

  return { world, cw, hook };
}

describe("AUTO_RECOVERY_REFUSED_TICKS", () => {
  it("is the three-tick threshold the justification names", () => {
    expect(AUTO_RECOVERY_REFUSED_TICKS).toBe(3);
  });
});

describe("recoverRecordedSurface", () => {
  it("discards exactly the recorded paths", async () => {
    const { world, cw } = await failedWorld();

    const outcome = await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(outcome.discarded).toEqual(["untracked.md", "wiki/index.md"]);
  });

  it("restores a recorded tracked path to its HEAD state", async () => {
    const { world, cw } = await failedWorld();

    await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(await readText(join(cw.dataRoot, "wiki", "index.md"))).toBe(
      "# Index\n",
    );
  });

  it("removes a recorded untracked path", async () => {
    const { world, cw } = await failedWorld();

    await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(await readText(join(cw.dataRoot, "untracked.md"))).toBeUndefined();
  });

  it("leaves the allowed run lock untouched", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, ".scheduled-run.lock"), "pid\n");

    await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(await readText(join(cw.dataRoot, ".scheduled-run.lock"))).toBe(
      "pid\n",
    );
  });

  it("clears the record after a recovery", async () => {
    const { world, cw } = await failedWorld();

    await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(await readRecoveryRecord(world.a.git)).toBeUndefined();
  });

  it("replaces a live recorded lease with a fresh commit", async () => {
    const { world, cw } = await failedWorld();
    const marker = await markerOf(cw);
    const recorded = await observeLease(
      world.a.git,
      marker.remote,
      marker.leaseRef,
    );

    const outcome = await recoverRecordedSurface({
      git: world.a.git,
      marker,
      now: NOW,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(outcome.replacement?.oid).not.toBe(recorded?.oid);
  });

  it("shortens the retaken lease to the dead-man window", async () => {
    const { world, cw } = await failedWorld();

    const outcome = await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: NOW,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(outcome.replacement?.body.expires).toBe("2026-01-01T00:15:00.000Z");
  });

  it("holds the retaken lease for the recovering holder", async () => {
    const { world, cw } = await failedWorld();

    const outcome = await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: NOW,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(outcome.replacement?.body.holder).toBe("recover-mac:1");
  });

  it("leaves the lane free when the recorded lease was vacated", async () => {
    const { world, cw } = await failedWorld();
    const marker = await markerOf(cw);

    // The retained lease vanished (a fenced release): the recorded
    // OID no longer exists, the lane is free.
    await world.b.git(["push", "origin", `:${LEASE_REF}`]);

    const outcome = await recoverRecordedSurface({
      git: world.a.git,
      marker,
      now: NOW,
      holder: "recover-mac:1",
      retakeLease: true,
    });

    expect(outcome.replacement).toBeNull();
  });

  it("refuses when a human added a path after the failure", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    await expect(
      recoverRecordedSurface({
        git: world.a.git,
        marker: await markerOf(cw),
        now: LATER,
        holder: "recover-mac:1",
      }),
    ).rejects.toThrow(/human\.md/);
  });

  it("keeps the human's added path on a refused recovery", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
    }).catch(() => {});

    expect(await readText(join(cw.dataRoot, "human.md"))).toBe("by hand\n");
  });

  it("keeps the record on a refused recovery", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    await recoverRecordedSurface({
      git: world.a.git,
      marker: await markerOf(cw),
      now: LATER,
      holder: "recover-mac:1",
    }).catch(() => {});

    expect(await readRecoveryRecord(world.a.git)).toBeDefined();
  });

  it("refuses when a recorded path was re-edited after the failure", async () => {
    const { world, cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "wiki", "index.md"), "re-edited\n");

    await expect(
      recoverRecordedSurface({
        git: world.a.git,
        marker: await markerOf(cw),
        now: LATER,
        holder: "recover-mac:1",
      }),
    ).rejects.toThrow(/wiki\/index\.md/);
  });

  it("refuses when the recorded lease moved off its OID", async () => {
    const { world, cw } = await failedWorld();
    const marker = await markerOf(cw);

    // A foreign writer takes the lane: the recorded OID is gone.
    await world.b.git(["fetch", "origin", "refs/heads/main"]);
    const live = await observeLease(
      world.a.git,
      marker.remote,
      marker.leaseRef,
    );

    if (live === undefined) {
      throw new Error("setup: the recorded lease must be live");
    }

    await replaceLease({
      git: world.b.git,
      remote: marker.remote,
      leaseRef: marker.leaseRef,
      expectedOid: live.oid,
      previous: live.body,
      treeOid: (await world.b.git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: live.body.base,
      now: NOW,
      holder: "intervener:7",
    });

    await expect(
      recoverRecordedSurface({
        git: world.a.git,
        marker,
        now: LATER,
        holder: "recover-mac:1",
      }),
    ).rejects.toThrow(/someone intervened/);
  });

  it("defers while the retained lease is still live (requireExpired)", async () => {
    const { world, cw } = await failedWorld();

    await expect(
      recoverRecordedSurface({
        git: world.a.git,
        marker: await markerOf(cw),
        now: NOW,
        holder: "recover-mac:1",
        requireExpired: true,
      }),
    ).rejects.toThrow(/still live/);
  });

  it("refuses with nothing recorded", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await expect(
      recoverRecordedSurface({
        git: world.a.git,
        marker: await markerOf(cw),
        now: NOW,
        holder: "recover-mac:1",
      }),
    ).rejects.toThrow(/nothing to recover/);
  });
});

describe("noteRefusedTick", () => {
  it("is quiet without a record", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    expect(
      await noteRefusedTick({
        git: world.a.git,
        marker: await markerOf(cw),
        now: NOW,
        holder: "coord:1",
        log: () => {},
      }),
    ).toBe(false);
  });

  it("counts the first two refused ticks", async () => {
    const { world } = await countedWorld();

    expect((await readRecoveryRecord(world.a.git))?.refusedTicks).toBe(2);
  });

  it("recovers on the third tick past the dead-man window", async () => {
    const { hook } = await countedWorld();

    expect(await hook(LATER)).toBe(true);
  });

  it("clears the record after the auto-recovery", async () => {
    const { world, hook } = await countedWorld();

    await hook(LATER);

    expect(await readRecoveryRecord(world.a.git)).toBeUndefined();
  });

  it("leaves the tree clean after the auto-recovery", async () => {
    const { world, hook } = await countedWorld();

    await hook(LATER);

    expect(await surfaceEntries(world.a.git)).toEqual([]);
  });

  it("keeps counting while the retained lease is live", async () => {
    const { world, hook } = await countedWorld();

    await hook();

    expect((await readRecoveryRecord(world.a.git))?.refusedTicks).toBe(3);
  });

  it("leaves the surface untouched while the lease is live", async () => {
    const { cw, hook } = await countedWorld();

    await hook();

    expect(await readText(join(cw.dataRoot, "untracked.md"))).toBe("partial\n");
  });

  it("reports no recovery on a diverged surface", async () => {
    const { cw, hook } = await countedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    expect(await hook(LATER)).toBe(false);
  });

  it("escalates an ALERT on a diverged surface", async () => {
    const { cw, hook } = await countedWorld();
    const lines: string[] = [];

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");
    await hook(LATER, (line) => lines.push(line));

    expect(lines.join("\n")).toContain("ALERT");
  });

  it("names the mismatched paths in the ALERT", async () => {
    const { cw, hook } = await countedWorld();
    const lines: string[] = [];

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");
    await hook(LATER, (line) => lines.push(line));

    expect(lines.join("\n")).toContain("human.md");
  });

  it("marks the record auto-disabled on a diverged surface", async () => {
    const { world, cw, hook } = await countedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");
    await hook(LATER);

    expect((await readRecoveryRecord(world.a.git))?.autoDisabled).toBe(true);
  });

  it("stays quiet on later ticks after the abort", async () => {
    const { cw, hook } = await countedWorld();
    const lines: string[] = [];

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");
    await hook(LATER);

    await hook(LATER, (line) => lines.push(line));

    expect(lines).toEqual([]);
  });

  it("never eats the human edit after the abort", async () => {
    const { cw, hook } = await countedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");
    await hook(LATER);
    await hook(LATER);

    expect(await readText(join(cw.dataRoot, "human.md"))).toBe("by hand\n");
  });

  it("reports no recovery when the surface resolved itself", async () => {
    const { world, cw, hook } = await countedWorld();

    await world.a.git([
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      "wiki/index.md",
    ]);
    await rm(join(cw.dataRoot, "untracked.md"));

    expect(await hook(LATER)).toBe(false);
  });

  it("clears a stale record quietly when the surface resolved itself", async () => {
    const { world, cw, hook } = await countedWorld();

    await world.a.git([
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      "wiki/index.md",
    ]);
    await rm(join(cw.dataRoot, "untracked.md"));
    await hook(LATER);

    expect(await readRecoveryRecord(world.a.git)).toBeUndefined();
  });
});
