import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  serializeManifest,
  writeManifest,
} from "../src/sync/manifest.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-manifest-"));

  tempDirs.push(dir);

  return dir;
}

const ONE_ENTRY = {
  hash: "0".repeat(64),
  last_synced: "2026-08-16T15:00:00.000Z",
};

describe("emptyManifest", () => {
  it("starts with no vaults", () => {
    expect(emptyManifest()).toEqual({ vaults: {} });
  });
});

describe("parseManifest", () => {
  it("parses the multi-vault manifest shape", () => {
    const text = JSON.stringify({
      vaults: {
        work: { "AI/RAG.md": ONE_ENTRY },
        personal: { "Notes.md": ONE_ENTRY },
      },
    });

    expect(parseManifest(text, "manifest.json")).toEqual({
      vaults: {
        work: { "AI/RAG.md": ONE_ENTRY },
        personal: { "Notes.md": ONE_ENTRY },
      },
    });
  });

  it("rejects text that is not valid JSON", () => {
    expect(() => parseManifest("{ nope", "manifest.json")).toThrow(
      /invalid manifest at manifest\.json: not valid JSON/,
    );
  });

  it("rejects a manifest without a vaults object", () => {
    expect(() => parseManifest("[]", "manifest.json")).toThrow(/vaults/);
  });

  it("rejects a vault entry that is not an object", () => {
    const text = JSON.stringify({ vaults: { work: 7 } });

    expect(() => parseManifest(text, "manifest.json")).toThrow(/vault "work"/);
  });

  it("rejects a note entry missing last_synced", () => {
    const text = JSON.stringify({
      vaults: { work: { "AI/RAG.md": { hash: "x" } } },
    });

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /entry "AI\/RAG\.md"/,
    );
  });
});

describe("serializeManifest", () => {
  it("serializes with two-space indent and a trailing newline", () => {
    const manifest = { vaults: { work: { "AI/RAG.md": ONE_ENTRY } } };

    expect(serializeManifest(manifest)).toBe(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });

  it("sorts vault and note keys regardless of insertion order", () => {
    const manifest: Manifest = {
      vaults: {
        zeta: { "b.md": ONE_ENTRY, "a.md": ONE_ENTRY },
        alpha: { "y.md": ONE_ENTRY },
      },
    };

    const lines = serializeManifest(manifest).split("\n");

    expect(lines.indexOf('    "alpha": {')).toBeLessThan(
      lines.indexOf('    "zeta": {'),
    );
    expect(lines.indexOf('      "a.md": {')).toBeLessThan(
      lines.indexOf('      "b.md": {'),
    );
  });
});

describe("writeManifest", () => {
  it("round-trips a manifest through the file system", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "manifest.json");
    const manifest = { vaults: { work: { "AI/RAG.md": ONE_ENTRY } } };

    await writeManifest(path, manifest);

    expect(parseManifest(await readFile(path, "utf8"), path)).toEqual(manifest);
  });

  it("writes text that parses back identically to the input manifest", async () => {
    const path = join(await makeTempDir(), "manifest.json");
    const manifest = { vaults: { work: { "AI/RAG.md": ONE_ENTRY } } };

    await writeManifest(path, manifest);

    expect(await readFile(path, "utf8")).toBe(serializeManifest(manifest));
  });
});

describe("writeManifest of a pre-existing file", () => {
  it("overwrites whatever was there before", async () => {
    const path = join(await makeTempDir(), "manifest.json");

    await writeFile(path, "stale bytes");
    await writeManifest(path, emptyManifest());

    expect(await readFile(path, "utf8")).toBe(
      serializeManifest(emptyManifest()),
    );
  });
});
