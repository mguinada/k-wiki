import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDirectory,
  isPlainObject,
  listFiles,
  pathExists,
  pluralized,
  RESERVED_NAMES,
  readTextIfExists,
  repoRoot,
  sha256,
  statIfExists,
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

  it("rejects null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isPlainObject([1, 2])).toBe(false);
  });

  it("rejects a string", () => {
    expect(isPlainObject("object")).toBe(false);
  });

  it("rejects a number", () => {
    expect(isPlainObject(42)).toBe(false);
  });

  it("rejects undefined", () => {
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

describe("listFiles", () => {
  it("lists every file recursively as dir-relative paths", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "a.md"), "");
    await writeFile(join(dir, "sub", "b.md"), "");
    expect(await listFiles(dir)).toEqual(["a.md", "sub/b.md"]);
  });

  it("skips the skipDirs directories at every depth", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".obsidian", "deep"), { recursive: true });
    await mkdir(join(dir, "keep"));
    await writeFile(join(dir, ".obsidian", "x.md"), "");
    await writeFile(join(dir, ".obsidian", "deep", "x.md"), "");
    await writeFile(join(dir, "keep", ".obsidian"), "");
    expect(
      await listFiles(dir, "", { skipDirs: new Set([".obsidian"]) }),
    ).toEqual(["keep/.obsidian"]);
  });

  it("skips the skipRootDirs directories only at the walk root", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".git", "objects"), { recursive: true });
    await mkdir(join(dir, "src", ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "");
    await writeFile(join(dir, "src", ".git", "config"), "");
    await writeFile(join(dir, "src", "a.ts"), "");
    expect(
      await listFiles(dir, "", { skipRootDirs: new Set([".git"]) }),
    ).toEqual(["src/.git/config", "src/a.ts"]);
  });

  it("skips the skipFiles file names", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".DS_Store"), "");
    await writeFile(join(dir, "a.md"), "");
    expect(
      await listFiles(dir, "", { skipFiles: new Set([".DS_Store"]) }),
    ).toEqual(["a.md"]);
  });

  it("collects only files ending in the extension when set", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "a.md"), "");
    await writeFile(join(dir, "a.txt"), "");
    await writeFile(join(dir, "sub", "b.md"), "");
    expect(await listFiles(dir, "", { extension: ".md" })).toEqual([
      "a.md",
      "sub/b.md",
    ]);
  });

  it("reports the running count of directories read to onDir", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub", "deeper"), { recursive: true });
    await writeFile(join(dir, "sub", "deeper", "b.md"), "");
    const visited: number[] = [];
    expect(await listFiles(dir, "", { onDir: (n) => visited.push(n) })).toEqual(
      ["sub/deeper/b.md"],
    );
    expect(visited).toEqual([1, 2, 3]);
  });

  it("collects a non-directory entry by default so health can flag it", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "real.md"), "");
    await symlink("real.md", join(dir, "link.md"));

    expect(await listFiles(dir)).toEqual(["link.md", "real.md"]);
  });

  it("skips non-directory entries when regularFilesOnly is set", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "real.md"), "");
    await symlink("real.md", join(dir, "link.md"));

    expect(await listFiles(dir, "", { regularFilesOnly: true })).toEqual([
      "real.md",
    ]);
  });

  it("walks below a non-empty prefix, reporting paths under it", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "src", "sync"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "");
    await writeFile(join(dir, "src", "sync", "b.ts"), "");
    expect(await listFiles(join(dir, "src"), "src")).toEqual([
      "src/a.ts",
      "src/sync/b.ts",
    ]);
  });
});

describe("sha256", () => {
  const encoder = new TextEncoder();

  it("returns the lowercase hex digest of the given bytes", () => {
    expect(sha256(encoder.encode("karpathy"))).toBe(
      "b618269306c82a1526022ad1e60392d23d2775ecb480f06b0da81b6654790778",
    );
  });
});

describe("statIfExists", () => {
  it("returns the stats of an existing path", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "file.txt");
    await writeFile(path, "contents");

    expect((await statIfExists(path))?.isFile()).toBe(true);
  });

  it("returns undefined for a missing path", async () => {
    const dir = await makeTempDir();

    expect(await statIfExists(join(dir, "missing.txt"))).toBeUndefined();
  });
});

describe("pathExists", () => {
  it("is true for an existing path of any kind", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"));

    expect(await pathExists(join(dir, "sub"))).toBe(true);
  });

  it("is false for a missing path", async () => {
    expect(await pathExists(join(tmpdir(), "k-wiki-absent-path"))).toBe(false);
  });
});

describe("assertDirectory", () => {
  it("passes when the path is a directory", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"));

    await assertDirectory("wiki directory", join(dir, "sub"));
  });

  it("names the noun and display path when it does not exist", async () => {
    const dir = await makeTempDir();

    await expect(
      assertDirectory("wiki directory", join(dir, "absent"), "input/path"),
    ).rejects.toThrow("wiki directory does not exist: input/path");
  });

  it("names the noun and display path when it is not a directory", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "plain.txt");
    await writeFile(file, "");

    await expect(
      assertDirectory("raw directory", file, "input/path"),
    ).rejects.toThrow("raw directory is not a directory: input/path");
  });
});

describe("pluralized", () => {
  it("keeps the noun singular for one", () => {
    expect(pluralized(1, "move")).toBe("1 move");
  });

  it("appends s for zero and many", () => {
    expect(pluralized(0, "namespace")).toBe("0 namespaces");
    expect(pluralized(3, "source")).toBe("3 sources");
  });
});

describe("repoRoot", () => {
  it("points at the repository root holding package.json and src/", () => {
    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "src", "cli", "shared.ts"))).toBe(true);
  });
});
