import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CycleHeartbeat,
  classifyHeartbeat,
  cycleHeartbeatPath,
  formatAge,
  parseHeartbeat,
  readCycleHeartbeat,
  readWatchdogSince,
  watchdogSincePath,
  writeCycleHeartbeat,
  writeWatchdogSince,
} from "../../src/schedule/heartbeat.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDataRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-heartbeat-"));

  tempDirs.push(dir);

  return dir;
}

/** A valid stamp. */
function stamp(overrides: Partial<CycleHeartbeat> = {}): CycleHeartbeat {
  return {
    timestamp: "2026-09-20T10:00:00.000Z",
    outcome: "ok",
    pid: 4242,
    lastOk: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

/** Write a stamp fixture directly, bypassing the writer. */
async function putStamp(dataRoot: string, value: unknown): Promise<void> {
  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(
    cycleHeartbeatPath(dataRoot),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

describe("parseHeartbeat", () => {
  it("parses a complete stamp", () => {
    expect(parseHeartbeat(JSON.stringify(stamp()))).toEqual(stamp());
  });

  it("rejects bytes that are not JSON", () => {
    expect(parseHeartbeat("{oops")).toEqual({
      reason: expect.stringContaining("not valid JSON"),
    });
  });

  it("rejects JSON without a usable timestamp", () => {
    expect(
      parseHeartbeat(JSON.stringify(stamp({ timestamp: "yesterday" }))),
    ).toEqual({ reason: "missing or invalid timestamp, outcome, or pid" });
  });

  it("rejects an outcome outside ok|failed", () => {
    const foreign = { ...stamp(), outcome: "skipped" } as Record<
      string,
      unknown
    >;

    expect(parseHeartbeat(JSON.stringify(foreign))).toEqual({
      reason: "missing or invalid timestamp, outcome, or pid",
    });
  });

  it("drops an unparseable lastOk instead of trusting it", () => {
    const parsed = parseHeartbeat(
      JSON.stringify(stamp({ lastOk: "not a date" })),
    );

    expect("reason" in parsed).toBe(false);
  });

  it("keeps a dropped lastOk readable as null", () => {
    const parsed = parseHeartbeat(
      JSON.stringify(stamp({ lastOk: "not a date" })),
    );

    expect("lastOk" in parsed ? parsed.lastOk : undefined).toBeNull();
  });
});

describe("readCycleHeartbeat", () => {
  it("reads missing when no stamp exists", async () => {
    expect(await readCycleHeartbeat(await tempDataRoot())).toEqual({
      kind: "missing",
    });
  });

  it("reads present for a valid stamp", async () => {
    const dataRoot = await tempDataRoot();

    await putStamp(dataRoot, stamp());

    expect(await readCycleHeartbeat(dataRoot)).toEqual({
      kind: "present",
      stamp: stamp(),
    });
  });

  it("reads unreadable for garbage bytes", async () => {
    const dataRoot = await tempDataRoot();

    await putStamp(dataRoot, "garbage");

    expect(await readCycleHeartbeat(dataRoot)).toEqual({
      kind: "unreadable",
      reason: expect.any(String),
    });
  });
});

describe("writeCycleHeartbeat", () => {
  it("writes the stamp this cycle completed with", async () => {
    const dataRoot = await tempDataRoot();

    await writeCycleHeartbeat({
      dataRoot,
      outcome: "ok",
      pid: 99,
      now: new Date("2026-09-20T11:00:00.000Z"),
    });

    expect(
      JSON.parse(await readFile(cycleHeartbeatPath(dataRoot), "utf8")),
    ).toEqual({
      timestamp: "2026-09-20T11:00:00.000Z",
      outcome: "ok",
      pid: 99,
      lastOk: "2026-09-20T11:00:00.000Z",
    });
  });

  it("leaves no tmp file behind", async () => {
    const dataRoot = await tempDataRoot();

    await writeCycleHeartbeat({
      dataRoot,
      outcome: "ok",
      pid: 99,
      now: new Date("2026-09-20T11:00:00.000Z"),
    });

    await expect(stat(`${cycleHeartbeatPath(dataRoot)}.tmp`)).rejects.toThrow();
  });

  it("excludes the stamp via .git/info/exclude and announces it once", async () => {
    const dataRoot = await tempDataRoot();
    const lines: string[] = [];

    await writeCycleHeartbeat({
      dataRoot,
      outcome: "ok",
      pid: 99,
      now: new Date("2026-09-20T11:00:00.000Z"),
      onProgress: (line) => lines.push(line),
    });

    const exclude = await readFile(
      join(dataRoot, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain("outputs/last-cycle.json");
  });

  it("announces the exclusion only on the first write", async () => {
    const dataRoot = await tempDataRoot();
    const lines: string[] = [];
    const onProgress = (line: string): void => {
      lines.push(line);
    };

    for (const hour of [10, 11]) {
      await writeCycleHeartbeat({
        dataRoot,
        outcome: "ok",
        pid: 99,
        now: new Date(`2026-09-20T${String(hour).padStart(2, "0")}:00:00.000Z`),
        onProgress,
      });
    }

    expect(lines).toHaveLength(1);
  });

  it("carries the last-ok timestamp through a failed cycle", async () => {
    const dataRoot = await tempDataRoot();

    await writeCycleHeartbeat({
      dataRoot,
      outcome: "ok",
      pid: 1,
      now: new Date("2026-09-20T10:00:00.000Z"),
    });
    await writeCycleHeartbeat({
      dataRoot,
      outcome: "failed",
      pid: 2,
      now: new Date("2026-09-20T10:30:00.000Z"),
    });

    const read = await readCycleHeartbeat(dataRoot);

    expect(read).toEqual({
      kind: "present",
      stamp: {
        timestamp: "2026-09-20T10:30:00.000Z",
        outcome: "failed",
        pid: 2,
        lastOk: "2026-09-20T10:00:00.000Z",
      },
    });
  });

  it("leaves lastOk null when a failed cycle follows no success", async () => {
    const dataRoot = await tempDataRoot();

    await writeCycleHeartbeat({
      dataRoot,
      outcome: "failed",
      pid: 1,
      now: new Date("2026-09-20T10:00:00.000Z"),
    });

    const read = await readCycleHeartbeat(dataRoot);

    expect(
      read.kind === "present" ? read.stamp.lastOk : "not present",
    ).toBeNull();
  });

  it("treats an unreadable previous stamp as no success on record", async () => {
    const dataRoot = await tempDataRoot();

    await putStamp(dataRoot, "garbage");
    await writeCycleHeartbeat({
      dataRoot,
      outcome: "failed",
      pid: 1,
      now: new Date("2026-09-20T10:00:00.000Z"),
    });

    const read = await readCycleHeartbeat(dataRoot);

    expect(
      read.kind === "present" ? read.stamp.lastOk : "not present",
    ).toBeNull();
  });
});

describe("classifyHeartbeat", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");
  const threshold = 90 * 60_000;

  it("classifies a stamp inside the threshold as fresh", () => {
    expect(
      classifyHeartbeat(
        stamp({ timestamp: "2026-09-20T11:00:00.000Z" }),
        now,
        threshold,
      ),
    ).toEqual({ verdict: "fresh", ageMs: 60 * 60_000 });
  });

  it("counts the boundary age itself as fresh", () => {
    expect(
      classifyHeartbeat(
        stamp({ timestamp: "2026-09-20T10:30:00.000Z" }),
        now,
        threshold,
      ),
    ).toEqual({ verdict: "fresh", ageMs: threshold });
  });

  it("classifies a stamp past the threshold as stale", () => {
    expect(
      classifyHeartbeat(
        stamp({ timestamp: "2026-09-20T10:29:59.999Z" }),
        now,
        threshold,
      ),
    ).toEqual({ verdict: "stale", ageMs: threshold + 1 });
  });
});

describe("formatAge", () => {
  it("formats a minutes-only age", () => {
    expect(formatAge(45 * 60_000)).toBe("45m");
  });

  it("formats a whole-hours age without minutes", () => {
    expect(formatAge(3 * 3_600_000)).toBe("3h");
  });

  it("formats hours with a minutes remainder", () => {
    expect(formatAge((3 * 60 + 5) * 60_000)).toBe("3h 5m");
  });

  it("formats days with an hours remainder", () => {
    expect(formatAge((2 * 24 + 4) * 3_600_000)).toBe("2d 4h");
  });

  it("formats a whole-days age without hours", () => {
    expect(formatAge(2 * 86_400_000)).toBe("2d");
  });

  it("clamps a negative age to zero minutes", () => {
    expect(formatAge(-5_000)).toBe("0m");
  });
});

describe("watchdog grace anchor", () => {
  it("writes and reads the anchor as one ISO line", async () => {
    const dataRoot = await tempDataRoot();
    const now = new Date("2026-09-20T11:00:00.000Z");

    await writeWatchdogSince({ dataRoot, now });

    expect((await readWatchdogSince(dataRoot))?.getTime()).toBe(now.getTime());
    expect(await readFile(watchdogSincePath(dataRoot), "utf8")).toBe(
      "2026-09-20T11:00:00.000Z\n",
    );
  });

  it("reads undefined when no anchor exists", async () => {
    expect(await readWatchdogSince(await tempDataRoot())).toBeUndefined();
  });

  it("reads undefined for unusable anchor bytes", async () => {
    const dataRoot = await tempDataRoot();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await writeFile(watchdogSincePath(dataRoot), "garbage", "utf8");

    expect(await readWatchdogSince(dataRoot)).toBeUndefined();
  });

  it("excludes the anchor via .git/info/exclude", async () => {
    const dataRoot = await tempDataRoot();

    await writeWatchdogSince({ dataRoot, now: new Date() });

    expect(
      await readFile(join(dataRoot, ".git", "info", "exclude"), "utf8"),
    ).toContain("outputs/watchdog-since.txt");
  });
});
