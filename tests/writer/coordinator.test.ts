/**
 * The shared-writer coordinator against a real two-clone world and a
 * local bare remote (issue #390): precondition refusals before any
 * mutation, the no-op cycle's conditional lease release, the fresh-
 * clone snapshot bootstrap, fail-closed marker and lease handling,
 * and the ambiguous-finalize recovery. The full agent-bearing cycle
 * lives in the e2e suite.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import { runSharedCycle } from "../../src/writer/coordinator.ts";
import { gitRunnerFor, lsRemoteOid } from "../../src/writer/git-remote.ts";
import {
  type ObservedLease,
  observeLease,
  observeLeaseOid,
} from "../../src/writer/lease.ts";
import {
  acquireLease,
  fetchedTreeOid,
  replaceLease,
} from "../../src/writer/lease-ops.ts";
import {
  enabledDataRepo,
  LEASE_REF,
  NOW,
  optionsFor,
} from "./coordinator-world.ts";
import {
  commitFile,
  makeWriterWorld,
  remoteHost,
  type WriterWorld,
} from "./git-world.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const worlds: WriterWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

describe("precondition refusals (before any source scan)", () => {
  it("refuses a dirty tree, naming the offending path", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await writeFile(join(dataRoot, "wiki", "junk.md"), "junk\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("dirty"),
    });
    expect((outcome as { reason: string }).reason).toContain("junk.md");
  });

  it("refuses a locally-ahead checkout without pushing anything", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await commitFile(world.a, "unshared.txt", "unshared\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("ahead"),
    });

    // The remote never saw the unshared commit.
    expect(
      await lsRemoteOid(world.a.git, "origin", "refs/heads/main"),
    ).not.toBe(await commitOid(world.a));
  });

  it("refuses a diverged checkout", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    // Someone else advances origin; writer-a commits locally too.
    await world.b.git(["fetch", "-q", "origin", "refs/heads/main"]);
    await world.b.git(["reset", "-q", "--hard", "origin/main"]);
    await commitFile(world.b, "remote.txt", "remote\n");
    await world.b.git([
      "push",
      "-q",
      "origin",
      "refs/heads/main:refs/heads/main",
    ]);
    await commitFile(world.a, "local.txt", "local\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("diverged"),
    });
  });

  it("refuses a checkout on the wrong branch", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await world.a.git(["checkout", "-q", "-b", "feature"]);

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("main"),
    });
  });
});

describe("lease refusal", () => {
  it("refuses while another writer holds a live lease, naming holder and expiry (test 1)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await world.a.git(["fetch", "origin", "refs/heads/main"]);
    const attempt = await acquireLease({
      git: world.b.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: await fetchedTreeOid(world.b.git),
      base: "b".repeat(40),
      now: NOW,
      holder: "other-mac:99",
    });

    expect(attempt.status).toBe("acquired");

    const error = await runSharedCycle(optionsFor(cw, dataRoot)).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("other-mac:99");
    expect((error as Error).message).toContain("2026-01-01T04:00:00.000Z");
  });
});

describe("no-op cycle under lease", () => {
  it("completes, releases the exact lease, and advances nothing", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const before = await commitOid(world.a);

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome.status).toBe("completed");

    const remote = gitRunnerFor(remoteHost(world.remoteDir));

    expect((await remote(["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(
      before,
    );
    expect((await remote(["for-each-ref", "refs/k-wiki/"])).stdout.trim()).toBe(
      "",
    );
  }, 30000);

  it("bootstraps the snapshot from the canonical tree on a fresh clone (test 3)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    // A fresh clone with no per-machine state.
    const dirC = join(world.remoteDir, "..", "writer-c");
    await run("git", ["clone", "-q", world.remoteDir, dirC]);
    await run("git", ["config", "user.email", "t@t"], { cwd: dirC });
    await run("git", ["config", "user.name", "t"], { cwd: dirC });

    const outcome = await runSharedCycle(optionsFor(cw, dirC));

    expect(outcome.status).toBe("completed");

    const snapshot = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dirC, "outputs", "last-ingested-manifest.json"), "utf8"),
    );
    const parsed = JSON.parse(snapshot) as {
      snapshotFor: string;
      committedHead: string;
    };

    expect(parsed.snapshotFor).toBe(dirC);
    expect(parsed.committedHead).toBe(await commitOid(world.a));
  }, 30000);
});

describe("fail-closed states", () => {
  it("throws on a malformed marker before any source scan", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await writeFile(join(dataRoot, ".k-wiki", "shared-writer.json"), "{oops");

    const error = await runSharedCycle(optionsFor(cw, dataRoot)).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("failing closed");
  });

  it("still observes a lease a default fetch cannot see (test 13)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await world.a.git(["fetch", "origin", "refs/heads/main"]);
    const attempt = await acquireLease({
      git: world.b.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: await fetchedTreeOid(world.b.git),
      base: "b".repeat(40),
      now: NOW,
      holder: "sneaky:1",
    });

    expect(attempt.status).toBe("acquired");

    // The default fetch brings nothing from refs/k-wiki/.
    await world.a.git(["fetch", "origin"]);

    const error = await runSharedCycle(optionsFor(cw, dataRoot)).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("sneaky:1");
  });
});

describe("failure-rule lease retention", () => {
  it("shortens a retained lease to fifteen minutes when a mid-run failure leaves a dirty surface", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];

    const before = await observeLeaseOid(world.a.git, "origin", LEASE_REF);

    expect(before).toBeUndefined();

    const error = await runSharedCycle(
      optionsFor(cw, dataRoot, {
        run: runContext({
          rawDir: join(dataRoot, "raw"),
          env: process.env,
          now: NOW,
          onProgress: (line: string) => progress.push(line),
        }),
        runSweep: async () => {
          await writeFile(join(dataRoot, "raw", "stray.md"), "partial\n");
          throw new Error("agent stage blew up");
        },
      }),
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("agent stage blew up");

    // The lease is retained, but short: ~15 minutes, not the 4-hour TTL.
    const lease = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(lease).toBeDefined();
    expect(lease?.body.expires).toBe("2026-01-01T00:15:00.000Z");

    // The retained log line names the shortened expiry.
    expect(
      progress.find((line) => line.includes("retained lease expires")),
    ).toContain("2026-01-01T00:15:00.000Z");
  }, 30000);

  it("replaces the retained lease by exact OID, continuing the acquired token", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];
    let observedMidRun: ObservedLease | undefined;

    const error = await runSharedCycle(
      optionsFor(cw, dataRoot, {
        run: runContext({
          rawDir: join(dataRoot, "raw"),
          env: process.env,
          now: NOW,
          onProgress: (line: string) => progress.push(line),
        }),
        runSweep: async () => {
          await writeFile(join(dataRoot, "raw", "stray.md"), "partial\n");
          observedMidRun = await observeLease(world.a.git, "origin", LEASE_REF);
          throw new Error("agent stage blew up");
        },
      }),
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("agent stage blew up");

    const acquired = progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    expect(observedMidRun).toBeDefined();

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(acquired).not.toBeNull();
    expect(retained).toBeDefined();

    // The ref moved off the observed lease commit and off the
    // acquired one, yet kept the token and the renewal sequence —
    // a CAS replacement, never release-then-re-acquire.
    expect(retained?.oid).not.toBe(observedMidRun?.oid);
    expect(retained?.oid.slice(0, 8)).not.toBe(acquired?.[1]);
    expect(retained?.body.token).toBe(observedMidRun?.body.token);
    expect(retained?.body.renewals).toBe(
      (observedMidRun?.body.renewals ?? 0) + 1,
    );
    expect(retained?.body.expires).toBe("2026-01-01T00:15:00.000Z");
  }, 30000);

  it("shortens the retained lease when the cycle fails during finalization", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

    // One new vault note: the sync stage projects it, so the cycle
    // makes a content commit and enters the finalize phase. The
    // stub prompts let the ingest agent stage complete.
    await mkdir(join(vault.root, "Inbox"), { recursive: true });
    await writeFile(
      join(vault.root, "Inbox", "finalize-failure-note.md"),
      "---\ntitle: Finalize failure\n---\n\ncontent\n",
    );
    await mkdir(join(cw.scratch, "prompts"), { recursive: true });
    await writeFile(join(cw.scratch, "prompts", "ingest.md"), "FULL PROMPT");
    await writeFile(
      join(cw.scratch, "prompts", "incremental.md"),
      "INCREMENTAL PROMPT",
    );
    await writeFile(join(cw.scratch, "prompts", "lint.md"), "LINT PROMPT");

    // A publish mirror whose parent is a file: publish fails after
    // the content commit exists, on a clean tree.
    const blocker = join(cw.scratch, "blocker");
    await writeFile(blocker, "not a directory\n");

    const progress: string[] = [];

    await expect(
      runSharedCycle(
        optionsFor(cw, dataRoot, {
          config: {
            ...cw.config,
            publish: {
              mirror: join(blocker, "mirror"),
              include: ["**/*.md"],
              root: undefined,
            },
          },
          run: runContext({
            rawDir: join(dataRoot, "raw"),
            env: process.env,
            now: NOW,
            onProgress: (line: string) => progress.push(line),
          }),
        }),
      ),
    ).rejects.toThrow();

    // The finalize-phase retention also shortens: the full-TTL lease
    // became the fifteen-minute dead-man window, not a release.
    const lease = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(lease).toBeDefined();
    expect(lease?.body.expires).toBe("2026-01-01T00:15:00.000Z");
    expect(
      progress.find((line) =>
        line.includes("cycle failed during finalization"),
      ),
    ).toContain("2026-01-01T00:15:00.000Z");
  }, 30000);

  it("leaves no lease when the failure precedes acquisition", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await writeFile(join(dataRoot, "wiki", "junk.md"), "junk\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome).toMatchObject({ status: "refused" });
    expect(
      await observeLeaseOid(world.a.git, "origin", LEASE_REF),
    ).toBeUndefined();
  });

  it("logs a lost retention race and never masks the original error", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];
    let foreignOid = "";

    const error = await runSharedCycle(
      optionsFor(cw, dataRoot, {
        run: runContext({
          rawDir: join(dataRoot, "raw"),
          env: process.env,
          now: NOW,
          onProgress: (line: string) => progress.push(line),
        }),
        runSweep: async () => {
          await writeFile(join(dataRoot, "raw", "stray.md"), "partial\n");
          const live = await observeLease(world.a.git, "origin", LEASE_REF);

          if (live === undefined) {
            throw new Error("setup: the lease vanished mid-run");
          }

          // A foreign writer CAS-replaces the live lease out from
          // under the session: the retention push must lose its
          // exact-OID race.
          const foreign = await replaceLease({
            git: world.b.git,
            remote: "origin",
            leaseRef: LEASE_REF,
            expectedOid: live.oid,
            previous: live.body,
            treeOid: await fetchedTreeOid(world.b.git),
            base: live.body.base,
            now: NOW,
            holder: "foreign:9",
          });
          foreignOid = foreign.oid;

          throw new Error("agent stage blew up");
        },
      }),
    ).catch((e: unknown) => e);

    // The original failure still propagates — never masked.
    expect((error as Error).message).toContain("agent stage blew up");

    // The lost retention is logged, and the losing CAS left the
    // foreign lease untouched.
    expect(
      progress.find((line) =>
        line.includes("failed to shorten retained lease"),
      ),
    ).toBeDefined();
    expect(await observeLeaseOid(world.a.git, "origin", LEASE_REF)).toBe(
      foreignOid,
    );
  }, 30000);

  it("still sees the dirty tree first when the retained lease has expired", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];

    const error = await runSharedCycle(
      optionsFor(cw, dataRoot, {
        run: runContext({
          rawDir: join(dataRoot, "raw"),
          env: process.env,
          now: NOW,
          onProgress: (line: string) => progress.push(line),
        }),
        runSweep: async () => {
          await writeFile(join(dataRoot, "raw", "stray.md"), "partial\n");

          throw new Error("agent stage blew up");
        },
      }),
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("agent stage blew up");
    expect(
      progress.find((line) => line.includes("retained lease expires")),
    ).toBeDefined();

    // The short window passes: a foreign writer replaces the lease
    // with an already-expired one — the remote state fifteen
    // minutes later.
    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    if (retained === undefined) {
      throw new Error("setup: the retained lease is gone");
    }

    const expired = await replaceLease({
      git: world.b.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      expectedOid: retained.oid,
      previous: retained.body,
      treeOid: await fetchedTreeOid(world.b.git),
      base: retained.body.base,
      now: NOW,
      holder: "expired-fixture:1",
      ttlMs: -60_000,
    });

    // The next tick must see the dirty tree first and refuse: no
    // takeover of the expired lease, no agent work, no ref move.
    let reachedSweep = false;
    const outcome = await runSharedCycle(
      optionsFor(cw, dataRoot, {
        run: runContext({
          rawDir: join(dataRoot, "raw"),
          env: process.env,
          now: NOW,
          onProgress: () => {},
        }),
        runSweep: async () => {
          reachedSweep = true;
        },
      }),
    );

    if (outcome.status !== "refused") {
      throw new Error("expected a refusal, got a completed cycle");
    }

    expect(outcome.reason).toContain("dirty");
    expect(reachedSweep).toBe(false);
    expect(await observeLeaseOid(world.a.git, "origin", LEASE_REF)).toBe(
      expired.oid,
    );
  }, 30000);
});

describe("ambiguous finalize recovery (test 18)", () => {
  it("recognizes proven success when the push report is lost", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    // Wrap the real runner: the atomic finalize push actually lands,
    // then reports failure — the lost-response shape.
    const realGit = gitRunnerFor({ dir: dataRoot, env: process.env });
    const flaky: typeof realGit = async (argsList) => {
      const result = await realGit(argsList);

      if (argsList.includes("--atomic")) {
        throw Object.assign(new Error("connection lost mid-push"), {
          stderr: "fatal: the remote end hung up unexpectedly",
        });
      }

      return result;
    };

    const outcome = await runSharedCycle(
      optionsFor(cw, dataRoot, { git: flaky }),
    );

    expect(outcome.status).toBe("completed");

    const remote = gitRunnerFor(remoteHost(world.remoteDir));

    expect((await remote(["for-each-ref", "refs/k-wiki/"])).stdout.trim()).toBe(
      "",
    );
  }, 30000);
});

async function commitOid(repo: {
  git: (args: string[]) => Promise<{ stdout: string }>;
}): Promise<string> {
  return (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
}
