import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLease } from "../../src/writer/lease-ops.ts";
import { readSharedWriterMarker } from "../../src/writer/marker.ts";
import { main } from "../../src/writer/recover-fix-surface.ts";
import { recordDirtyFailureSurface } from "../../src/writer/recovery-record.ts";
import {
  type CoordWorld,
  enabledDataRepo,
  LEASE_REF,
  NOW,
} from "./coordinator-world.ts";
import { makeWriterWorld, type WriterWorld } from "./git-world.ts";

const tempDirs: string[] = [];
const worlds: WriterWorld[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** CLI argv: action, <config>, <raw-dir> — the raw dir wins the
 *  data-repo resolution, so a placeholder config path is fine. */
function argv(action: string, cw: CoordWorld, extra: string[] = []) {
  return [
    action,
    join(cw.scratch, "sync.json"),
    join(cw.dataRoot, "raw"),
    ...extra,
  ];
}

/** The recorded-failure world: live lease held by writer-b, dirty
 *  tracked edit + untracked file, surface recorded. */
async function failedWorld(): Promise<{ world: WriterWorld; cw: CoordWorld }> {
  const world = await makeWriterWorld();
  worlds.push(world);
  const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

  await world.a.git(["fetch", "origin", "refs/heads/main"]);
  const attempt = await acquireLease({
    git: world.b.git,
    remote: "origin",
    leaseRef: LEASE_REF,
    treeOid: (await world.b.git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
    base: (await world.b.git(["rev-parse", "HEAD"])).stdout.trim(),
    now: NOW,
    holder: "failed-mac:9",
  });

  expect(attempt.status).toBe("acquired");

  await writeFile(join(cw.dataRoot, "wiki", "index.md"), "edited\n");
  await writeFile(join(cw.dataRoot, "untracked.md"), "partial\n");

  const marker = await readSharedWriterMarker(cw.dataRoot);

  if (marker.kind !== "enabled") {
    throw new Error("setup: the world's marker must be enabled");
  }

  await recordDirtyFailureSurface({
    git: world.a.git,
    marker: marker.marker,
  });

  return { world, cw };
}

/** Read a file's text, undefined when absent. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The verb's stdout under a swallowed console.log. */
async function captureStdout(run: () => Promise<void>): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  let out: string;

  try {
    await run();
    out = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
  } finally {
    logSpy.mockRestore();
  }

  return out;
}

/** The verb's stderr under a swallowed console.error. */
async function captureStderr(run: () => Promise<void>): Promise<string> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let err: string;

  try {
    await run();
    err = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
  } finally {
    errorSpy.mockRestore();
  }

  return err;
}

describe("recover-fix-surface help", () => {
  it("prints the usage line", async () => {
    const out = await captureStdout(() => main(["-h"]));

    expect(out).toContain("Usage: recover-fix-surface");
  });

  it("documents the --yes requirement", async () => {
    const out = await captureStdout(() => main(["-h"]));

    expect(out).toContain("--yes");
  });

  it("states what it writes", async () => {
    const out = await captureStdout(() => main(["-h"]));

    expect(out).toContain("What it writes");
  });

  it("exits 0 on help", async () => {
    await captureStdout(() => main(["-h"]));

    expect(process.exitCode).not.toBe(1);
  });
});

describe("recover-fix-surface show", () => {
  it("prints the recorded surface paths", async () => {
    const { cw } = await failedWorld();

    const out = await captureStdout(() => main(argv("show", cw)));

    expect(out).toContain("wiki/index.md");
  });

  it("prints the recorded lease holder", async () => {
    const { cw } = await failedWorld();

    const out = await captureStdout(() => main(argv("show", cw)));

    expect(out).toContain("failed-mac:9");
  });

  it("exits 0 on a matching surface", async () => {
    const { cw } = await failedWorld();

    await captureStdout(() => main(argv("show", cw)));

    expect(process.exitCode).not.toBe(1);
  });

  it("is the default action", async () => {
    const { cw } = await failedWorld();

    const out = await captureStdout(() =>
      main([join(cw.scratch, "sync.json"), join(cw.dataRoot, "raw")]),
    );

    expect(out).toContain("recorded fix surface of cycle");
  });

  it("reports nothing recorded", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const err = await captureStderr(() => main(argv("show", cw)));

    expect(err).toContain("nothing to recover");
  });

  it("exits 1 when nothing is recorded", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    await captureStderr(() => main(argv("show", cw)));

    expect(process.exitCode).toBe(1);
  });

  it("refuses on a mismatched surface, naming the human path", async () => {
    const { cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    const err = await captureStderr(() => main(argv("show", cw)));

    expect(err).toContain("human.md");
  });

  it("exits 1 on a mismatched surface", async () => {
    const { cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    await captureStderr(() => main(argv("show", cw)));

    expect(process.exitCode).toBe(1);
  });
});

describe("recover-fix-surface recover", () => {
  it("refuses without --yes", async () => {
    const { cw } = await failedWorld();

    const err = await captureStderr(() => main(argv("recover", cw)));

    expect(err).toContain("--yes");
  });

  it("changes nothing without --yes", async () => {
    const { cw } = await failedWorld();

    await captureStderr(() => main(argv("recover", cw)));

    expect(await readText(join(cw.dataRoot, "untracked.md"))).toBe("partial\n");
  });

  it("exits 1 without --yes", async () => {
    const { cw } = await failedWorld();

    await captureStderr(() => main(argv("recover", cw)));

    expect(process.exitCode).toBe(1);
  });

  it("discards the recorded paths with --yes", async () => {
    const { cw } = await failedWorld();

    const out = await captureStdout(() => main(argv("recover", cw, ["--yes"])));

    expect(out).toContain("discarded 2 recorded path(s)");
  });

  it("retakes the lease by exact OID with --yes", async () => {
    const { cw } = await failedWorld();

    const out = await captureStdout(() => main(argv("recover", cw, ["--yes"])));

    expect(out).toContain("lease retaken by exact OID");
  });

  it("restores the recorded tracked path with --yes", async () => {
    const { cw } = await failedWorld();

    await captureStdout(() => main(argv("recover", cw, ["--yes"])));

    expect(await readText(join(cw.dataRoot, "wiki", "index.md"))).toBe(
      "# Index\n",
    );
  });

  it("removes the recorded untracked path with --yes", async () => {
    const { cw } = await failedWorld();

    await captureStdout(() => main(argv("recover", cw, ["--yes"])));

    expect(await readText(join(cw.dataRoot, "untracked.md"))).toBeUndefined();
  });

  it("exits 0 on a completed recovery", async () => {
    const { cw } = await failedWorld();

    await captureStdout(() => main(argv("recover", cw, ["--yes"])));

    expect(process.exitCode).not.toBe(1);
  }, 30000);

  it("refuses on a mismatched surface", async () => {
    const { cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    const err = await captureStderr(() => main(argv("recover", cw, ["--yes"])));

    expect(err).toContain("human.md");
  });

  it("keeps the human edit on a refused recovery", async () => {
    const { cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    await captureStderr(() => main(argv("recover", cw, ["--yes"])));

    expect(await readText(join(cw.dataRoot, "human.md"))).toBe("by hand\n");
  });

  it("exits 1 on a mismatched surface", async () => {
    const { cw } = await failedWorld();

    await writeFile(join(cw.dataRoot, "human.md"), "by hand\n");

    await captureStderr(() => main(argv("recover", cw, ["--yes"])));

    expect(process.exitCode).toBe(1);
  });

  it("reports a repo without a marker", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));
    const { rm: rmDir } = await import("node:fs/promises");

    await rmDir(join(cw.dataRoot, ".k-wiki"), { recursive: true, force: true });

    const err = await captureStderr(() => main(argv("recover", cw, ["--yes"])));

    expect(err).toContain("not enabled");
  });

  it("refuses an unknown action", async () => {
    const world = await makeWriterWorld();
    worlds.push(world);
    const cw = await enabledDataRepo(world, (dir) => tempDirs.push(dir));

    const err = await captureStderr(() => main(argv("force-clean", cw)));

    expect(err).toContain("unknown action");
  });
});
