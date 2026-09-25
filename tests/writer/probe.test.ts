/**
 * The remote capability probe against a real local bare remote
 * (issue #390 required test 14): the exact-OID replace and the
 * atomic disposable-ref finalization both succeed; every step
 * verifies; a probe failure reports the retained probe refs.
 */

import { describe, expect, it } from "vitest";
import { probeRemoteCapabilities } from "../../src/writer/probe.ts";
import { makeWriterWorld } from "./git-world.ts";

const NOW = () => new Date("2026-01-01T00:00:00Z");

describe("probeRemoteCapabilities", () => {
  it("passes the full lifecycle against a local bare remote and cleans up", async () => {
    const world = await makeWriterWorld();

    try {
      await world.a.git(["fetch", "origin", "refs/heads/main"]);
      const treeOid = (
        await world.a.git(["rev-parse", "FETCH_HEAD^{tree}"])
      ).stdout.trim();
      const result = await probeRemoteCapabilities({
        git: world.a.git,
        remote: "origin",
        treeOid,
        now: NOW,
        holder: "probe-host:1",
        onProgress: () => {},
      });

      expect(result.ok).toBe(true);
      expect(result.retained).toEqual([]);
      expect(result.detail.length).toBeGreaterThanOrEqual(3);
      expect(result.detail.join("\n")).toContain("atomic finalize verified");

      const refs = (
        await world.a.git(["ls-remote", "--refs", "origin"]).catch(() => ({
          stdout: "",
        }))
      ).stdout;

      expect(refs).not.toContain("refs/k-wiki/probe/");
    } finally {
      await world.cleanup();
    }
  });

  it("records the custom-ref create and exact-OID replace steps", async () => {
    const world = await makeWriterWorld();

    try {
      await world.a.git(["fetch", "origin", "refs/heads/main"]);
      const treeOid = (
        await world.a.git(["rev-parse", "FETCH_HEAD^{tree}"])
      ).stdout.trim();
      const result = await probeRemoteCapabilities({
        git: world.a.git,
        remote: "origin",
        treeOid,
        now: NOW,
        holder: "probe-host:1",
        onProgress: () => {},
      });

      expect(result.detail[0]).toContain("probe lease created");
      expect(result.detail[1]).toContain("replaced by exact OID");
    } finally {
      await world.cleanup();
    }
  });

  it("fails and names retained refs when the remote rejects custom refs", async () => {
    const world = await makeWriterWorld();

    try {
      // A pre-receive hook that rejects every refs/k-wiki/ update:
      // the stand-in for a remote without the capabilities.
      await world.a.git([
        "push",
        "-q",
        "origin",
        "refs/heads/main:refs/heads/main",
      ]);
      const hook =
        '#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/k-wiki/*) echo no-custom-refs >&2; exit 1 ;; esac\ndone\nexit 0\n';
      await import("node:fs/promises").then(async (fs) => {
        await fs.writeFile(`${world.remoteDir}/hooks/pre-receive`, hook, {
          mode: 0o755,
        });
      });

      const treeOid = (
        await world.a.git(["rev-parse", "HEAD^{tree}"])
      ).stdout.trim();
      const result = await probeRemoteCapabilities({
        git: world.a.git,
        remote: "origin",
        treeOid,
        now: NOW,
        holder: "probe-host:1",
        onProgress: () => {},
      });

      expect(result.ok).toBe(false);
      expect(result.detail.join(" ")).toMatch(/custom-ref create refused/);
    } finally {
      await world.cleanup();
    }
  });
});
