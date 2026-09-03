import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { warnTrackedIgnored } from "../../src/ingest/snapshot.ts";

/**
 * snapshot unit tests (issue #258, moved with the module from
 * wiki-ingest.test.ts): the gitignore guards, the legacy snapshot
 * adoption, and the tracked-but-ignored pre-flight warning.
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
