import { describe, expect, it } from "vitest";
import {
  classifyPosition,
  currentBranch,
  fetchRefspec,
  isAncestor,
  lsRemoteOid,
  lsRemoteOids,
  mergeFfOnly,
  revParseOid,
} from "../../src/writer/git-remote.ts";
import { commitFile, makeWriterWorld } from "./git-world.ts";

describe("git-remote", () => {
  it("observes a live remote branch OID with ls-remote, no fetch", async () => {
    const world = await makeWriterWorld();

    try {
      const oids = await lsRemoteOids(world.a.git, "origin", [
        "refs/heads/main",
      ]);

      expect(oids.get("refs/heads/main")).toBe(
        await revParseOid(world.a.git, "HEAD"),
      );
    } finally {
      await world.cleanup();
    }
  });

  it("returns undefined for a ref the remote does not carry", async () => {
    const world = await makeWriterWorld();

    try {
      expect(
        await lsRemoteOid(world.a.git, "origin", "refs/heads/nope"),
      ).toBeUndefined();
    } finally {
      await world.cleanup();
    }
  });

  it("classifies a behind clone as behind and fast-forwards it", async () => {
    const world = await makeWriterWorld();

    try {
      await commitFile(world.a, "new.txt", "body\n");
      await world.a.git([
        "push",
        "-q",
        "origin",
        "refs/heads/main:refs/heads/main",
      ]);
      const remoteOid = await lsRemoteOid(
        world.a.git,
        "origin",
        "refs/heads/main",
      );

      // The coordinator's order: fetch first, then classify.
      await fetchRefspec(world.b.git, "origin", "refs/heads/main");

      expect(await classifyPosition(world.b.git, remoteOid ?? "")).toBe(
        "behind",
      );

      await mergeFfOnly(world.b.git, "FETCH_HEAD");

      expect(await classifyPosition(world.b.git, remoteOid ?? "")).toBe(
        "up-to-date",
      );
    } finally {
      await world.cleanup();
    }
  });

  it("classifies a local-ahead clone as ahead", async () => {
    const world = await makeWriterWorld();

    try {
      await commitFile(world.a, "local.txt", "local\n");
      const remoteOid = await lsRemoteOid(
        world.a.git,
        "origin",
        "refs/heads/main",
      );

      expect(await classifyPosition(world.a.git, remoteOid ?? "")).toBe(
        "ahead",
      );
    } finally {
      await world.cleanup();
    }
  });

  it("classifies two independent commits as diverged", async () => {
    const world = await makeWriterWorld();

    try {
      await commitFile(world.a, "a.txt", "a\n");
      await world.b.git(["fetch", "-q", "origin", "main"]);
      await world.b.git(["reset", "-q", "--hard", "HEAD"]);
      await world.a.git(["reset", "-q", "--hard", "origin/main"]);
      await commitFile(world.a, "a2.txt", "a2\n");
      await commitFile(world.b, "b2.txt", "b2\n");
      const remoteOid = await revParseOid(world.b.git, "HEAD");

      expect(await classifyPosition(world.a.git, remoteOid ?? "")).toBe(
        "diverged",
      );
    } finally {
      await world.cleanup();
    }
  });

  it("reports the checked-out branch name", async () => {
    const world = await makeWriterWorld();

    try {
      expect(await currentBranch(world.a.git)).toBe("main");
    } finally {
      await world.cleanup();
    }
  });

  it("sees an ancestor commit as an ancestor of its descendant", async () => {
    const world = await makeWriterWorld();

    try {
      const base = await revParseOid(world.a.git, "HEAD");
      const head = await commitFile(world.a, "next.txt", "next\n");

      expect(await isAncestor(world.a.git, base ?? "", head)).toBe(true);
      expect(await isAncestor(world.a.git, head, base ?? "")).toBe(false);
    } finally {
      await world.cleanup();
    }
  });

  it("counts an unresolvable object as not an ancestor (fail closed)", async () => {
    const world = await makeWriterWorld();

    try {
      expect(await isAncestor(world.a.git, "0".repeat(40), "HEAD")).toBe(false);
    } finally {
      await world.cleanup();
    }
  });
});
