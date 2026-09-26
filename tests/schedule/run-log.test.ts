import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendLog,
  createRunLog,
  rotateLogIfNeeded,
} from "../../src/schedule/run-log.ts";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "k-wiki-run-log-"));
}

describe("appendLog", () => {
  it("never rejects when the log path is unwritable", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "blocker");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await writeFile(blocker, "not a dir");

    try {
      await expect(
        appendLog(join(blocker, "nested", "run.log"), "line"),
      ).resolves.toBeUndefined();
    } finally {
      errors.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rotates a log that has reached 5 MiB to .1 before appending", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "scheduled-run.log");

    await writeFile(logPath, "x".repeat(5 * 1024 * 1024 + 1));
    await appendLog(logPath, "fresh line");

    const [rotated, fresh] = await Promise.all([
      readFile(`${logPath}.1`, "utf8"),
      readFile(logPath, "utf8"),
    ]);

    expect([rotated.length, fresh]).toEqual([
      5 * 1024 * 1024 + 1,
      "fresh line\n",
    ]);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("createRunLog", () => {
  it("holds the next line back while one append is in flight", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const started: string[] = [];
    const append = async (_logPath: string, line: string): Promise<void> => {
      started.push(line);

      if (line === "first") {
        await gate;
      }
    };
    const runLog = createRunLog("/tmp/unused.log", append);

    runLog.log("first");
    runLog.log("second");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(started).toEqual(["first"]);

    releaseFirst();
    await runLog.flush();
  });

  it("records queued lines in arrival order once the gate opens", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const appended: string[] = [];
    const append = async (_logPath: string, line: string): Promise<void> => {
      if (line === "first") {
        await gate;
      }

      appended.push(line);
    };
    const runLog = createRunLog("/tmp/unused.log", append);

    runLog.log("first");
    runLog.log("second");
    runLog.log("third");
    releaseFirst();
    await runLog.flush();

    expect(appended).toEqual(["first", "second", "third"]);
  });

  it("writes every queued line through appendLog into the file", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "run.log");
    const lines = Array.from({ length: 50 }, (_, index) => `line-${index}`);
    const runLog = createRunLog(logPath);

    for (const line of lines) {
      runLog.log(line);
    }

    await runLog.flush();

    expect(
      (await readFile(logPath, "utf8")).split("\n").filter(Boolean),
    ).toEqual(lines);

    await rm(dir, { recursive: true, force: true });
  });

  it("resolves flush immediately when nothing was logged", async () => {
    const runLog = createRunLog("/tmp/unused.log");

    await expect(runLog.flush()).resolves.toBeUndefined();
  });
});

describe("appendLog failure reporting", () => {
  it("reports a failed log write to stderr", async () => {
    const dir = await tempDir();
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) =>
        errors.push(parts.join(" ")),
      );

    try {
      await appendLog(dir, "a line that cannot be written");
    } finally {
      spy.mockRestore();
    }

    expect(errors.join("\n")).toContain("log write failed");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("rotateLogIfNeeded default threshold", () => {
  it("keeps a one-byte log in place", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "scheduled-run.log");

    await writeFile(logPath, "x");
    await rotateLogIfNeeded(logPath);

    await expect(readFile(logPath, "utf8")).resolves.toBe("x");
    await expect(readFile(`${logPath}.1`, "utf8")).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a six-kilobyte log in place", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "scheduled-run.log");

    await writeFile(logPath, "x".repeat(6 * 1024));
    await rotateLogIfNeeded(logPath);

    await expect(readFile(`${logPath}.1`, "utf8")).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it("rotates a log of exactly five MiB", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "scheduled-run.log");

    await writeFile(logPath, "x".repeat(5 * 1024 * 1024));
    await rotateLogIfNeeded(logPath);

    await expect(readFile(`${logPath}.1`, "utf8")).resolves.toBe(
      "x".repeat(5 * 1024 * 1024),
    );

    await rm(dir, { recursive: true, force: true });
  });
});
