import { describe, expect, it } from "vitest";
import { gitRunnerFor } from "../../src/writer/git-remote.ts";
import { observeLeaseOid } from "../../src/writer/lease.ts";
import {
  acquireLease,
  fetchedTreeOid,
  finalizeWithLeaseRelease,
  releaseOwnLease,
  renewLease,
  takeOverExpiredLease,
} from "../../src/writer/lease-ops.ts";
import {
  commitFile,
  makeWriterWorld,
  remoteHost,
  type TempRepo,
} from "./git-world.ts";

const LEASE_REF = "refs/k-wiki/leases/shared-writer-v1";
const BRANCH_REF = "refs/heads/main";
const NOW = () => new Date("2026-01-01T00:00:00Z");
const HOLDER = "test-host:1";

async function fetchMain(repo: TempRepo): Promise<string> {
  await repo.git(["fetch", "origin", "refs/heads/main"]);

  return await fetchedTreeOid(repo.git);
}

describe("acquireLease", () => {
  it("creates the absent lease ref and reports the parsed lease", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const outcome = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      expect(outcome.status).toBe("acquired");
    } finally {
      await world.cleanup();
    }
  });

  it("refuses a second writer, naming holder and expiry (test 1)", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });
      await fetchMain(world.b);
      const second = await acquireLease({
        git: world.b.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: "other:2",
      });

      expect(first.status).toBe("acquired");
      expect(second).toEqual({
        status: "refused",
        reason: expect.stringContaining(HOLDER),
      });
      expect((second as { reason: string }).reason).toContain(
        "2026-01-01T04:00:00.000Z",
      );
    } finally {
      await world.cleanup();
    }
  });
});

describe("renewLease", () => {
  it("extends expiry under the same token and bumps renewals", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      const later = () => new Date("2026-01-01T01:00:00Z");
      const renewed = await renewLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        current: first.lease,
        treeOid,
        base: "abc",
        now: later,
        holder: HOLDER,
      });

      expect(renewed.body.token).toBe(first.lease.body.token);
      expect(renewed.body.renewals).toBe(1);
      expect(renewed.body.expires).toBe("2026-01-01T05:00:00.000Z");
    } finally {
      await world.cleanup();
    }
  });

  it("fails a stale owner's renewal — the CAS race (test 17)", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      // A takeover by another writer moves the ref under writer A.
      await fetchMain(world.b);
      const liveOid = await observeLeaseOid(world.b.git, "origin", LEASE_REF);
      const thief = await takeOverExpiredLease({
        git: world.b.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        observed: {
          oid: liveOid ?? "",
          body: { ...first.lease.body, expires: "2020-01-01T00:00:00Z" },
        },
        treeOid,
        base: "abc",
        now: NOW,
        holder: "thief:2",
      });

      expect(thief.status).toBe("acquired");

      const later = () => new Date("2026-01-01T01:00:00Z");

      await expect(
        renewLease({
          git: world.a.git,
          remote: "origin",
          leaseRef: LEASE_REF,
          current: first.lease,
          treeOid,
          base: "abc",
          now: later,
          holder: HOLDER,
        }),
      ).rejects.toThrow(/failed/);
    } finally {
      await world.cleanup();
    }
  });
});

describe("takeOverExpiredLease", () => {
  it("refuses a lease that is not expired", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      await fetchMain(world.b);
      const outcome = await takeOverExpiredLease({
        git: world.b.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        observed: first.lease,
        treeOid,
        base: "abc",
        now: NOW,
        holder: "other:2",
      });

      expect(outcome).toEqual({
        status: "refused",
        reason: expect.stringContaining("not expired"),
      });
    } finally {
      await world.cleanup();
    }
  });

  it("replaces an expired lease by exact OID with no unlocked gap (test 6)", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      const expired: typeof first.lease = {
        oid: first.lease.oid,
        body: { ...first.lease.body, expires: "2020-01-01T00:00:00Z" },
      };
      await fetchMain(world.b);
      const outcome = await takeOverExpiredLease({
        git: world.b.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        observed: expired,
        treeOid,
        base: "abc",
        now: NOW,
        holder: "other:2",
      });

      expect(outcome.status).toBe("acquired");

      const remoteOid = (
        await world.b.git(["ls-remote", "--refs", "origin", LEASE_REF])
      ).stdout
        .trim()
        .split("\t")[0];

      expect(remoteOid).toBe((outcome as { lease: { oid: string } }).lease.oid);
    } finally {
      await world.cleanup();
    }
  });
});

describe("finalizeWithLeaseRelease", () => {
  it("advances the branch and removes the lease atomically (test 8)", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      const newHead = await commitFile(world.a, "work.txt", "work\n");

      await finalizeWithLeaseRelease({
        git: world.a.git,
        remote: "origin",
        branchRef: BRANCH_REF,
        leaseRef: LEASE_REF,
        newBranchOid: newHead,
        leaseOid: first.lease.oid,
      });

      const remote = gitRunnerFor(remoteHost(world.remoteDir));

      expect(
        (await remote(["rev-parse", "refs/heads/main"])).stdout.trim(),
      ).toBe(newHead);
      expect(
        (await remote(["for-each-ref", "refs/k-wiki/"])).stdout.trim(),
      ).toBe("");
    } finally {
      await world.cleanup();
    }
  });

  it("rejects a stale owner's fenced finalize after takeover (test 7)", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      await commitFile(world.a, "work.txt", "work\n");
      const newHead = (await world.a.git(["rev-parse", "HEAD"])).stdout.trim();

      // Another writer takes the (expired) lease over.
      const expired: typeof first.lease = {
        oid: first.lease.oid,
        body: { ...first.lease.body, expires: "2020-01-01T00:00:00Z" },
      };
      await fetchMain(world.b);
      const thief = await takeOverExpiredLease({
        git: world.b.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        observed: expired,
        treeOid,
        base: "abc",
        now: NOW,
        holder: "thief:2",
      });

      expect(thief.status).toBe("acquired");

      await expect(
        finalizeWithLeaseRelease({
          git: world.a.git,
          remote: "origin",
          branchRef: BRANCH_REF,
          leaseRef: LEASE_REF,
          newBranchOid: newHead,
          leaseOid: first.lease.oid,
        }),
      ).rejects.toThrow(/failed/);

      // The branch never moved and the thief's lease survives.
      const remote = gitRunnerFor(remoteHost(world.remoteDir));

      expect(
        (await remote(["rev-parse", "refs/heads/main"])).stdout.trim(),
      ).not.toBe(newHead);
    } finally {
      await world.cleanup();
    }
  });
});

describe("releaseOwnLease", () => {
  it("deletes exactly the owned lease after fresh verification (test 9)", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      await releaseOwnLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        ownOid: first.lease.oid,
      });

      const remote = gitRunnerFor(remoteHost(world.remoteDir));

      expect(
        (await remote(["for-each-ref", "refs/k-wiki/"])).stdout.trim(),
      ).toBe("");
    } finally {
      await world.cleanup();
    }
  });

  it("refuses to release a lease that is no longer ours", async () => {
    const world = await makeWriterWorld();

    try {
      const treeOid = await fetchMain(world.a);
      const first = await acquireLease({
        git: world.a.git,
        remote: "origin",
        leaseRef: LEASE_REF,
        treeOid,
        base: "abc",
        now: NOW,
        holder: HOLDER,
      });

      if (first.status !== "acquired") {
        throw new Error("setup: acquire refused");
      }

      await expect(
        releaseOwnLease({
          git: world.b.git,
          remote: "origin",
          leaseRef: LEASE_REF,
          ownOid: "0".repeat(40),
        }),
      ).rejects.toThrow(/no longer ours/);
    } finally {
      await world.cleanup();
    }
  });
});

describe("fetchedTreeOid", () => {
  it("reads the fetched branch head's tree", async () => {
    const world = await makeWriterWorld();

    try {
      await commitFile(world.a, "x.txt", "x\n");
      await world.a.git(["fetch", "origin", "refs/heads/main"]);
      const tree = await fetchedTreeOid(world.a.git);

      expect(tree).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await world.cleanup();
    }
  });
});
