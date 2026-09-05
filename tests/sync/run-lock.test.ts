import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  holderDescription,
  LOCK_STALE_MS,
  lockData,
  readLockHolder,
  releaseLock,
  runLockPath,
} from "../../src/sync/run-lock.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    rm: vi.fn(
      async (
        path: string | URL,
        options?: { force?: boolean; recursive?: boolean },
      ) => actual.rm(path, options),
    ),
    rename: vi.fn(async (from: string | URL, to: string | URL) =>
      actual.rename(from, to),
    ),
    link: vi.fn(async (from: string | URL, to: string | URL) =>
      actual.link(from, to),
    ),
  };
});

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "k-wiki-lock-"));
}

describe("acquireLock", () => {
  it("creates the lock file with the current pid and an ISO timestamp", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    expect(await acquireLock(lockPath)).toBe("acquired");

    const lock = lockData(await readFile(lockPath, "utf8"));

    expect(lock?.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(lock?.takenAt ?? "x"))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it("reports busy while a fresh lock exists", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await acquireLock(lockPath);

    expect(await acquireLock(lockPath)).toBe("busy");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("takes over a lock older than the stale timeout", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const now = new Date("2026-01-01T00:00:00Z");

    await acquireLock(lockPath, {
      now: () => new Date(now.getTime() - LOCK_STALE_MS - 1),
    });

    expect(await acquireLock(lockPath, { now: () => now })).toBe("took-over");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("takes over an unreadable lock instead of hanging", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await writeFile(lockPath, "");

    expect(await acquireLock(lockPath)).toBe("took-over");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });

  it("reports busy when a racing acquirer recreates the lock during takeover", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 1, takenAt: "2020-01-01T00:00:00Z" })}\n`,
    );
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      await realFs.rm(path, options);

      if (path === lockPath) {
        await realFs.writeFile(
          lockPath,
          `${JSON.stringify({ pid: 4242, takenAt: new Date().toISOString() })}\n`,
        );
      }
    });

    expect(await acquireLock(lockPath)).toBe("busy");

    await releaseLock(lockPath);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("releaseLock", () => {
  it("removes the lock file and tolerates an absent one", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await acquireLock(lockPath);
    await releaseLock(lockPath);

    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    await expect(releaseLock(lockPath)).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a successor's lock whose recorded pid is not this process's", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 4242, takenAt: new Date().toISOString() })}\n`,
    );
    await releaseLock(lockPath, 1111);

    await expect(readFile(lockPath, "utf8")).resolves.toContain("4242");

    await releaseLock(lockPath, 4242);

    await expect(readFile(lockPath, "utf8")).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });
});

/** The lock JSON of a given pid, as a successor writes it. */
function lockJson(pid: number): string {
  return `${JSON.stringify({ pid, takenAt: "2026-01-01T00:00:00Z" })}\n`;
}

describe("releaseLock takeover race", () => {
  it("never deletes a successor's fresh lock that lands during the release", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(lockPath, lockJson(1111));
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      // The successor's takeover completes while the releaser is
      // between its pid check and its delete: the path now holds the
      // successor's fresh lock.
      await realFs.rm(lockPath, { force: true });
      await realFs.writeFile(lockPath, lockJson(4242));

      return realFs.rm(path, options);
    });

    await releaseLock(lockPath, 1111);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockJson(4242));

    await rm(dir, { recursive: true, force: true });
  });

  it("restores a successor's lock claimed by the release's rename", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(lockPath, lockJson(1111));
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      // The successor's takeover lands inside the read-to-rename
      // window: the claim moves the successor's fresh lock away.
      await realFs.rm(from, { force: true });
      await realFs.writeFile(from, lockJson(4242));

      return realFs.rename(from, to);
    });

    await releaseLock(lockPath, 1111);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockJson(4242));

    await rm(dir, { recursive: true, force: true });
  });

  it("drops the claim when another run already re-holds the lock path", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(lockPath, lockJson(1111));
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await realFs.rm(from, { force: true });
      await realFs.writeFile(from, lockJson(4242));

      return realFs.rename(from, to);
    });
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      // A third run acquires the free path before the restore lands.
      await realFs.writeFile(to, lockJson(5151));

      return realFs.link(from, to);
    });

    await releaseLock(lockPath, 1111);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockJson(5151));

    await rm(dir, { recursive: true, force: true });
  });

  it("resolves cleanly when the lock vanished before the claim", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(lockPath, lockJson(1111));
    vi.mocked(rename).mockImplementationOnce(async () => {
      // The lock is already gone at claim time — another releaser or
      // a takeover removed it and nothing recreated it yet.
      await realFs.rm(lockPath, { force: true });
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });

    await expect(releaseLock(lockPath, 1111)).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  it("leaves no lock file behind when the lock vanished before the claim", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const realFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    await writeFile(lockPath, lockJson(1111));
    vi.mocked(rename).mockImplementationOnce(async () => {
      // The lock is already gone at claim time — another releaser or
      // a takeover removed it and nothing recreated it yet.
      await realFs.rm(lockPath, { force: true });
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });

    await releaseLock(lockPath, 1111);
    await expect(realFs.stat(lockPath)).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("runLockPath", () => {
  it("keys the lock on the data repo root", async () => {
    expect(runLockPath("/tmp/k-wiki-engineering-data")).toBe(
      "/tmp/k-wiki-engineering-data/.scheduled-run.lock",
    );
  });
});

describe("readLockHolder", () => {
  it("reads the holder of an existing lock", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await writeFile(lockPath, lockJson(4242));

    expect(await readLockHolder(lockPath)).toEqual({
      pid: 4242,
      takenAt: "2026-01-01T00:00:00Z",
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("reports undefined for an absent lock", async () => {
    const dir = await tempDir();

    expect(await readLockHolder(join(dir, "gone.lock"))).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("holderDescription", () => {
  it("names the holder's local start time and PID", () => {
    const midnight = new Date("2026-01-01T00:00:00");

    expect(
      holderDescription({
        pid: 4242,
        takenAt: midnight.toISOString(),
      }),
    ).toBe(`in progress since 00:00 (PID 4242)`);
  });
});

describe("acquireLock (issue #240 kill batch)", () => {
  it("fails loud on a lock path that is a directory instead of wedging silently", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");

    await mkdir(lockPath);

    await expect(acquireLock(lockPath)).rejects.toMatchObject({
      code: "ERR_FS_EISDIR",
    });

    await rm(dir, { recursive: true, force: true });
  });
});

describe("lockData", () => {
  it("parses a written lock and rejects garbage", () => {
    const parsed = lockData('{"pid":42,"takenAt":"2026-01-01T00:00:00Z"}');

    expect(parsed).toEqual({ pid: 42, takenAt: "2026-01-01T00:00:00Z" });
    expect(lockData("not json")).toBeUndefined();
    expect(lockData('{"takenAt":"2026-01-01T00:00:00Z"}')).toBeUndefined();
  });

  it("rejects a non-object lock, a non-numeric pid, and a non-string timestamp", () => {
    expect(lockData("42")).toBeUndefined();
    expect(lockData('"str"')).toBeUndefined();
    expect(
      lockData('{"pid":"42","takenAt":"2026-01-01T00:00:00Z"}'),
    ).toBeUndefined();
    expect(lockData('{"pid":42,"takenAt":42}')).toBeUndefined();
  });
});

describe("LOCK_STALE_MS", () => {
  it("gives a run two hours before its lock goes stale", () => {
    expect(LOCK_STALE_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe("acquireLock edge cases", () => {
  it("takes over a lock that is exactly the stale age", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const now = new Date("2026-01-01T00:00:00Z");

    await acquireLock(lockPath, {
      now: () => new Date(now.getTime() - LOCK_STALE_MS),
    });

    expect(await acquireLock(lockPath, { now: () => now })).toBe("took-over");

    await rm(dir, { recursive: true, force: true });
  });

  it("writes the takeover with the injected clock and pid", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "scheduled-run.lock");
    const takenAt = new Date("2026-01-01T00:00:00Z");

    await acquireLock(lockPath, { now: () => new Date(0) });
    await acquireLock(lockPath, { now: () => takenAt, pid: 4242 });

    const lock = lockData(await readFile(lockPath, "utf8"));

    expect(lock).toEqual({ pid: 4242, takenAt: takenAt.toISOString() });

    await rm(dir, { recursive: true, force: true });
  });

  it("propagates a non-EEXIST open failure instead of reporting busy", async () => {
    await expect(
      acquireLock(join(await tempDir(), "missing-dir", "scheduled-run.lock")),
    ).rejects.toThrow();
  });
});
