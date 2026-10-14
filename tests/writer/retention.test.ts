import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import { releaseIfOwn } from "../../src/writer/enable-shared-writer.ts";
import {
  fetchCanonicalBranch,
  gitRunnerFor,
} from "../../src/writer/git-remote.ts";
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
import type { KnownTree } from "../../src/writer/options.ts";
import { retainAfterFailure } from "../../src/writer/retention.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

afterAll(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const NOW = () => new Date("2026-01-01T00:00:00Z");
const HOLDER = "retention-host:3";
const LEASE_REF = "refs/k-wiki/leases/shared-writer-v1";
const CANONICAL_REF = "refs/k-wiki/canonical/shared-writer-v1";
const MARKER = {
  version: 1,
  remote: "origin",
  branch: "main",
  leaseRef: LEASE_REF,
  sourceRemovalPolicy: "confirm",
} as const;

interface RetentionWorld {
  readonly git: ReturnType<typeof gitRunnerFor>;
  readonly world: WriterWorld;
  readonly current: ObservedLease;
  readonly tree: KnownTree;
}

/** A data repo with the canonical branch fetched, an owned remote
 *  lease, and the tenure's last-known tree published. */
async function retentionWorld(): Promise<RetentionWorld> {
  const world = await makeWriterWorld();

  worlds.push(world);

  const git = gitRunnerFor({ dir: world.a.dir, env: process.env });

  await fetchCanonicalBranch(git, "origin", "refs/heads/main", CANONICAL_REF);

  const treeOid = await fetchedTreeOid(git, CANONICAL_REF);
  const attempt = await acquireLease({
    git,
    remote: "origin",
    leaseRef: LEASE_REF,
    treeOid,
    base: treeOid,
    now: NOW,
    holder: HOLDER,
  });

  if (attempt.status !== "acquired") {
    throw new Error(`setup: the lease acquire refused — ${attempt.reason}`);
  }

  const oid = { value: undefined as string | undefined };
  const tree: KnownTree = {
    get: () => oid.value,
    set: (next) => {
      oid.value = next;
    },
  };
  tree.set(treeOid);

  return { git, world, current: attempt.lease, tree };
}

function runOf(world: RetentionWorld, onProgress: (line: string) => void) {
  return runContext({
    rawDir: join(world.world.a.dir, "raw"),
    env: process.env,
    now: NOW,
    onProgress,
  });
}

describe("retainAfterFailure", () => {
  it("retains through the healthy canonical-ref read", async () => {
    const world = await retentionWorld();

    await retainAfterFailure({
      run: runOf(world, () => {}),
      marker: MARKER,
      git: world.git,
      current: world.current,
      tree: world.tree,
      label: "test",
    });

    expect(await observeLeaseOid(world.git, "origin", LEASE_REF)).toBeDefined();
  });

  it("retains on the last-known tree when the canonical ref read fails", async () => {
    const world = await retentionWorld();

    // The degraded read: the canonical ref and the shared fetch-head
    // file both die exactly between the renewals and the retention —
    // yesterday's failure mode (issue #464).
    const gitDir = (
      await world.git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    const { rm: rmRef, writeFile } = await import("node:fs/promises");

    await rmRef(join(gitDir, "refs/k-wiki/canonical/shared-writer-v1"), {
      force: true,
    });
    await writeFile(join(gitDir, "FETCH_HEAD"), "");

    await retainAfterFailure({
      run: runOf(world, () => {}),
      marker: MARKER,
      git: world.git,
      current: world.current,
      tree: world.tree,
      label: "test",
    });

    expect(await observeLeaseOid(world.git, "origin", LEASE_REF)).toBeDefined();
  });

  it("reports the degraded tree read in the retain line", async () => {
    const world = await retentionWorld();
    const lines: string[] = [];

    const gitDir = (
      await world.git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    const { rm: rmRef, writeFile } = await import("node:fs/promises");

    await rmRef(join(gitDir, "refs/k-wiki/canonical/shared-writer-v1"), {
      force: true,
    });
    await writeFile(join(gitDir, "FETCH_HEAD"), "");

    await retainAfterFailure({
      run: runOf(world, (line) => lines.push(line)),
      marker: MARKER,
      git: world.git,
      current: world.current,
      tree: world.tree,
      label: "test",
    });

    expect(
      lines.find((line) => line.includes("lease maintenance retain")),
    ).toBeDefined();
  });

  it("skips the retention when no last-known tree was held", async () => {
    const world = await retentionWorld();
    const lines: string[] = [];

    const gitDir = (
      await world.git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    const { rm: rmRef } = await import("node:fs/promises");

    await rmRef(join(gitDir, "refs/k-wiki/canonical/shared-writer-v1"), {
      force: true,
    });

    const bare: KnownTree = {
      get: () => undefined,
      set: () => {},
    };

    await retainAfterFailure({
      run: runOf(world, (line) => lines.push(line)),
      marker: MARKER,
      git: world.git,
      current: world.current,
      tree: bare,
      label: "test",
    });

    const skipped = lines.find((line) =>
      line.includes("skipping lease retention"),
    );

    expect(skipped !== undefined).toBe(true);
  });

  it("prints the shorten-failed warning when the CAS push loses its race", async () => {
    const world = await retentionWorld();
    const lines: string[] = [];

    // A foreign writer replaces the live lease out from under the
    // retention: the exact-OID fence refuses.
    const foreignTree = await fetchedTreeOid(world.git, CANONICAL_REF);

    await replaceLease({
      git: world.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      expectedOid: world.current.oid,
      previous: world.current.body,
      treeOid: foreignTree,
      base: foreignTree,
      now: NOW,
      holder: "foreign:9",
    });

    await retainAfterFailure({
      run: runOf(world, (line) => lines.push(line)),
      marker: MARKER,
      git: world.git,
      current: world.current,
      tree: world.tree,
      label: "test",
    });

    expect(
      lines.find((line) => line.includes("failed to shorten retained lease")),
    ).toBeDefined();
  });
});

describe("releaseIfOwn", () => {
  it("releases the exact owned lease", async () => {
    const world = await retentionWorld();

    await releaseIfOwn(world.git, world.current.oid);

    expect(
      await observeLeaseOid(world.git, "origin", LEASE_REF),
    ).toBeUndefined();
  });

  it("reports the release maintenance line on console.error", async () => {
    const world = await retentionWorld();
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => errors.push(String(line)));

    try {
      await releaseIfOwn(world.git, world.current.oid);
    } finally {
      spy.mockRestore();
    }

    expect(
      errors.find((line) => line.includes("lease maintenance release")),
    ).toBeDefined();
  });

  it("swallows a refused release without reporting", async () => {
    const world = await retentionWorld();
    const foreignTree = await fetchedTreeOid(world.git, CANONICAL_REF);

    await observeLease(world.git, "origin", LEASE_REF);

    // Move the lease away from the exact owned OID: the release is
    // refused (not verbatim ours) and swallowed.
    await replaceLease({
      git: world.git,
      remote: "origin",
      leaseRef: LEASE_REF,
      expectedOid: world.current.oid,
      previous: world.current.body,
      treeOid: foreignTree,
      base: foreignTree,
      now: NOW,
      holder: "foreign:9",
    });

    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => errors.push(String(line)));

    await releaseIfOwn(world.git, world.current.oid);
    spy.mockRestore();

    expect(errors).toEqual([]);
  });
});
