/**
 * The shared-writer coordinator against a real two-clone world and a
 * local bare remote (issue #390): precondition refusals before any
 * mutation, the no-op cycle's conditional lease release, the fresh-
 * clone snapshot bootstrap, fail-closed marker and lease handling,
 * and the ambiguous-finalize recovery. The full agent-bearing cycle
 * lives in the e2e suite.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { readRecoveryRecord } from "../../src/writer/recovery-record.ts";
import {
  type CoordWorld,
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
  it("refuses a dirty tree", async () => {
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
  });

  it("names the offending path in the refusal", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await writeFile(join(dataRoot, "wiki", "junk.md"), "junk\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect((outcome as { reason: string }).reason).toContain("junk.md");
  });

  it("refuses a locally-ahead checkout", async () => {
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
  });

  it("pushes nothing from a locally-ahead checkout", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await commitFile(world.a, "unshared.txt", "unshared\n");

    await runSharedCycle(optionsFor(cw, dataRoot));

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
  it("loses the lease race to a live holder", async () => {
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

    await runSharedCycle(optionsFor(cw, dataRoot)).catch((e: unknown) => e);
  });

  it("names the lease holder in the error", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await world.a.git(["fetch", "origin", "refs/heads/main"]);

    await acquireLease({
      git: world.b.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: await fetchedTreeOid(world.b.git),
      base: "b".repeat(40),
      now: NOW,
      holder: "other-mac:99",
    });

    const error = await runSharedCycle(optionsFor(cw, dataRoot)).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("other-mac:99");
  });

  it("names the lease expiry in the error", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await world.a.git(["fetch", "origin", "refs/heads/main"]);

    await acquireLease({
      git: world.b.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: await fetchedTreeOid(world.b.git),
      base: "b".repeat(40),
      now: NOW,
      holder: "other-mac:99",
    });

    const error = await runSharedCycle(optionsFor(cw, dataRoot)).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("2026-01-01T04:00:00.000Z");
  });
});

describe("no-op cycle under lease", () => {
  it("completes the no-op cycle", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await commitOid(world.a);

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome.status).toBe("completed");

    gitRunnerFor(remoteHost(world.remoteDir));
  });

  it("advances nothing on a no-op cycle", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const before = await commitOid(world.a);

    await runSharedCycle(optionsFor(cw, dataRoot));

    const remote = gitRunnerFor(remoteHost(world.remoteDir));

    expect((await remote(["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(
      before,
    );
  });

  it("releases the lease on completion", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await commitOid(world.a);

    await runSharedCycle(optionsFor(cw, dataRoot));

    const remote = gitRunnerFor(remoteHost(world.remoteDir));

    expect((await remote(["for-each-ref", "refs/k-wiki/"])).stdout.trim()).toBe(
      "",
    );
  });

  it("completes a fresh-clone cycle", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const dirC = join(world.remoteDir, "..", "writer-c");

    await run("git", ["clone", "-q", world.remoteDir, dirC]);

    await run("git", ["config", "user.email", "t@t"], { cwd: dirC });

    await run("git", ["config", "user.name", "t"], { cwd: dirC });

    const outcome = await runSharedCycle(optionsFor(cw, dirC));

    expect(outcome.status).toBe("completed");

    const snapshot = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dirC, "outputs", "last-ingested-manifest.json"), "utf8"),
    );

    JSON.parse(snapshot) as {
      snapshotFor: string;
      committedHead: string;
    };
  });

  it("bootstraps the snapshot from the canonical tree", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const dirC = join(world.remoteDir, "..", "writer-c");

    await run("git", ["clone", "-q", world.remoteDir, dirC]);

    await run("git", ["config", "user.email", "t@t"], { cwd: dirC });

    await run("git", ["config", "user.name", "t"], { cwd: dirC });

    await runSharedCycle(optionsFor(cw, dirC));

    const snapshot = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dirC, "outputs", "last-ingested-manifest.json"), "utf8"),
    );

    const parsed = JSON.parse(snapshot) as {
      snapshotFor: string;
      committedHead: string;
    };

    expect(parsed.snapshotFor).toBe(dirC);
  });

  it("records the committed head in the snapshot", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const dirC = join(world.remoteDir, "..", "writer-c");

    await run("git", ["clone", "-q", world.remoteDir, dirC]);

    await run("git", ["config", "user.email", "t@t"], { cwd: dirC });

    await run("git", ["config", "user.name", "t"], { cwd: dirC });

    await runSharedCycle(optionsFor(cw, dirC));

    const snapshot = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dirC, "outputs", "last-ingested-manifest.json"), "utf8"),
    );

    const parsed = JSON.parse(snapshot) as {
      snapshotFor: string;
      committedHead: string;
    };

    expect(parsed.committedHead).toBe(await commitOid(world.a));
  });
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

  it("sees the prior writer's lease acquisition", async () => {
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

    await world.a.git(["fetch", "origin"]);

    await runSharedCycle(optionsFor(cw, dataRoot)).catch((e: unknown) => e);
  });

  it("still observes a lease a default fetch cannot see (test 13)", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await world.a.git(["fetch", "origin", "refs/heads/main"]);

    await acquireLease({
      git: world.b.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: await fetchedTreeOid(world.b.git),
      base: "b".repeat(40),
      now: NOW,
      holder: "sneaky:1",
    });

    await world.a.git(["fetch", "origin"]);

    const error = await runSharedCycle(optionsFor(cw, dataRoot)).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("sneaky:1");
  });
});

describe("failure-rule lease retention", () => {
  it("starts with no retained lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    const before = await observeLeaseOid(world.a.git, "origin", LEASE_REF);

    expect(before).toBeUndefined();

    await runSharedCycle(
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

    await observeLease(world.a.git, "origin", LEASE_REF);
  });

  it("fails mid-run naming the agent stage", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await observeLeaseOid(world.a.git, "origin", LEASE_REF);

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

    await observeLease(world.a.git, "origin", LEASE_REF);
  });

  it("retains a lease after the mid-run failure", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await observeLeaseOid(world.a.git, "origin", LEASE_REF);

    await runSharedCycle(
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

    const lease = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(lease).toBeDefined();
  });

  it("shortens the retained lease to fifteen minutes", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await observeLeaseOid(world.a.git, "origin", LEASE_REF);

    await runSharedCycle(
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

    const lease = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(lease?.body.expires).toBe("2026-01-01T00:15:00.000Z");
  });

  it("announces the retained lease expiry on progress", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await observeLeaseOid(world.a.git, "origin", LEASE_REF);

    await runSharedCycle(
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

    await observeLease(world.a.git, "origin", LEASE_REF);

    expect(
      progress.find((line) => line.includes("retained lease expires")),
    ).toContain("2026-01-01T00:15:00.000Z");
  });

  it("fails the cycle again for the lease replacement", async () => {
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    await observeLease(world.a.git, "origin", LEASE_REF);
  });

  it("observes the lease mid-run", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    let observedMidRun: ObservedLease | undefined;

    await runSharedCycle(
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    expect(observedMidRun).toBeDefined();

    await observeLease(world.a.git, "origin", LEASE_REF);
  });

  it("re-acquires the retained lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    const acquired = progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    await observeLease(world.a.git, "origin", LEASE_REF);

    expect(acquired).not.toBeNull();
  });

  it("keeps a retained lease in the ref", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(retained).toBeDefined();
  });

  it("replaces the retained lease by a new OID", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    let observedMidRun: ObservedLease | undefined;

    await runSharedCycle(
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(retained?.oid).not.toBe(observedMidRun?.oid);
  });

  it("keeps the acquired token out of the lease OID", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    const acquired = progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(retained?.oid.slice(0, 8)).not.toBe(acquired?.[1]);
  });

  it("carries the acquired token into the retained lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    let observedMidRun: ObservedLease | undefined;

    await runSharedCycle(
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(retained?.body.token).toBe(observedMidRun?.body.token);
  });

  it("counts the renewal on the retained lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    let observedMidRun: ObservedLease | undefined;

    await runSharedCycle(
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(retained?.body.renewals).toBe(
      (observedMidRun?.body.renewals ?? 0) + 1,
    );
  });

  it("keeps the shortened expiry on the retained lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    progress
      .map((line) => /lease ([0-9a-f]{8}) acquired/.exec(line))
      .find((match) => match !== null);

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(retained?.body.expires).toBe("2026-01-01T00:15:00.000Z");
  });

  it("fails the cycle during finalization", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

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

    await observeLease(world.a.git, "origin", LEASE_REF);
  });

  it("retains a lease after a finalization failure", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

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

    const blocker = join(cw.scratch, "blocker");

    await writeFile(blocker, "not a directory\n");

    const progress: string[] = [];

    await runSharedCycle(
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
    ).catch(() => undefined);

    const lease = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(lease).toBeDefined();
  });

  it("shortens the retained lease to fifteen minutes", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

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

    const blocker = join(cw.scratch, "blocker");

    await writeFile(blocker, "not a directory\n");

    const progress: string[] = [];

    await runSharedCycle(
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
    ).catch(() => undefined);

    const lease = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(lease?.body.expires).toBe("2026-01-01T00:15:00.000Z");
  });

  it("announces the finalization-failure lease on progress", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const vault = cw.config.vaults[0];

    if (vault === undefined) {
      throw new Error("setup: the world has no vault");
    }

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

    const blocker = join(cw.scratch, "blocker");

    await writeFile(blocker, "not a directory\n");

    const progress: string[] = [];

    await runSharedCycle(
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
    ).catch(() => undefined);

    await observeLease(world.a.git, "origin", LEASE_REF);

    expect(
      progress.find((line) =>
        line.includes("cycle failed during finalization"),
      ),
    ).toContain("2026-01-01T00:15:00.000Z");
  });

  it("refuses the run before acquisition", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await writeFile(join(dataRoot, "wiki", "junk.md"), "junk\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome).toMatchObject({ status: "refused" });
  });

  it("leaves no lease when the failure precedes acquisition", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    await writeFile(join(dataRoot, "wiki", "junk.md"), "junk\n");

    await runSharedCycle(optionsFor(cw, dataRoot));

    expect(
      await observeLeaseOid(world.a.git, "origin", LEASE_REF),
    ).toBeUndefined();
  });

  it("fails the cycle naming the agent stage", async () => {
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
          const live = await observeLease(world.a.git, "origin", LEASE_REF);

          if (live === undefined) {
            throw new Error("setup: the lease vanished mid-run");
          }

          // A foreign writer CAS-replaces the live lease out from
          // under the session: the retention push must lose its
          // exact-OID race.
          await replaceLease({
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
          throw new Error("agent stage blew up");
        },
      }),
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("agent stage blew up");
  });

  it("logs a lost retention race", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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
          await replaceLease({
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
          throw new Error("agent stage blew up");
        },
      }),
    ).catch((e: unknown) => e);

    expect(
      progress.find((line) =>
        line.includes("failed to shorten retained lease"),
      ),
    ).toBeDefined();
  });

  it("leaves the foreign lease in place", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    let foreignOid = "";

    await runSharedCycle(
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

    expect(await observeLeaseOid(world.a.git, "origin", LEASE_REF)).toBe(
      foreignOid,
    );
  });

  it("fails the cycle naming the agent stage", async () => {
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

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    if (retained === undefined) {
      throw new Error("setup: the retained lease is gone");
    }

    await replaceLease({
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

    false;

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
  });

  it("announces the expired retained lease on progress", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    expect(
      progress.find((line) => line.includes("retained lease expires")),
    ).toBeDefined();

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    if (retained === undefined) {
      throw new Error("setup: the retained lease is gone");
    }

    await replaceLease({
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

    false;

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
  });

  it("still sees the dirty tree first", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    if (retained === undefined) {
      throw new Error("setup: the retained lease is gone");
    }

    await replaceLease({
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

    false;

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
  });

  it("never reaches the sweep past a dirty tree", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    if (retained === undefined) {
      throw new Error("setup: the retained lease is gone");
    }

    await replaceLease({
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

    expect(reachedSweep).toBe(false);
  });

  it("leaves the expired lease in place", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

    const progress: string[] = [];

    await runSharedCycle(
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

    false;

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

    expect(await observeLeaseOid(world.a.git, "origin", LEASE_REF)).toBe(
      expired.oid,
    );
  });
});

describe("ambiguous finalize recovery (test 18)", () => {
  it("completes the cycle when the push report is lost", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

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

    gitRunnerFor(remoteHost(world.remoteDir));
  });

  it("releases the lease on proven success", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { dataRoot } = cw;

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

    await runSharedCycle(optionsFor(cw, dataRoot, { git: flaky }));

    const remote = gitRunnerFor(remoteHost(world.remoteDir));

    expect((await remote(["for-each-ref", "refs/k-wiki/"])).stdout.trim()).toBe(
      "",
    );
  });
});

/** Five hours past the retention instant — the fifteen-minute
 *  dead-man window and the four-hour fixture TTL both long passed. */
const LATER = () => new Date("2026-01-01T05:00:00Z");

describe("fix-surface auto-recovery (issue #400)", () => {
  it("records the surface at failure time", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);

    const record = await readRecoveryRecord(world.a.git);

    expect(record?.paths).toEqual(["raw/stray.md"]);
  }, 30000);

  it("binds the record to the retained lease", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);

    const record = await readRecoveryRecord(world.a.git);
    const retained = await observeLease(world.a.git, "origin", LEASE_REF);

    expect(record?.lease?.oid).toBe(retained?.oid);
  }, 30000);

  it("refuses the ticks before the threshold", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome.status).toBe("refused");
  }, 30000);

  it("counts the refused ticks in the record", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(optionsFor(cw, dataRoot));

    const record = await readRecoveryRecord(world.a.git);

    expect(record?.refusedTicks).toBe(2);
  }, 60000);

  it("auto-recovers on the third tick past the dead-man window", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(optionsFor(cw, dataRoot));

    const outcome = await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(outcome.status).toBe("completed");
  }, 60000);

  it("logs the auto-recovery line", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];

    await failACycle(cw, dataRoot);
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER, progress) }),
    );

    expect(
      progress.find((line) =>
        line.includes("auto-recovered fix surface from cycle"),
      ),
    ).toBeDefined();
  }, 60000);

  it("names the discarded paths in the auto-recovery line", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];

    await failACycle(cw, dataRoot);
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER, progress) }),
    );

    const line = progress.find((line) =>
      line.includes("auto-recovered fix surface from cycle"),
    );

    expect(line).toContain("raw/stray.md");
  }, 60000);

  it("clears the record after the auto-recovery", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(await readRecoveryRecord(world.a.git)).toBeUndefined();
  }, 60000);

  it("releases the lease after the auto-recovered no-op cycle", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(
      await observeLeaseOid(world.a.git, "origin", LEASE_REF),
    ).toBeUndefined();
  }, 60000);

  it("refuses the tick with a human edit present", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");

    const outcome = await runSharedCycle(optionsFor(cw, dataRoot));

    expect(outcome.status).toBe("refused");
  }, 30000);

  it("escalates an ALERT naming the human path", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, NOW, progress) }),
    );

    const alert = progress.find((line) => line.includes("ALERT"));

    expect(alert).toContain("human.md");
  }, 30000);

  it("marks the record auto-disabled after the divergence", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");
    await runSharedCycle(optionsFor(cw, dataRoot));

    const record = await readRecoveryRecord(world.a.git);

    expect(record?.autoDisabled).toBe(true);
  }, 30000);

  it("stays refused after the abort even with the lease lapsed", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");
    await runSharedCycle(optionsFor(cw, dataRoot));

    const outcome = await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(outcome.status).toBe("refused");
  }, 60000);

  it("stays quiet after the abort", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;
    const progress: string[] = [];

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER, progress) }),
    );

    expect(progress.find((line) => line.includes("ALERT"))).toBeUndefined();
  }, 60000);

  it("never eats the human edit after the abort", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(await readFileText(join(dataRoot, "human.md"))).toBe("by hand\n");
  }, 60000);

  it("never eats the recorded surface after the abort", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await writeFile(join(dataRoot, "human.md"), "by hand\n");
    await runSharedCycle(optionsFor(cw, dataRoot));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(await readFileText(join(dataRoot, "raw", "stray.md"))).toBe(
      "partial\n",
    );
  }, 60000);

  it("completes the tick when the surface resolved itself", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await rm(join(dataRoot, "raw", "stray.md"));

    const outcome = await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(outcome.status).toBe("completed");
  }, 30000);

  it("clears the stale record when the surface resolved itself", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { dataRoot } = cw;

    await failACycle(cw, dataRoot);
    await rm(join(dataRoot, "raw", "stray.md"));
    await runSharedCycle(
      optionsFor(cw, dataRoot, { run: tickRun(cw, dataRoot, LATER) }),
    );

    expect(await readRecoveryRecord(world.a.git)).toBeUndefined();
  }, 30000);
});

/** A refused-tick run context: injectable clock and progress sink. */
function tickRun(
  _cw: CoordWorld,
  dataRoot: string,
  now: () => Date,
  progress?: string[],
) {
  return runContext({
    rawDir: join(dataRoot, "raw"),
    env: process.env,
    now,
    onProgress: (line: string) => progress?.push(line),
  });
}

/** One failed cycle over the enabled world: the sweep writes a stray
 *  raw/ file and throws — the retained-lease dirty-surface shape. */
async function failACycle(
  cw: Awaited<ReturnType<typeof enabledDataRepo>>,
  dataRoot: string,
): Promise<void> {
  const error = await runSharedCycle(
    optionsFor(cw, dataRoot, {
      runSweep: async () => {
        await writeFile(join(dataRoot, "raw", "stray.md"), "partial\n");

        throw new Error("agent stage blew up");
      },
    }),
  ).catch((e: unknown) => e);

  if (!((error as Error).message as string).includes("agent stage blew up")) {
    throw new Error(`setup: the cycle failed another way — ${String(error)}`);
  }
}

/** Read a file's text, undefined when absent. */
async function readFileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function commitOid(repo: {
  git: (args: string[]) => Promise<{ stdout: string }>;
}): Promise<string> {
  return (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
}
