import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureDashboardIgnored,
  ensureSnapshotIgnored,
  readSnapshot,
  warnTrackedIgnored,
} from "../../src/ingest/snapshot.ts";

/**
 * snapshot unit tests (issue #258, moved with the module from
 * wiki-ingest.test.ts): the tracked-but-ignored pre-flight warning's
 * non-repo case. The gitignore guards, the legacy snapshot adoption,
 * and the run's other snapshot behavior stay covered as
 * runWikiIngest-level tests in tests/ingest/wiki-ingest.test.ts.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

describe("warnTrackedIgnored (issue #146)", () => {
  it("emits no warning and does not throw when git cannot report", async () => {
    const messages: string[] = [];
    const notARepo = await mkdtemp(join(tmpdir(), "k-wiki-not-a-repo-"));

    tempDirs.push(notARepo);

    await warnTrackedIgnored(notARepo, process.env, (message) =>
      messages.push(message),
    );

    expect(messages).toEqual([]);
  });
});

describe("readSnapshot shape guard (issue #240 kill batch)", () => {
  it("treats a null snapshot body as unstamped, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-snap-null-"));

    tempDirs.push(dir);

    const snapshotPath = join(dir, "snapshot.json");

    await (await import("node:fs/promises")).writeFile(snapshotPath, "null");

    const messages: string[] = [];
    const snapshot = await readSnapshot(
      snapshotPath,
      dir,
      (m) => messages.push(m),
      false,
    );

    expect(messages[0]).toContain("has no instance stamp");
    expect(snapshot).toBeUndefined();
  });

  it("treats a non-string snapshotFor stamp as unstamped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-snap-stamp-"));

    tempDirs.push(dir);

    const snapshotPath = join(dir, "snapshot.json");
    const fs = await import("node:fs/promises");

    await fs.writeFile(
      snapshotPath,
      JSON.stringify({ snapshotFor: 42, files: {} }),
    );

    const messages: string[] = [];
    const snapshot = await readSnapshot(
      snapshotPath,
      dir,
      (m) => messages.push(m),
      false,
    );

    expect(messages[0]).toContain("has no instance stamp");
    expect(snapshot).toBeUndefined();
  });
});

describe("gitignore guards (issue #240 kill batch)", () => {
  it("names the .gitignore path in the snapshot-ignore progress line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-snap-ignore-"));

    tempDirs.push(dir);

    const messages: string[] = [];
    await ensureSnapshotIgnored(dir, (m) => messages.push(m));

    expect(messages[0]).toContain(`${join(dir, ".gitignore")}`);
  });

  it("names the .gitignore path in the dashboard-ignore progress line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-dash-ignore-"));

    tempDirs.push(dir);

    const messages: string[] = [];
    await ensureDashboardIgnored(dir, (m) => messages.push(m));

    expect(messages[0]).toContain(`${join(dir, ".gitignore")}`);
  });
});
