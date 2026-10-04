import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import {
  buildSnapshotAdvance,
  ensureDashboardIgnored,
  ensureLintWindowIgnored,
  ensureSnapshotIgnored,
  readSnapshot,
  SNAPSHOT_FILENAME as SNAPSHOT_NAME,
  warnTrackedIgnored,
  writeSnapshotAdvance,
  writeSnapshotIfNeeded,
} from "../../src/ingest/snapshot.ts";
import { makeDataRepo } from "./harness.ts";

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
  it("warns on a null snapshot body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-snap-null-"));

    tempDirs.push(dir);

    const snapshotPath = join(dir, "snapshot.json");

    await (await import("node:fs/promises")).writeFile(snapshotPath, "null");

    const messages: string[] = [];

    await readSnapshot(snapshotPath, dir, (m) => messages.push(m), false);

    expect(messages[0]).toContain("has no instance stamp");
  });

  it("treats it as unstamped", async () => {
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

    expect(snapshot).toBeUndefined();
  });

  it("warns on a non-string snapshotFor stamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-snap-stamp-"));

    tempDirs.push(dir);

    const snapshotPath = join(dir, "snapshot.json");

    const fs = await import("node:fs/promises");

    await fs.writeFile(
      snapshotPath,
      JSON.stringify({ snapshotFor: 42, files: {} }),
    );

    const messages: string[] = [];

    await readSnapshot(snapshotPath, dir, (m) => messages.push(m), false);

    expect(messages[0]).toContain("has no instance stamp");
  });

  it("treats it as unstamped", async () => {
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

  it("names the exclude file it guards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-dash-ignore-"));

    tempDirs.push(dir);

    const messages: string[] = [];

    await ensureDashboardIgnored(dir, (m) => messages.push(m));

    expect(messages[0]).toContain(`${join(dir, ".git", "info", "exclude")}`);

    await readFile(join(dir, ".git", "info", "exclude"), "utf8");
  });

  it("excludes dashboard.html via .git/info/exclude", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-dash-ignore-"));

    tempDirs.push(dir);

    const messages: string[] = [];

    await ensureDashboardIgnored(dir, (m) => messages.push(m));

    const exclude = await readFile(
      join(dir, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain("dashboard.html");
  });
});

describe("lint-window exclude guard (issue #359)", () => {
  it("excludes the lint-window snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-lint-exclude-"));

    tempDirs.push(dir);

    await ensureLintWindowIgnored(dir, () => {});

    const exclude = await readFile(
      join(dir, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain("outputs/lint-window.json\n");
  });

  it("excludes its temp sibling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-lint-exclude-"));

    tempDirs.push(dir);

    await ensureLintWindowIgnored(dir, () => {});

    const exclude = await readFile(
      join(dir, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain("outputs/lint-window.json.tmp\n");
  });

  it("names the exclude path in the lint-window progress line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-lint-exclude-"));

    tempDirs.push(dir);

    const messages: string[] = [];
    await ensureLintWindowIgnored(dir, (m) => messages.push(m));

    expect(messages[0]).toContain(join(dir, ".git", "info", "exclude"));
  });

  it("appends nothing when the entries are already excluded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-lint-exclude-"));

    tempDirs.push(dir);

    const excludePath = join(dir, ".git", "info", "exclude");

    await ensureLintWindowIgnored(dir, () => {});
    const before = await readFile(excludePath, "utf8");

    await ensureLintWindowIgnored(dir, () => {});

    expect(await readFile(excludePath, "utf8")).toBe(before);
  });

  it("keeps the operator's exclude lines first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-lint-exclude-"));

    tempDirs.push(dir);

    const excludePath = join(dir, ".git", "info", "exclude");

    await mkdir(join(dir, ".git", "info"), { recursive: true });

    await writeFile(excludePath, "*.secret\n");

    await ensureLintWindowIgnored(dir, () => {});

    const exclude = await readFile(excludePath, "utf8");

    expect(exclude.startsWith("*.secret\n")).toBe(true);
  });

  it("still excludes the snapshot paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-lint-exclude-"));

    tempDirs.push(dir);

    const excludePath = join(dir, ".git", "info", "exclude");

    await mkdir(join(dir, ".git", "info"), { recursive: true });

    await writeFile(excludePath, "*.secret\n");

    await ensureLintWindowIgnored(dir, () => {});

    const exclude = await readFile(excludePath, "utf8");

    expect(exclude).toContain("outputs/lint-window.json");
  });
});

describe("committed-head anchor (issue #390)", () => {
  it("ignores a snapshot anchored outside HEAD's history", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    await mkdir(dirname(snapshotPath), { recursive: true });

    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        snapshotFor: dataRoot,
        committedHead: "f".repeat(40),
        vaults: {},
      })}\n`,
    );

    const messages: string[] = [];

    const snapshot = await readSnapshot(
      snapshotPath,
      dataRoot,
      (message) => messages.push(message),
      false,
    );

    expect(snapshot).toBeUndefined();
  });

  it("says why the snapshot was ignored", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    await mkdir(dirname(snapshotPath), { recursive: true });

    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        snapshotFor: dataRoot,
        committedHead: "f".repeat(40),
        vaults: {},
      })}\n`,
    );

    const messages: string[] = [];

    await readSnapshot(
      snapshotPath,
      dataRoot,
      (message) => messages.push(message),
      false,
    );

    expect(messages.join("\n")).toContain("not in this checkout's history");
  });

  it("uses a snapshot anchored to HEAD itself", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );
    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const run = promisify(execFile);
    const head = (
      await run("git", ["-C", dataRoot, "rev-parse", "HEAD"])
    ).stdout.trim();

    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        snapshotFor: dataRoot,
        committedHead: head,
        vaults: {},
      })}\n`,
    );

    const snapshot = await readSnapshot(
      snapshotPath,
      dataRoot,
      () => {},
      false,
    );

    expect(snapshot).toEqual({ vaults: {} });
  });

  it("anchors the written snapshot to the current head", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    const run = runContext({
      rawDir: join(dataRoot, "raw"),
      env: process.env,
    });

    await writeSnapshotIfNeeded(run, undefined, undefined, snapshotPath, {
      vaults: {},
    });

    const stored = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      committedHead: string | undefined;
      snapshotFor: string;
    };

    const { promisify } = await import("node:util");

    const { execFile } = await import("node:child_process");

    const head = (
      await promisify(execFile)("git", ["-C", dataRoot, "rev-parse", "HEAD"])
    ).stdout.trim();

    expect(stored.committedHead).toBe(head);
  });

  it("stamps the snapshot with the instance", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    const run = runContext({
      rawDir: join(dataRoot, "raw"),
      env: process.env,
    });

    await writeSnapshotIfNeeded(run, undefined, undefined, snapshotPath, {
      vaults: {},
    });

    const stored = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      committedHead: string | undefined;
      snapshotFor: string;
    };

    const { promisify } = await import("node:util");

    const { execFile } = await import("node:child_process");

    (
      await promisify(execFile)("git", ["-C", dataRoot, "rev-parse", "HEAD"])
    ).stdout.trim();

    expect(stored.snapshotFor).toBe(dataRoot);
  });
});

describe("deferred shared-cycle snapshot (issue #390 steering repair 3)", () => {
  it("builds the pending manifest without writing", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    const run = runContext({
      rawDir: join(dataRoot, "raw"),
      env: process.env,
    });

    const advance = buildSnapshotAdvance(undefined, undefined, {
      vaults: {},
    });

    expect(advance.manifest).toEqual({ vaults: {} });

    await readFile(snapshotPath, "utf8").catch(() => "absent");

    await writeSnapshotAdvance(snapshotPath, run, advance.manifest);

    JSON.parse(await readFile(snapshotPath, "utf8")) as {
      committedHead: string;
    };
  });

  it("leaves no snapshot file on disk", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    const run = runContext({
      rawDir: join(dataRoot, "raw"),
      env: process.env,
    });

    const advance = buildSnapshotAdvance(undefined, undefined, {
      vaults: {},
    });

    expect(await readFile(snapshotPath, "utf8").catch(() => "absent")).toBe(
      "absent",
    );

    await writeSnapshotAdvance(snapshotPath, run, advance.manifest);

    JSON.parse(await readFile(snapshotPath, "utf8")) as {
      committedHead: string;
    };
  });

  it("anchors the pending state to the given head", async () => {
    const dataRoot = await makeDataRepo({ "kept.md": "kept" }, (dir) =>
      tempDirs.push(dir),
    );

    const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_NAME);

    const run = runContext({
      rawDir: join(dataRoot, "raw"),
      env: process.env,
    });

    const advance = buildSnapshotAdvance(undefined, undefined, {
      vaults: {},
    });

    await readFile(snapshotPath, "utf8").catch(() => "absent");

    await writeSnapshotAdvance(snapshotPath, run, advance.manifest);

    const stored = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      committedHead: string;
    };

    expect(stored.committedHead).toBe(
      (
        await (
          await import("node:util")
        ).promisify((await import("node:child_process")).execFile)("git", [
          "-C",
          dataRoot,
          "rev-parse",
          "HEAD",
        ])
      ).stdout.trim(),
    );
  });
});
