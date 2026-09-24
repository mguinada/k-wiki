/**
 * The shared-writer coordinator against a real two-clone world and a
 * local bare remote (issue #390): precondition refusals before any
 * mutation, the no-op cycle's conditional lease release, the fresh-
 * clone snapshot bootstrap, fail-closed marker and lease handling,
 * and the ambiguous-finalize recovery. The full agent-bearing cycle
 * lives in the e2e suite.
 */

import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runSharedCycle } from "../../src/writer/coordinator.ts";
import { gitRunnerFor, lsRemoteOid } from "../../src/writer/git-remote.ts";
import { acquireLease, fetchedTreeOid } from "../../src/writer/lease-ops.ts";
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
