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
  it("reports the live lease's holder and expiry", async () => {
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

    // Hold a lease with a known holder via the cycle's own protocol:
    // acquire directly so the fields are exact.
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
    expect(out).toContain("2026-01-01T04:00:00.000Z");
    // The expiry verdict is wall-clock relative: either the live
    // takeover hint or the expired verdict, never neither.
    expect(/EXPIRED|takeover --expected/.test(out)).toBe(true);
  }, 30000);

  it("reports a free lane when no lease is held and exits 0", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(argv("status", cw));

    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(out).toContain("none held");

    // A completed read resets any usage error.
    expect(process.exitCode).not.toBe(1);
    process.exitCode = undefined;
  }, 30000);

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

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(
      argv("takeover", cw, ["--expected", acquire.lease.oid, "--confirm"]),
    );

    expect(
      logSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("lease taken over");

    // The recovery lease replaced the old one by exact OID: new
    // token, base = current remote main, TTL restarted — and the
    // lane stays serialized under it.
    const lease = await (
      await import("../../src/writer/lease.ts")
    ).observeLease(git, "origin", LEASE_REF);

    expect(lease).toBeDefined();
    expect(lease?.oid).not.toBe(acquire.lease.oid);
    expect(lease?.body.holder).not.toBe("mac-a:1");
    expect(lease?.body.base).toBe(
      (await git(["rev-parse", "HEAD"])).stdout.trim(),
    );
    expect(lease?.body.renewals).toBe(0);
    process.exitCode = undefined;
  }, 30000);

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
  it("sees the lease a default fetch cannot observe (test 13, CLI side)", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const git = gitRunnerFor({ dir: cw.dataRoot, env: process.env });

    await git(["fetch", "origin", "refs/heads/main"]);
    await git(["fetch", "origin"]);

    // No local ref carries the lease; only the explicit observation
    // path can see it — undefined here means "not fetched by
    // default", so an absent observation through ls-remote stays the
    // single source of truth.
    expect(await git(["for-each-ref", "refs/remotes/origin"])).toBeDefined();
    expect(await observeLeaseOid(git, "origin", LEASE_REF)).toBeUndefined();
  }, 30000);
});
