import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readTextIfExists } from "../src/shared.ts";

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
