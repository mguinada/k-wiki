import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import { runSharedCycle } from "../../src/writer/coordinator.ts";
import { gitRunnerFor } from "../../src/writer/git-remote.ts";
import { observeLeaseOid } from "../../src/writer/lease.ts";
import {
  type CoordWorld,
  enabledDataRepo,
  HOLDER,
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

/** A recording runner that counts synthetic lease commits. */
function countingRunner(dataRoot: string): {
  git: ReturnType<typeof gitRunnerFor>;
  count: () => number;
} {
  const real = gitRunnerFor({ dir: dataRoot, env: process.env });
  let leaseCommits = 0;

  return {
    git: async (args) => {
      if (args[0] === "commit-tree") {
        leaseCommits += 1;
      }

      return await real(args);
    },
    count: () => leaseCommits,
  };
}

describe("leasedCycle renewals", () => {
  it("renews the lease around the cycle's stages before releasing (no-op)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { git, count } = countingRunner(cw.dataRoot);

    const outcome = await runSharedCycle({ ...options(cw), git });

    expect(outcome.status).toBe("completed");

    // One create + at least two renewals (before stages, at the
    // agent-stage boundary) = at least three synthetic commits.
    expect(count()).toBeGreaterThanOrEqual(3);
  }, 30000);

  it("runs the sweep hook inside the lease tenure, before the cycle", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const order: string[] = [];
    const real = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    const outcome = await runSharedCycle({
      ...options(cw),
      runSweep: async () => {
        order.push("sweep");

        // The lease is still held while the sweep runs.
        order.push(
          (await observeLeaseOid(real, "origin", LEASE_REF)) === undefined
            ? "unleased"
            : "leased",
        );
      },
    });

    expect(outcome.status).toBe("completed");
    expect(order).toEqual(["sweep", "leased"]);
  }, 30000);
});

describe("gate refusal inside the tenure", () => {
  it("releases the lease cleanly when removals need a receipt", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }
    const { mkdir, writeFile: wf, rm } = await import("node:fs/promises");

    // One canonical source note and its manifest entry, committed;
    // then the note vanishes from the vault — the planner's
    // candidate removal.
    await mkdir(join(vault.root, "sub"), { recursive: true });
    await wf(join(vault.root, "sub", "gone.md"), "gone\n");
    await mkdir(join(cw.dataRoot, "raw", "notes", vault.name, "sub"), {
      recursive: true,
    });
    await wf(
      join(cw.dataRoot, "raw", "notes", vault.name, "sub", "gone.md"),
      "gone\n",
    );
    await wf(
      join(cw.dataRoot, "raw", "manifest.json"),
      `${JSON.stringify(
        {
          vaults: {
            [vault.name]: {
              "sub/gone.md": {
                hash: "0".repeat(64),
                last_synced: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await world.a.git(["add", "-A"]);
    await world.a.git(["commit", "-m", "canonical note"]);
    await world.a.git([
      "push",
      "-q",
      "origin",
      "refs/heads/main:refs/heads/main",
    ]);

    // The source note disappears (the iCloud-shaped hazard).
    await rm(join(vault.root, "sub"), { recursive: true, force: true });

    const outcome = await runSharedCycle(options(cw));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("--removal-receipt"),
    });
    expect((outcome as { reason: string }).reason).toContain("sub/gone.md");

    // The refusal was a clean pre-write failure: the lease is gone.
    expect(
      await observeLeaseOid(gitOf(cw), "origin", LEASE_REF),
    ).toBeUndefined();
  }, 30000);

  it("refuses a stale namespace's expunge like a source removal", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }
    const { mkdir, writeFile: wf } = await import("node:fs/promises");

    // A namespace the config no longer lists, present in the canonical
    // manifest and on disk — the expunge the cycle's prune would apply.
    await mkdir(join(cw.dataRoot, "raw", "notes", "Retired"), {
      recursive: true,
    });
    await wf(join(cw.dataRoot, "raw", "notes", "Retired", "Old.md"), "# old\n");
    await wf(
      join(cw.dataRoot, "raw", "manifest.json"),
      `${JSON.stringify(
        {
          vaults: {
            Retired: {
              "Old.md": {
                hash: "0".repeat(64),
                last_synced: "2026-01-01T00:00:00.000Z",
              },
            },
            [vault.name]: {},
          },
        },
        null,
        2,
      )}\n`,
    );
    await world.a.git(["add", "-A"]);
    await world.a.git(["commit", "-m", "canonical stale namespace"]);
    await world.a.git([
      "push",
      "-q",
      "origin",
      "refs/heads/main:refs/heads/main",
    ]);

    const outcome = await runSharedCycle(options(cw));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("--removal-receipt"),
    });
    expect((outcome as { reason: string }).reason).toContain("Retired/Old.md");

    // The refusal was a clean pre-write failure: the lease is gone.
    expect(
      await observeLeaseOid(gitOf(cw), "origin", LEASE_REF),
    ).toBeUndefined();
  }, 30000);
});

describe("post-commit failure inside the tenure", () => {
  it("retains the lease once the content commit exists", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }
    const { mkdir, writeFile: wf } = await import("node:fs/promises");

    // One new vault note: the sync stage projects it, so the cycle
    // makes a content commit.
    await mkdir(join(vault.root, "Inbox"), { recursive: true });
    await wf(
      join(vault.root, "Inbox", "post-commit-note.md"),
      "---\ntitle: Post commit\n---\n\ncontent\n",
    );

    // A publish mirror whose parent is a file: publish fails after
    // the commit exists, on a clean tree.
    const blocker = join(cw.scratch, "blocker");
    await wf(blocker, "not a directory\n");

    await expect(
      runSharedCycle({
        ...options(cw),
        config: {
          ...cw.config,
          publish: {
            mirror: join(blocker, "mirror"),
            include: ["**/*.md"],
            root: undefined,
          },
        },
      }),
    ).rejects.toThrow();

    // The failure came after the content commit: the lease stays
    // held for recovery — manual push or takeover — never released
    // with the commit stranded.
    expect(await observeLeaseOid(gitOf(cw), "origin", LEASE_REF)).toBeDefined();
  }, 30000);
});

function options(cw: CoordWorld) {
  return {
    run: runContext({
      rawDir: join(cw.dataRoot, "raw"),
      env: process.env,
      now: NOW,
      onProgress: () => {},
    }),
    config: cw.config,
    configPath: cw.configPath,
    settingsPath: cw.settingsPath,
    outputsDir: join(cw.scratch, "outputs"),
    promptsDir: join(cw.scratch, "prompts"),
    holder: HOLDER,
  };
}

function gitOf(cw: CoordWorld) {
  return gitRunnerFor({ dir: cw.dataRoot, env: process.env });
}
