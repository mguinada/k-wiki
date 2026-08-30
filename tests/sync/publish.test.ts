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
import { afterAll, describe, expect, it } from "vitest";
import { runPublishStage } from "../../src/sync/publish.ts";

/**
 * The publish stage (guide §26, issue #15): copy the data repo's
 * include-matched files into the mirror vault — verbatim, or
 * re-based to vault root when `root` is configured (issue #203) —
 * deletions included, the mirror's `.obsidian` device state preserved, idempotent
 * (identical bytes are never rewritten).
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Tree {
  readonly dataRoot: string;
  readonly mirror: string;
}

/** A data repo with a small wiki/ tree; the mirror does not exist yet. */
async function makeTree(): Promise<Tree> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-publish-"));

  tempDirs.push(root);

  const dataRoot = join(root, "data");
  const mirror = join(root, "KWiki");

  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "concepts", "stub.md"), "stub\n");
  await writeFile(join(dataRoot, "README.md"), "not published\n");

  return { dataRoot, mirror };
}

function optionsFor(tree: Tree) {
  return {
    dataRoot: tree.dataRoot,
    mirror: tree.mirror,
    include: ["wiki/**"],
  };
}

describe("runPublishStage", () => {
  it("copies the matched wiki tree into the mirror preserving paths", async () => {
    const tree = await makeTree();
    const result = await runPublishStage(optionsFor(tree));

    await expect(
      readFile(join(tree.mirror, "wiki", "index.md"), "utf8"),
    ).resolves.toBe("# Index\n");
    await expect(
      readFile(join(tree.mirror, "wiki", "concepts", "stub.md"), "utf8"),
    ).resolves.toBe("stub\n");
    expect(result.copied).toBe(2);
  });

  it("publishes nothing outside the include patterns", async () => {
    const tree = await makeTree();

    await runPublishStage(optionsFor(tree));

    await expect(
      readFile(join(tree.mirror, "README.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the mirror when it does not exist", async () => {
    const tree = await makeTree();

    await runPublishStage(optionsFor(tree));

    await expect(stat(tree.mirror)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("removes a mirror file the wiki no longer has", async () => {
    const tree = await makeTree();
    const stray = join(tree.mirror, "wiki", "gone.md");

    await mkdir(join(tree.mirror, "wiki"), { recursive: true });
    await writeFile(stray, "stale\n");

    const result = await runPublishStage(optionsFor(tree));

    await expect(readFile(stray, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.removed).toBe(1);
  });

  it("keeps the mirror's .obsidian device state", async () => {
    const tree = await makeTree();
    const state = join(tree.mirror, ".obsidian", "workspace.json");

    await mkdir(join(tree.mirror, ".obsidian"), { recursive: true });
    await writeFile(state, "{}");

    const result = await runPublishStage(optionsFor(tree));

    await expect(readFile(state, "utf8")).resolves.toBe("{}");
    expect(result.removed).toBe(0);
  });

  it("rewrites a mirror file whose bytes drifted", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.mirror, "wiki"), { recursive: true });
    await writeFile(join(tree.mirror, "wiki", "index.md"), "mangled\n");

    const result = await runPublishStage(optionsFor(tree));

    await expect(
      readFile(join(tree.mirror, "wiki", "index.md"), "utf8"),
    ).resolves.toBe("# Index\n");
    expect(result.copied).toBe(2);
  });

  it("writes nothing on a second run over an intact mirror", async () => {
    const tree = await makeTree();

    await runPublishStage(optionsFor(tree));

    const index = join(tree.mirror, "wiki", "index.md");
    const before = await stat(index);
    const result = await runPublishStage(optionsFor(tree));
    const after = await stat(index);

    expect(result).toEqual({ copied: 0, removed: 0 });
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("prunes the directory a removed page left empty", async () => {
    const tree = await makeTree();
    const emptyDir = join(tree.mirror, "wiki", "old");

    await mkdir(join(emptyDir), { recursive: true });
    await writeFile(join(emptyDir, "gone.md"), "stale\n");

    await runPublishStage(optionsFor(tree));

    await expect(stat(emptyDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the mirror root when pruning with a trailing-slash mirror path", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.mirror, "wiki"), { recursive: true });
    await writeFile(join(tree.mirror, "wiki", "gone.md"), "stale\n");

    await runPublishStage({
      dataRoot: tree.dataRoot,
      mirror: `${tree.mirror}/`,
      include: ["absent/**"],
    });

    await expect(stat(tree.mirror)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("skips .obsidian and .DS_Store on the wiki side", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.dataRoot, "wiki", ".obsidian"), { recursive: true });
    await writeFile(join(tree.dataRoot, "wiki", ".obsidian", "app.json"), "{}");
    await writeFile(join(tree.dataRoot, "wiki", ".DS_Store"), "junk");

    const result = await runPublishStage(optionsFor(tree));

    await expect(
      readFile(join(tree.mirror, "wiki", ".obsidian", "app.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(tree.mirror, "wiki", ".DS_Store"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.copied).toBe(2);
  });

  it("publishes only the configured include subset", async () => {
    const tree = await makeTree();

    await runPublishStage({
      dataRoot: tree.dataRoot,
      mirror: tree.mirror,
      include: ["wiki/index.md"],
    });

    await expect(
      readFile(join(tree.mirror, "wiki", "index.md"), "utf8"),
    ).resolves.toBe("# Index\n");
    await expect(
      readFile(join(tree.mirror, "wiki", "concepts", "stub.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the union of multiple include patterns", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.dataRoot, "raw"), { recursive: true });
    await writeFile(join(tree.dataRoot, "raw", "manifest.json"), "{}\n");

    const result = await runPublishStage({
      dataRoot: tree.dataRoot,
      mirror: tree.mirror,
      include: ["wiki/index.md", "raw/**"],
    });

    expect(result.copied).toBe(2);
  });

  it("announces the selected file count and mirror on the progress line", async () => {
    const tree = await makeTree();
    const progress: string[] = [];

    await runPublishStage({
      ...optionsFor(tree),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual(
      expect.stringContaining(`2 files selected for ${tree.mirror}`),
    );
  });

  it("announces the copy and removal counts on the progress line", async () => {
    const tree = await makeTree();
    const progress: string[] = [];

    await runPublishStage({
      ...optionsFor(tree),
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContainEqual(
      expect.stringContaining("2 copied, 0 removed"),
    );
  });

  it("re-bases target paths by stripping the configured root", async () => {
    const tree = await makeTree();

    const result = await runPublishStage({ ...optionsFor(tree), root: "wiki" });

    await expect(readFile(join(tree.mirror, "index.md"), "utf8")).resolves.toBe(
      "# Index\n",
    );
    await expect(
      readFile(join(tree.mirror, "concepts", "stub.md"), "utf8"),
    ).resolves.toBe("stub\n");
    await expect(stat(join(tree.mirror, "wiki"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.copied).toBe(2);
  });

  it("prunes the old verbatim tree when switching to a re-rooted mirror", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.mirror, "wiki", "concepts"), { recursive: true });
    await writeFile(join(tree.mirror, "wiki", "index.md"), "old\n");
    await writeFile(join(tree.mirror, "wiki", "concepts", "stub.md"), "old\n");
    await mkdir(join(tree.mirror, ".obsidian"), { recursive: true });
    await writeFile(join(tree.mirror, ".obsidian", "state.json"), "{}");

    const result = await runPublishStage({ ...optionsFor(tree), root: "wiki" });

    await expect(stat(join(tree.mirror, "wiki"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(tree.mirror, "index.md"), "utf8")).resolves.toBe(
      "# Index\n",
    );
    await expect(
      readFile(join(tree.mirror, ".obsidian", "state.json"), "utf8"),
    ).resolves.toBe("{}");
    expect(result).toEqual({ copied: 2, removed: 2 });
  });

  it("writes nothing on a second re-rooted run over an intact mirror", async () => {
    const tree = await makeTree();

    await runPublishStage({ ...optionsFor(tree), root: "wiki" });

    const index = join(tree.mirror, "index.md");
    const before = await stat(index);
    const result = await runPublishStage({ ...optionsFor(tree), root: "wiki" });
    const after = await stat(index);

    expect(result).toEqual({ copied: 0, removed: 0 });
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("passes files outside the root through unchanged", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.dataRoot, "notes"), { recursive: true });
    await writeFile(join(tree.dataRoot, "notes", "foo.md"), "note\n");

    await runPublishStage({
      ...optionsFor(tree),
      include: ["**/*.md"],
      root: "wiki",
    });

    await expect(
      readFile(join(tree.mirror, "notes", "foo.md"), "utf8"),
    ).resolves.toBe("note\n");
    await expect(readFile(join(tree.mirror, "index.md"), "utf8")).resolves.toBe(
      "# Index\n",
    );
  });

  it("publishes a root-named path verbatim when no root is configured", async () => {
    const tree = await makeTree();

    await mkdir(join(tree.dataRoot, "undefined"), { recursive: true });
    await writeFile(join(tree.dataRoot, "undefined", "x.md"), "edge\n");

    const result = await runPublishStage({
      ...optionsFor(tree),
      include: ["wiki/**", "undefined/**"],
    });

    await expect(
      readFile(join(tree.mirror, "undefined", "x.md"), "utf8"),
    ).resolves.toBe("edge\n");
    expect(result.copied).toBe(3);
  });

  it("runs without a progress sink", async () => {
    const tree = await makeTree();

    await expect(runPublishStage(optionsFor(tree))).resolves.toEqual({
      copied: 2,
      removed: 0,
    });
  });
});
