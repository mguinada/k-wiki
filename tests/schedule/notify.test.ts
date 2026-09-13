import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  type NotifiedProcess,
  type NotifySpawner,
  notifyUser,
} from "../../src/schedule/notify.ts";

/** A child that settles (emits close) on the next tick. */
function settlingChild(
  onSpawn: () => void,
  event: "close" | "error" = "close",
): NotifiedProcess {
  const child = new EventEmitter();

  setImmediate(() => {
    onSpawn();
    child.emit(event, event === "error" ? new Error("ENOENT") : 0);
  });

  return child as unknown as NotifiedProcess;
}

/** A fake spawner recording every spawn. */
function fakeSpawner(event: "close" | "error" = "close"): {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
  }[];
  readonly spawn: NotifySpawner;
} {
  const calls: { command: string; args: readonly string[] }[] = [];

  return {
    calls,
    spawn: (command, args) =>
      settlingChild(() => calls.push({ command, args }), event),
  };
}

describe("notifyUser", () => {
  it("spawns osascript with the notification script on darwin", async () => {
    const fake = fakeSpawner();

    await notifyUser("k-wiki", "cycle failed", {
      platform: "darwin",
      notifyDisabled: false,
      spawner: fake.spawn,
    });

    expect(fake.calls).toEqual([
      {
        command: "osascript",
        args: ["-e", 'display notification "cycle failed" with title "k-wiki"'],
      },
    ]);
  });

  it("escapes double quotes in the message", async () => {
    const fake = fakeSpawner();

    await notifyUser("k-wiki", 'push "rejected"', {
      platform: "darwin",
      notifyDisabled: false,
      spawner: fake.spawn,
    });

    expect(fake.calls[0]?.args[1]).toContain(
      'notification "push \\"rejected\\""',
    );
  });

  it("spawns nothing off darwin", async () => {
    const fake = fakeSpawner();

    await notifyUser("k-wiki", "message", {
      platform: "linux",
      notifyDisabled: false,
      spawner: fake.spawn,
    });

    expect(fake.calls).toEqual([]);
  });

  it("spawns nothing when notifications are disabled", async () => {
    const fake = fakeSpawner();

    await notifyUser("k-wiki", "message", {
      platform: "darwin",
      notifyDisabled: true,
      spawner: fake.spawn,
    });

    expect(fake.calls).toEqual([]);
  });

  it("stays silent when osascript is missing (spawn error)", async () => {
    const fake = fakeSpawner("error");

    await expect(
      notifyUser("k-wiki", "message", {
        platform: "darwin",
        notifyDisabled: false,
        spawner: fake.spawn,
      }),
    ).resolves.toBeUndefined();
  });
});
