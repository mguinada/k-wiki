import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  isPlainObject,
  RESERVED_NAMES,
  readTextIfExists,
} from "../../src/cli/shared.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-shared-"));

  tempDirs.push(dir);

  return dir;
}

describe("isPlainObject", () => {
  it("accepts a plain object", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject("object")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("RESERVED_NAMES", () => {
  it("holds exactly the plain-object prototype hazards", () => {
    expect([...RESERVED_NAMES].sort()).toEqual([
      "__proto__",
      "constructor",
      "prototype",
    ]);
  });
});

describe("readTextIfExists", () => {
  it("returns the file's text when the file exists", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "file.txt");

    await writeFile(path, "contents", "utf8");

    expect(await readTextIfExists(path)).toBe("contents");
  });

  it("returns undefined for a missing file", async () => {
    const dir = await makeTempDir();

    expect(await readTextIfExists(join(dir, "missing.txt"))).toBeUndefined();
  });

  it("rethrows an error that is not ENOENT", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "as-directory");

    await mkdir(path);

    await expect(readTextIfExists(path)).rejects.toThrow(/EISDIR/);
  });
});
