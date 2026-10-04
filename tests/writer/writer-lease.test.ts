import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSharedCycle } from "../../src/writer/coordinator.ts";
import { gitRunnerFor } from "../../src/writer/git-remote.ts";
import { observeLeaseOid } from "../../src/writer/lease.ts";
import { main } from "../../src/writer/writer-lease.ts";
import {
  enabledDataRepo,
  HOLDER,
  LEASE_REF,
  NOW,
  optionsFor,
} from "./coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A CLI argv for the enabled world: status or takeover with the
 *  positional pointing at the data repo's raw dir. */
function argv(
  verb: string,
  cw: { dataRoot: string; scratch: string },
  extra: string[] = [],
) {
  // positionals: verb, <config>, <raw-dir> — the raw dir wins the
  // data-repo resolution, so a placeholder config path is fine.
  return [
    verb,
    join(cw.scratch, "sync.json"),
    join(cw.dataRoot, "raw"),
    ...extra,
  ];
}

describe("writer-lease status", () => {
  it("reports the live lease's holder", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await runSharedCycle({
      ...optionsFor(cw, cw.dataRoot),
      run: {
        ...optionsFor(cw, cw.dataRoot).run,
        now: () => new Date("2025-12-31T23:00:00Z"),
      },
    }).catch(() => {});

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-b:9",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(out).toContain("mac-b:9");
  });

  it("reports the live lease's expiry", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await runSharedCycle({
      ...optionsFor(cw, cw.dataRoot),
      run: {
        ...optionsFor(cw, cw.dataRoot).run,
        now: () => new Date("2025-12-31T23:00:00Z"),
      },
    }).catch(() => {});

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-b:9",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(out).toContain("2026-01-01T04:00:00.000Z");
  });

  it("names the takeover route for an expired lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await runSharedCycle({
      ...optionsFor(cw, cw.dataRoot),
      run: {
        ...optionsFor(cw, cw.dataRoot).run,
        now: () => new Date("2025-12-31T23:00:00Z"),
      },
    }).catch(() => {});

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-b:9",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(/EXPIRED|takeover --expected/.test(out)).toBe(true);
  });

  it("reports a free lane", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(out).toContain("none held");

    process.exitCode = undefined;
  });

  it("reports a free lane when no lease is held and exits 0", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(process.exitCode).not.toBe(1);

    process.exitCode = undefined;
  });

  it("reports a repo without a marker", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { rm: rmDir } = await import("node:fs/promises");

    await rmDir(join(cw.dataRoot, ".k-wiki"), { recursive: true, force: true });
    await gitRunnerFor({ dir: cw.dataRoot, env: process.env })(["add", "-A"]);
    await gitRunnerFor({ dir: cw.dataRoot, env: process.env })([
      "commit",
      "-m",
      "marker removed",
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    expect(
      logSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("not enabled");
    process.exitCode = undefined;
  }, 30000);
});

describe("writer-lease takeover", () => {
  it("logs the recovery lease replacement", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-a:1",
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    expect(
      logSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("lease taken over");

    await (await import("../../src/writer/lease.ts")).observeLease(
      git,
      "origin",
      LEASE_REF,
    );

    process.exitCode = undefined;
  });

  it("replaces the lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-a:1",
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    const lease = await (
      await import("../../src/writer/lease.ts")
    ).observeLease(git, "origin", LEASE_REF);

    expect(lease).toBeDefined();

    process.exitCode = undefined;
  });

  it("replaces it under a new OID", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-a:1",
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    const lease = await (
      await import("../../src/writer/lease.ts")
    ).observeLease(git, "origin", LEASE_REF);

    expect(lease?.oid).not.toBe(acquire.lease.oid);

    process.exitCode = undefined;
  });

  it("changes the holder on recovery", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-a:1",
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    const lease = await (
      await import("../../src/writer/lease.ts")
    ).observeLease(git, "origin", LEASE_REF);

    expect(lease?.body.holder).not.toBe("mac-a:1");

    process.exitCode = undefined;
  });

  it("bases the recovery lease on the current head", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-a:1",
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    const lease = await (
      await import("../../src/writer/lease.ts")
    ).observeLease(git, "origin", LEASE_REF);

    expect(lease?.body.base).toBe(
      (await git(["rev-parse", "HEAD"])).stdout.trim(),
    );

    process.exitCode = undefined;
  });

  it("replaces the lease by exact OID with a fresh recovery lease", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const { acquireLease } = await import("../../src/writer/lease-ops.ts");

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: "mac-a:1",
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    const lease = await (
      await import("../../src/writer/lease.ts")
    ).observeLease(git, "origin", LEASE_REF);

    expect(lease?.body.renewals).toBe(0);

    process.exitCode = undefined;
  });

  it("refuses a takeover quoting a stale OID", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { acquireLease } = await import("../../src/writer/lease-ops.ts");
    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);
    const acquire = await acquireLease({
      git,
      remote: "origin",
      leaseRef: LEASE_REF,
      treeOid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      base: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      now: NOW,
      holder: HOLDER,
    });

    if (acquire.status !== "acquired") {
      throw new Error("setup: acquire refused");
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", "f".repeat(40), "--confirm"]),
    );

    expect(
      errorSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("no longer reads");
    process.exitCode = undefined;
  }, 30000);

  it("refuses without --confirm", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(argv("takeover", cw, ["--expected", "a".repeat(40)]));

    expect(
      errorSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("--confirm");
    process.exitCode = undefined;
  }, 30000);

  it("refuses an unknown verb", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(argv("force-unlock", cw));

    expect(
      errorSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("unknown verb");
    process.exitCode = undefined;
  }, 30000);
});

describe("writer-lease observation invariant", () => {
  it("sees the remote refs a default fetch observes", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    await git(["fetch", "origin"]);

    expect(await git(["for-each-ref", "refs/remotes/origin"])).toBeDefined();
  });

  it("still misses the lease a default fetch cannot observe", async () => {
    const world = await makeWriterWorld();

    worlds.push(world);

    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);

    await git(["fetch", "origin"]);

    expect(await observeLeaseOid(git, "origin", LEASE_REF)).toBeUndefined();
  });
});
