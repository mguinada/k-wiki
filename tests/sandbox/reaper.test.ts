import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunContext } from "../../src/cli/run-context.ts";
import {
  readExpiresStamp,
  reapExpiredSandboxNotes,
} from "../../src/sandbox/reaper.ts";

/**
 * The sandbox TTL reaper (issue #338, decision 6 of #289): strictly-
 * past `expires:` stamps delete, everything else survives, and the
 * sweep is idempotent — reaping an already-reaped note is a no-op.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A fixed clock: today is 2026-08-20. */
const NOW = () => new Date("2026-08-20T12:00:00.000Z");

/** The run context for a data repo, recording progress. */
function contextFor(dataRoot: string, messages: string[]): RunContext {
  return {
    dataRoot,
    rawDir: join(dataRoot, "raw"),
    wikiDir: join(dataRoot, "wiki"),
    env: process.env,
    now: NOW,
    onProgress: (message) => messages.push(message),
  };
}

/** A data repo root with `wiki/sandbox/` seeded with the given pages. */
async function makeRepo(
  pages: Record<string, string>,
): Promise<{ dataRoot: string; run: RunContext; messages: string[] }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-reaper-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw"), { recursive: true });

  for (const [rel, text] of Object.entries(pages)) {
    await mkdir(dirname(join(dataRoot, "wiki", "sandbox", rel)), {
      recursive: true,
    });
    await writeFile(join(dataRoot, "wiki", "sandbox", rel), text);
  }

  const messages: string[] = [];

  return { dataRoot, run: contextFor(dataRoot, messages), messages };
}

/** A stamped sandbox page body. */
function page(expires: string): string {
  return [
    "---",
    "via: agent",
    `expires: ${expires}`,
    "---",
    "",
    "Proposal body.",
    "",
  ].join("\n");
}

/** A file's text, or null when absent. */
async function textOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

describe("readExpiresStamp", () => {
  it("reads the top-level expires scalar", () => {
    expect(readExpiresStamp(page("2026-08-27"))).toBe("2026-08-27");
  });

  it("unquotes a quoted scalar", () => {
    const text = ["---", 'expires: "2026-08-27"', "---", ""].join("\n");

    expect(readExpiresStamp(text)).toBe("2026-08-27");
  });

  it("ignores an expires line in the body", () => {
    const text = [
      "---",
      "via: agent",
      "---",
      "",
      "expires: 2026-08-27",
      "",
    ].join("\n");

    expect(readExpiresStamp(text)).toBeUndefined();
  });

  it("returns undefined without a closed frontmatter block", () => {
    expect(readExpiresStamp("---\nexpires: 2026-08-27\nbody")).toBeUndefined();
  });

  it("returns undefined without frontmatter", () => {
    expect(readExpiresStamp("no frontmatter\n")).toBeUndefined();
  });
});

describe("reapExpiredSandboxNotes", () => {
  it("deletes a note whose expires date is strictly past", async () => {
    const { dataRoot, run } = await makeRepo({
      "past-note.md": page("2026-08-19"),
    });

    const result = await reapExpiredSandboxNotes(run);

    expect(result.reaped).toEqual(["wiki/sandbox/past-note.md"]);
    await expect(
      textOrNull(join(dataRoot, "wiki", "sandbox", "past-note.md")),
    ).resolves.toBeNull();
  });

  it("keeps a note that expires today (edge 1: strictly past)", async () => {
    const { dataRoot, run } = await makeRepo({
      "today-note.md": page("2026-08-20"),
    });

    const result = await reapExpiredSandboxNotes(run);

    expect(result.reaped).toEqual([]);
    await expect(
      textOrNull(join(dataRoot, "wiki", "sandbox", "today-note.md")),
    ).resolves.toContain("Proposal body.");
  });

  it("keeps a note with a future expiry", async () => {
    const { run } = await makeRepo({ "future-note.md": page("2027-01-01") });

    expect((await reapExpiredSandboxNotes(run)).reaped).toEqual([]);
  });

  it("keeps a note whose stamp is not a plain date", async () => {
    const { run } = await makeRepo({
      "malformed.md": page("next tuesday"),
      "empty.md": page(""),
    });

    expect((await reapExpiredSandboxNotes(run)).reaped).toEqual([]);
  });

  it("keeps a note without an expires stamp", async () => {
    const { run } = await makeRepo({
      "unstamped.md": "---\nvia: agent\n---\n\nBody.\n",
    });

    expect((await reapExpiredSandboxNotes(run)).reaped).toEqual([]);
  });

  it("reaps nested sandbox pages too", async () => {
    const { run } = await makeRepo({ "drafts/nested.md": page("2026-08-01") });

    const result = await reapExpiredSandboxNotes(run);

    expect(result.reaped).toEqual(["wiki/sandbox/drafts/nested.md"]);
  });

  it("is idempotent: a second sweep reaps nothing", async () => {
    const { run } = await makeRepo({ "past-note.md": page("2026-08-19") });

    await reapExpiredSandboxNotes(run);

    expect((await reapExpiredSandboxNotes(run)).reaped).toEqual([]);
  });

  it("is a silent no-op when the sandbox namespace is absent", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-reaper-"));

    tempDirs.push(dataRoot);

    const messages: string[] = [];
    const result = await reapExpiredSandboxNotes(
      contextFor(dataRoot, messages),
    );

    expect(result.reaped).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("reports one progress line naming the reaped pages", async () => {
    const { run, messages } = await makeRepo({
      "a.md": page("2026-08-19"),
      "b.md": page("2026-08-18"),
      "c.md": page("2027-01-01"),
    });

    await reapExpiredSandboxNotes(run);

    expect(messages).toEqual([
      "sandbox: reaper — deleted 2 expired notes: wiki/sandbox/a.md, wiki/sandbox/b.md",
    ]);
  });
});
