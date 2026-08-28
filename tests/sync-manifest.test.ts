import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects a manifest whose root is null", () => {
    expect(() => parseManifest("null", "manifest.json")).toThrow(
      /expected an object with a "vaults" object/,
    );
  });

  it("rejects a vaults value that is an array", () => {
    expect(() => parseManifest('{"vaults":[]}', "manifest.json")).toThrow(
      /expected an object with a "vaults" object/,
    );
  });

  it("rejects a __proto__ note path", () => {
    const text = `{"vaults":{"work":{"__proto__":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /invalid manifest at manifest\.json: vault "work" has reserved note path "__proto__"/,
    );
  });

  it("rejects a constructor note path", () => {
    const text = `{"vaults":{"work":{"constructor":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /reserved note path "constructor"/,
    );
  });

  it("rejects a prototype note path", () => {
    const text = `{"vaults":{"work":{"prototype":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /reserved note path "prototype"/,
    );
  });

  it("accepts a note path that contains a reserved name as a substring", () => {
    const text = `{"vaults":{"work":{"__proto__.md":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(parseManifest(text, "manifest.json").vaults.work).toHaveProperty(
      "__proto__.md",
      ONE_ENTRY,
    );
  });

  it("rejects a __proto__ vault name", () => {
    const text = `{"vaults":{"__proto__":{"AI/RAG.md":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /invalid manifest at manifest\.json: reserved vault name "__proto__"/,
    );
  });

  it("rejects a constructor vault name", () => {
    const text = `{"vaults":{"constructor":{"AI/RAG.md":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /reserved vault name "constructor"/,
    );
  });

  it("rejects a prototype vault name", () => {
    const text = `{"vaults":{"prototype":{"AI/RAG.md":${JSON.stringify(ONE_ENTRY)}}}}`;

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /reserved vault name "prototype"/,
    );
  });

  it("keeps the JSON parse error as the cause when text is not valid JSON", () => {
    let thrown: unknown = "not thrown";

    try {
      parseManifest("{ nope", "manifest.json");
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it("rejects a note entry whose hash is not a string", () => {
    const text = JSON.stringify({
      vaults: { work: { "AI/RAG.md": { hash: 1, last_synced: "t" } } },
    });

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /entry "AI\/RAG\.md" needs string/,
    );
  });

  it("rejects a note entry whose last_synced is not a string", () => {
    const text = JSON.stringify({
      vaults: { work: { "AI/RAG.md": { hash: "x", last_synced: 1 } } },
    });

    expect(() => parseManifest(text, "manifest.json")).toThrow(
      /entry "AI\/RAG\.md" needs string/,
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
  });

  it("sorts note keys within a vault", () => {
    const manifest: Manifest = {
      vaults: {
        zeta: { "b.md": ONE_ENTRY, "a.md": ONE_ENTRY },
        alpha: { "y.md": ONE_ENTRY },
      },
    };

    const lines = serializeManifest(manifest).split("\n");

    expect(lines.indexOf('      "a.md": {')).toBeLessThan(
      lines.indexOf('      "b.md": {'),
    );
  });

  it("serializes three or more keys of every kind in default string order", () => {
    const manifest: Manifest = {
      vaults: {
        alpha: { "a.md": ONE_ENTRY, "m.md": ONE_ENTRY, "z.md": ONE_ENTRY },
        mike: {},
        zeta: {},
      },
    };
    const expected = {
      vaults: {
        alpha: { "a.md": ONE_ENTRY, "m.md": ONE_ENTRY, "z.md": ONE_ENTRY },
        mike: {},
        zeta: {},
      },
    };

    expect(serializeManifest(manifest)).toBe(
      `${JSON.stringify(expected, null, 2)}\n`,
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

  it("leaves no temporary file behind", async () => {
    const dir = await makeTempDir();

    await writeManifest(join(dir, "manifest.json"), emptyManifest());

    expect(await readdir(dir)).toEqual(["manifest.json"]);
  });

  it("replaces a stale temporary file left by an interrupted write", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "manifest.json");

    await writeFile(`${path}.tmp`, "{ truncated");
    await writeManifest(path, emptyManifest());

    expect(await readdir(dir)).toEqual(["manifest.json"]);
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
