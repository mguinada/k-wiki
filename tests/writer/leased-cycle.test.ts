import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import { runSharedCycle } from "../../src/writer/coordinator.ts";
import { gitRunnerFor } from "../../src/writer/git-remote.ts";
import { observeLeaseOid } from "../../src/writer/lease.ts";
import type { SharedCycleOutcome } from "../../src/writer/options.ts";
import {
  type CoordWorld,
  enabledDataRepo,
  HOLDER,
  LEASE_REF,
  NOW,
} from "./coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const repoRootGuess = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
  it("completes a no-op leased cycle", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { git } = countingRunner(cw.dataRoot);

    const outcome = await runSharedCycle({ ...options(cw), git });

    expect(outcome.status).toBe("completed");
  }, 30000);

  it("renews the lease around the cycle's stages", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { git, count } = countingRunner(cw.dataRoot);

    await runSharedCycle({ ...options(cw), git });

    expect(count()).toBeGreaterThanOrEqual(3);
  }, 30000);

  it("completes the leased cycle", async () => {
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
  }, 30000);

  it("runs the sweep hook inside the lease tenure", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const order: string[] = [];

    const real = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await runSharedCycle({
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

    expect(order).toEqual(["sweep", "leased"]);
  }, 30000);
});

describe("gate refusal inside the tenure", () => {
  it("refuses a removal without a receipt", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf, rm } = await import("node:fs/promises");

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

    await rm(join(vault.root, "sub"), { recursive: true, force: true });

    const outcome = await runSharedCycle(options(cw));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("--removal-receipt"),
    });
  }, 30000);

  it("names the removed path in the refusal", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf, rm } = await import("node:fs/promises");

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

    await rm(join(vault.root, "sub"), { recursive: true, force: true });

    const outcome = await runSharedCycle(options(cw));

    expect((outcome as { reason: string }).reason).toContain("sub/gone.md");
  }, 30000);

  it("releases the lease on the removal-receipt refusal", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf, rm } = await import("node:fs/promises");

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

    await rm(join(vault.root, "sub"), { recursive: true, force: true });

    await runSharedCycle(options(cw));

    expect(
      await observeLeaseOid(gitOf(cw), "origin", LEASE_REF),
    ).toBeUndefined();
  }, 30000);

  it("refuses a stale namespace's expunge", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf } = await import("node:fs/promises");

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
  }, 30000);

  it("names the stale namespace in the refusal", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf } = await import("node:fs/promises");

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

    expect((outcome as { reason: string }).reason).toContain("Retired/Old.md");
  }, 30000);

  it("releases the lease on the stale-namespace refusal", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf } = await import("node:fs/promises");

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

    await runSharedCycle(options(cw));

    expect(
      await observeLeaseOid(gitOf(cw), "origin", LEASE_REF),
    ).toBeUndefined();
  }, 30000);
});

describe("post-commit failure inside the tenure", () => {
  it("runs the content commit", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf } = await import("node:fs/promises");

    await mkdir(join(vault.root, "Inbox"), { recursive: true });

    await wf(
      join(vault.root, "Inbox", "post-commit-note.md"),
      "---\ntitle: Post commit\n---\n\ncontent\n",
    );

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
  }, 30000);

  it("retains the lease once the content commit exists", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    const { mkdir, writeFile: wf } = await import("node:fs/promises");

    await mkdir(join(vault.root, "Inbox"), { recursive: true });

    await wf(
      join(vault.root, "Inbox", "post-commit-note.md"),
      "---\ntitle: Post commit\n---\n\ncontent\n",
    );

    const blocker = join(cw.scratch, "blocker");

    await wf(blocker, "not a directory\n");

    await runSharedCycle({
      ...options(cw),
      config: {
        ...cw.config,
        publish: {
          mirror: join(blocker, "mirror"),
          include: ["**/*.md"],
          root: undefined,
        },
      },
    }).catch(() => undefined);

    expect(await observeLeaseOid(gitOf(cw), "origin", LEASE_REF)).toBeDefined();
  }, 30000);
});

describe("hostile fetch mid-tenure (issue #464)", () => {
  const CANONICAL_REF = "refs/k-wiki/canonical/shared-writer-v1";

  type Sabotage = "empty" | "remove" | "lease-line";

  /** A delegating runner that tramples the shared fetch-head file
   *  after the fetch it should have served for neighboring reads:
   *  empty (a zero-match fetch's effect), removed (an interrupted
   *  fetch's), and rewritten-as-lease-line (a concurrent
   *  observation's), the three incident-shape states. */
  function sabotagingRunner(
    dataRoot: string,
    mode: Sabotage,
    leaseLineOid?: string,
  ): {
    git: (
      args: readonly string[],
    ) => Promise<{ stdout: string; stderr: string }>;
    progress: string[];
  } {
    const real = gitRunnerFor({ dir: dataRoot, env: process.env });
    const progress: string[] = [];
    let gitDir: string | undefined;

    return {
      progress,
      git: async (args) => {
        const result = await real(args);

        if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
          gitDir = result.stdout.trim();
        }

        if (
          args[0] === "fetch" &&
          args[2] !== undefined &&
          String(args[2]).endsWith(CANONICAL_REF) &&
          gitDir !== undefined
        ) {
          const { writeFile, rm } = await import("node:fs/promises");
          const path = join(gitDir, "FETCH_HEAD");

          if (mode === "empty") {
            await writeFile(path, "");
          } else if (mode === "remove") {
            await rm(path, { force: true });
          } else if (leaseLineOid !== undefined) {
            await writeFile(
              path,
              `${leaseLineOid}\trefs/k-wiki/leases/shared-writer-v1\n`,
            );
          }
        }

        return result;
      },
    };
  }

  const SABOTAGE_MODES = ["empty", "remove", "lease-line"] as const;

  /** One sabotage world, run once per mode describe: the no-op leased
   *  cycle with its progress lines and post-run lease state shared by
   *  that describe's aspect tests. */
  interface SabotageRun {
    readonly world: WriterWorld;
    readonly cw: CoordWorld;
    readonly outcome: SharedCycleOutcome;
    readonly leaseAfter: string | undefined;
    readonly progress: readonly string[];
  }

  for (const mode of SABOTAGE_MODES) {
    describe(`with FETCH_HEAD ${mode}`, () => {
      let run: SabotageRun;

      beforeAll(async () => {
        const world = await makeWriterWorld();
        const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
        const { git, progress } = sabotagingRunner(
          cw.dataRoot,
          mode,
          "0".repeat(40),
        );

        const outcome = await runSharedCycle({
          ...options(cw),
          run: {
            ...options(cw).run,
            onProgress: (line: string) => progress.push(line),
          },
          git,
        });
        const leaseAfter = await observeLeaseOid(
          gitOf(cw),
          "origin",
          LEASE_REF,
        );

        run = { world, cw, outcome, leaseAfter, progress };
      }, 30000);

      afterAll(async () => {
        await run.world.cleanup();
      });

      it("completes the cycle", () => {
        expect(run.outcome.status).toBe("completed");
      });

      it("releases the lease", () => {
        expect(run.leaseAfter).toBeUndefined();
      });

      it("reports the renew maintenance step", () => {
        expect(
          run.progress.find((line) => line.includes("lease maintenance renew")),
        ).toBeDefined();
      });

      it("reports the release maintenance step", () => {
        expect(
          run.progress.find((line) =>
            line.includes("lease maintenance release"),
          ),
        ).toBeDefined();
      });

      it("renders the fetch-head state as {exists, size} only", () => {
        expect(
          run.progress.find((line) =>
            line.match(/FETCH_HEAD \{exists: (true|false), size: \d+\}/),
          ),
        ).toBeDefined();
      });

      it("never surfaces the torn fetch-head read's failure text", () => {
        expect(
          run.progress.some((line) =>
            line.includes("Needed a single revision"),
          ),
        ).toBe(false);
      });

      it("leaks no child stderr fragments into the lines", () => {
        expect(run.progress.some((line) => line.includes("fatal:"))).toBe(
          false,
        );
      });
    });
  }

  it("keeps the lease body's canonical tree OID under sabotage", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { git } = sabotagingRunner(cw.dataRoot, "empty");
    const real = gitRunnerFor({ dir: cw.dataRoot, env: process.env });
    let leaseTree: string | undefined;
    let headTree: string | undefined;

    await runSharedCycle({
      ...options(cw),
      git,
      runSweep: async () => {
        await real([
          "fetch",
          "--force",
          "origin",
          `${LEASE_REF}:refs/k-wiki/lease-observed`,
        ]);

        leaseTree = (
          await real(["rev-parse", "refs/k-wiki/lease-observed^{tree}"])
        ).stdout.trim();
        headTree = (await real(["rev-parse", "HEAD^{tree}"])).stdout.trim();
      },
    });

    expect(leaseTree).toBe(headTree);
  }, 30000);

  describe("finalize-phase retention under sabotage", () => {
    const CANONICAL_REF = "refs/k-wiki/canonical/shared-writer-v1";

    let cw: CoordWorld;
    let world: WriterWorld | undefined;
    let error: unknown;
    let progress: readonly string[];

    beforeAll(async () => {
      world = await makeWriterWorld();
      cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

      const { mkdir, writeFile: wf, cp } = await import("node:fs/promises");

      // The unit world's promptsDir starts empty; the ingest stage
      // only gets past the agent stage with the real prompt templates.
      await cp(join(repoRootGuess, "prompts"), join(cw.scratch, "prompts"), {
        recursive: true,
      });

      const vault = cw.config.vaults[0];

      if (vault === undefined) {
        throw new Error("setup: the world has no vault");
      }

      await mkdir(join(vault.root, "Inbox"), { recursive: true });

      await wf(
        join(vault.root, "Inbox", "post-commit-note.md"),
        "---\ntitle: Post commit\n---\n\ncontent\n",
      );

      const blocker = join(cw.scratch, "blocker");

      await wf(blocker, "not a directory\n");

      const real = gitRunnerFor({ dir: cw.dataRoot, env: process.env });
      const lines: string[] = [];
      // Sabotage after the last lease CAS push is out (the fixed
      // world: one acquire, one before-the-stages renewal, four
      // agent-boundary renewals): the canonical ref and FETCH_HEAD
      // die before the retention's tree read — yesterday's failure
      // mode. wiki-sync's own commits bypass the injected runner, so
      // the push count is the observable trigger.
      let pushes = 0;
      const git: (
        args: readonly string[],
      ) => Promise<{ stdout: string; stderr: string }> = async (args) => {
        const result = await real(args);

        if (args[0] === "push") {
          pushes += 1;
        }

        if (args[0] === "push" && pushes === 6) {
          const gitDir = (
            await real(["rev-parse", "--absolute-git-dir"])
          ).stdout.trim();
          const { writeFile, rm } = await import("node:fs/promises");

          await rm(join(gitDir, CANONICAL_REF), { force: true });
          await writeFile(join(gitDir, "FETCH_HEAD"), "");
        }

        return result;
      };

      error = await runSharedCycle({
        ...options(cw),
        config: {
          ...cw.config,
          publish: {
            mirror: join(blocker, "mirror"),
            include: ["**/*.md"],
            root: undefined,
          },
        },
        run: {
          ...options(cw).run,
          onProgress: (line: string) => lines.push(line),
        },
        git,
      }).catch((e: unknown) => e);

      progress = lines;
    }, 120000);

    it("throws the original stage error, not the torn tree read's", () => {
      expect((error as Error).message).not.toContain(
        "Needed a single revision",
      );
    });

    it("retains the lease through finalization failure", () => {
      expect(
        progress.find((line) =>
          line.includes(
            "cycle failed during finalization — retained lease expires",
          ),
        ),
      ).toBeDefined();
    });

    it("names the degraded tree read in the retain line", () => {
      expect(progress.some((line) => line.includes("tree read degraded"))).toBe(
        true,
      );
    });

    it("suppresses the unreachable shorten-failed text", () => {
      expect(
        progress.some((line) =>
          line.includes("failed to shorten retained lease"),
        ),
      ).toBe(false);
    });

    it("leaves the retained lease live for recovery", async () => {
      expect(
        await observeLeaseOid(gitOf(cw), "origin", LEASE_REF),
      ).toBeDefined();
    });

    afterAll(async () => {
      await world?.cleanup();
    });
  });
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
