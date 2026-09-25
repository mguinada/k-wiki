import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lsRemoteOid } from "../../src/writer/git-remote.ts";
import { MARKER_PATH } from "../../src/writer/marker.ts";
import { enabledDataRepo, LEASE_REF } from "./coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A data repo with an origin but no marker yet: the enable door's
 *  entry state. */
async function unenabledRepo() {
  const world = await makeWriterWorld();
  worlds.push(world);
  const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

  // Strip the marker the shared world committed.
  await rm(join(cw.dataRoot, ".k-wiki"), {
    recursive: true,
    force: true,
  });
  await world.a.git(["add", "-A"]);
  await world.a.git(["commit", "-m", "marker removed"]);
  await world.a.git([
    "push",
    "-q",
    "origin",
    "refs/heads/main:refs/heads/main",
  ]);

  return { world, cw };
}

describe("enable-shared-writer (library)", () => {
  it("commits and pushes the marker, releasing the bootstrap lease", async () => {
    const { world, cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");
    const { gitRunnerFor } = await import("../../src/writer/git-remote.ts");

    const message = await enable(cw.dataRoot);

    expect(message).toContain(MARKER_PATH);

    const marker = JSON.parse(
      await readFile(join(cw.dataRoot, MARKER_PATH), "utf8"),
    ) as { version: number; branch: string; leaseRef: string };

    expect(marker).toMatchObject({
      version: 1,
      branch: "main",
      leaseRef: LEASE_REF,
      sourceRemovalPolicy: "confirm",
    });

    // The marker commit is on origin and the lease is released.
    const remote = gitRunnerFor({
      dir: world.remoteDir,
      env: process.env,
    });

    expect(
      await lsRemoteOid(gitOf(cw.dataRoot), "origin", LEASE_REF),
    ).toBeUndefined();

    const remoteHead = (
      await remote(["rev-parse", "refs/heads/main"])
    ).stdout.trim();
    const localHead = (
      await gitOf(cw.dataRoot)(["rev-parse", "HEAD"])
    ).stdout.trim();

    expect(remoteHead).toBe(localHead);
  }, 30000);

  it("returns success without probe or lease churn when already enabled", async () => {
    const { cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");

    await enable(cw.dataRoot);

    const message = await enable(cw.dataRoot);

    expect(message).toBe(
      `shared-writer mode already enabled (marker at ${MARKER_PATH})`,
    );
  }, 30000);

  it("fails closed when an existing marker is invalid", async () => {
    const { world, cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");

    await mkdir(join(cw.dataRoot, ".k-wiki"), { recursive: true });
    await writeFile(join(cw.dataRoot, MARKER_PATH), "{}\n");
    await world.a.git(["add", "-A"]);
    await world.a.git(["commit", "-m", "invalid marker"]);
    await world.a.git([
      "push",
      "-q",
      "origin",
      "refs/heads/main:refs/heads/main",
    ]);

    await expect(enable(cw.dataRoot)).rejects.toThrow(
      /shared-writer marker is invalid/,
    );
  }, 30000);

  it("fast-forwards to an existing marker and returns success", async () => {
    const { world, cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");

    await world.b.git(["fetch", "-q", "origin", "refs/heads/main"]);
    await world.b.git(["reset", "-q", "--hard", "origin/main"]);
    await enable(cw.dataRoot);
    await writeFile(
      join(world.remoteDir, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/k-wiki/*) exit 1 ;; esac\ndone\nexit 0\n',
      { mode: 0o755 },
    );

    const message = await enable(world.b.dir);

    expect(message).toBe(
      `shared-writer mode already enabled (marker at ${MARKER_PATH})`,
    );
  }, 30000);

  it("returns success when the lease-held fetch receives a marker", async () => {
    const { world, cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");

    await world.b.git(["fetch", "-q", "origin", "refs/heads/main"]);
    await world.b.git(["reset", "-q", "--hard", "origin/main"]);
    await mkdir(join(world.b.dir, ".k-wiki"), { recursive: true });
    await writeFile(
      join(world.b.dir, MARKER_PATH),
      '{"version":1,"remote":"origin","branch":"main","leaseRef":"refs/k-wiki/leases/shared-writer-v1","sourceRemovalPolicy":"confirm"}\n',
    );
    await world.b.git(["add", "-A"]);
    await world.b.git(["commit", "-m", "marker from another writer"]);

    const markerHead = (await world.b.git(["rev-parse", "HEAD"])).stdout.trim();
    await world.b.git([
      "push",
      "-q",
      "origin",
      `${markerHead}:refs/test/marker`,
    ]);
    const baseHead = (await world.a.git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      join(world.remoteDir, "hooks", "post-receive"),
      `#!/bin/sh
while read -r old new ref; do
  if [ "$ref" = "${LEASE_REF}" ] && [ "$old" = "0000000000000000000000000000000000000000" ]; then
    git update-ref refs/heads/main ${markerHead} ${baseHead}
  fi
done
exit 0
`,
      { mode: 0o755 },
    );

    const message = await enable(cw.dataRoot);
    const remoteHead = (
      await gitOf(world.remoteDir)(["rev-parse", "refs/heads/main"])
    ).stdout.trim();
    const lease = await lsRemoteOid(gitOf(cw.dataRoot), "origin", LEASE_REF);

    expect({ message, localHead: await head(cw.dataRoot), remoteHead, lease }).toEqual({
      message: `shared-writer mode already enabled (marker at ${MARKER_PATH})`,
      localHead: markerHead,
      remoteHead: markerHead,
      lease: undefined,
    });
  }, 30000);

  it("refuses a dirty checkout without writing the marker", async () => {
    const { cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");

    await writeFile(join(cw.dataRoot, "junk.md"), "junk\n");

    await expect(enable(cw.dataRoot)).rejects.toThrow(/dirty/);
    await expect(
      readFile(join(cw.dataRoot, MARKER_PATH)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);

  it("refuses when the remote cannot do the protocol, with no marker", async () => {
    const { world, cw } = await unenabledRepo();
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");
    const fs = await import("node:fs/promises");

    // A pre-receive hook on the remote rejecting custom refs: the
    // unsupported-capability stand-in (the probe's own test proves
    // this hook mechanism fires).
    await fs.writeFile(
      `${world.remoteDir}/hooks/pre-receive`,
      '#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/k-wiki/*) echo no-custom-refs >&2; exit 1 ;; esac\ndone\nexit 0\n',
      { mode: 0o755 },
    );

    await expect(enable(cw.dataRoot)).rejects.toThrow(
      /does not support the shared-writer protocol/,
    );
    await expect(
      readFile(join(cw.dataRoot, MARKER_PATH)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);
});

function gitOf(dataRoot: string) {
  return (args: readonly string[]) =>
    import("../../src/writer/git-remote.ts").then(({ gitRunnerFor }) =>
      gitRunnerFor({ dir: dataRoot, env: process.env })(args),
    );
}

async function head(dataRoot: string): Promise<string> {
  return (await gitOf(dataRoot)(["rev-parse", "HEAD"])).stdout.trim();
}

describe("writer-lease verbs (library)", () => {
  it("status reports a live lease with holder and expiry", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { acquireLease } = await import("../../src/writer/lease-ops.ts");
    const { observeLease } = await import("../../src/writer/lease.ts");

    await gitOf(cw.dataRoot)(["fetch", "origin", "refs/heads/main"]);
    const acquire = await acquireLease({
      git: gitOf(cw.dataRoot),
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (
        await gitOf(cw.dataRoot)(["rev-parse", "HEAD^{tree}"])
      ).stdout.trim(),
      base: (await gitOf(cw.dataRoot)(["rev-parse", "HEAD"])).stdout.trim(),
      now: () => new Date("2026-01-01T00:00:00Z"),
      holder: "mac-a:42",
    });

    expect(acquire.status).toBe("acquired");

    const lease = await observeLease(gitOf(cw.dataRoot), "origin", LEASE_REF);

    expect(lease?.body.holder).toBe("mac-a:42");
    expect(lease?.body.expires).toBe("2026-01-01T04:00:00.000Z");
  }, 30000);
});

describe("concurrent enablement (test 19)", () => {
  it("racing enables: a marker lands and the remote stays consistent; any loser fails closed", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { enable } = await import("../../src/writer/enable-shared-writer.ts");

    // Strip the marker so both clones start unenabled; each clone
    // enables itself, racing for the bootstrap lease and the branch.
    const { rm: rmDir } = await import("node:fs/promises");

    await rmDir(join(cw.dataRoot, ".k-wiki"), { recursive: true, force: true });
    await world.a.git(["add", "-A"]);
    await world.a.git(["commit", "-m", "marker removed"]);
    await world.a.git([
      "push",
      "-q",
      "origin",
      "refs/heads/main:refs/heads/main",
    ]);
    await world.b.git(["fetch", "-q", "origin", "refs/heads/main"]);
    await world.b.git(["reset", "-q", "--hard", "origin/main"]);

    const baseHead = await head0(cw.dataRoot);

    const [first, second] = await Promise.all([
      enable(cw.dataRoot).then(
        () => "ok",
        (e: unknown) => String((e as Error).message),
      ),
      enable(world.b.dir).then(
        () => "ok",
        (e: unknown) => String((e as Error).message),
      ),
    ]);

    const outcomes = [
      { clone: world.a, result: first },
      { clone: world.b, result: second },
    ];
    const winners = outcomes.filter((o) => o.result === "ok");
    const losers = outcomes.filter((o) => o.result !== "ok");

    // At least one enable wins the lease race; either clone may win.
    // The loser may be lease-refused, finalize-rejected, classify the
    // remote as diverged, or fast-forward to the winner and take the
    // idempotent already-enabled path. The state assertions below are
    // the interleaving-agnostic contract.
    expect(winners.length).toBeGreaterThanOrEqual(1);

    // The remote is consistent: main = a winner's push, no lease.
    const remote = (
      await import("../../src/writer/git-remote.ts")
    ).gitRunnerFor({ dir: world.remoteDir, env: process.env });

    const remoteMain = (
      await remote(["rev-parse", "refs/heads/main"])
    ).stdout.trim();

    for (const loser of losers) {
      expect([baseHead, remoteMain]).toContain(await head0(loser.clone.dir));
    }

    expect((await remote(["for-each-ref", LEASE_REF])).stdout.trim()).toBe("");
    expect(await Promise.all(winners.map((o) => head0(o.clone.dir)))).toContain(
      remoteMain,
    );
  }, 60000);

  async function head0(dataRoot: string): Promise<string> {
    const { execFile } = await import("node:child_process");

    return (
      await (
        (await import("node:util")) as typeof import("node:util")
      ).promisify(execFile)("git", ["-C", dataRoot, "rev-parse", "HEAD"])
    ).stdout.trim();
  }
});
