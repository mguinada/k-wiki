/**
 * The quota-skip stamp ordering (issue #463 §4): a quota skip writes
 * its benign skipped heartbeat before releasing the scheduler's
 * lock, so a concurrent next tick can never acquire the lock — let
 * alone overwrite the stamp — while the older skip is still
 * recording. Here the deferral is the proof: the skip's heartbeat
 * write is held back, a second tick is attempted concurrently, and
 * it must see the lock held; after the stamp lands, the lock
 * releases and the second tick has already been refused. An
 * un-ordered implementation (stamp after release) would let the
 * second tick acquire the lock and complete before the first stamp
 * lands.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cycleHeartbeatPath } from "../../src/schedule/heartbeat.ts";
import { runScheduledCycle } from "../../src/schedule/scheduled-run.ts";

let deferredWrite: (() => void) | undefined;
let writeObserved = false;

vi.mock("../../src/schedule/heartbeat.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/schedule/heartbeat.ts")>();

  return {
    ...actual,
    writeCycleHeartbeat: vi.fn(
      async (options: Parameters<typeof actual.writeCycleHeartbeat>[0]) => {
        writeObserved = true;

        await new Promise<void>((resolve) => {
          deferredWrite = resolve;
        });

        await actual.writeCycleHeartbeat(options);
      },
    ),
  };
});

afterEach(() => {
  deferredWrite = undefined;
  writeObserved = false;
  vi.restoreAllMocks();
});

describe("quota-skip stamp ordering (issue #463)", () => {
  it("records the skip stamp under the lock, before a later tick can run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-stamp-"));
    const lockPath = join(dir, ".scheduled-run.lock");
    const findings: Record<string, unknown> = {};

    const first = runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep: async () => ({}),
      runSync: async () => {
        throw new Error("must never start");
      },
      runQuotaPreflight: async () => ({
        status: "skip",
        reason:
          "quota — ingest provider zai scope all_models exhausted_now, reset unknown",
      }),
      log: () => {},
    });

    while (!writeObserved) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const second = runScheduledCycle({
      dataRoot: dir,
      repoRoot: dir,
      lockPath,
      runGitStep: async () => ({}),
      runSync: async () => {},
      runQuotaPreflight: async () => ({ status: "proceed" }),
      log: () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const heldBackWrite = deferredWrite;

    deferredWrite?.();
    deferredWrite = undefined;

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    findings.skipHeldBackWrite = heldBackWrite !== undefined;
    findings.skipOutcome = firstOutcome;

    findings.laterTickSeesBusyLock =
      secondOutcome.status === "skipped" &&
      secondOutcome.reason.includes("another run holds the lock");

    const stamp = JSON.parse(
      await readFile(cycleHeartbeatPath(dir), "utf8"),
    ) as {
      outcome?: string;
      reason?: string;
    };
    findings.firstTicksStampRecorded = {
      outcome: stamp.outcome,
      reason: stamp.reason,
    };

    expect(findings).toEqual({
      skipHeldBackWrite: true,
      skipOutcome: {
        status: "skipped",
        reason:
          "quota — ingest provider zai scope all_models exhausted_now, reset unknown",
      },
      laterTickSeesBusyLock: true,
      firstTicksStampRecorded: {
        outcome: "skipped",
        reason:
          "quota — ingest provider zai scope all_models exhausted_now, reset unknown",
      },
    });

    await rm(dir, { recursive: true, force: true });
  });
});
