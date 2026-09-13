import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  deriveLintWindow,
  LINT_WINDOW_FILENAME,
  type LintWindowSnapshot,
  lintWindowPath,
  readLintWindowSnapshot,
  writeLintWindowSnapshot,
} from "../../src/sync/lint-window.ts";

/**
 * The lint window (issue #359): the changed-plus-neighbors derivation
 * the cycle's lint stage audits, and the stamped snapshot it keys on —
 * first run full, failed run retried, foreign snapshot ignored.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeWiki(
  pages: Record<string, string>,
): Promise<{ dataRoot: string; wikiDir: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-lint-window-"));
  const dataRoot = join(tmp, "data");
  const wikiDir = join(dataRoot, "wiki");

  dirs.push(tmp);
  await mkdir(wikiDir, { recursive: true });

  for (const [file, body] of Object.entries(pages)) {
    await mkdir(join(wikiDir, file, ".."), { recursive: true });
    await writeFile(join(wikiDir, file), body, "utf8");
  }

  return { dataRoot, wikiDir };
}

const PAGE_A = "---\ntitle: A\ntype: concept\n---\n\nLinks to [[b]].\n";
const PAGE_B = "---\ntitle: B\ntype: concept\n---\n\nNo links.\n";
const PAGE_C = "---\ntitle: C\ntype: concept\n---\n\nLinks to [[a]].\n";

async function snapshotOf(wikiDir: string): Promise<LintWindowSnapshot> {
  const snap = await writeLintWindowSnapshotFor(wikiDir);
  const map = new Map<string, string>();
  for (const [k, v] of snap.entries()) map.set(k, v);
  return map;
}

// small helper: write to a real file and read back through the real
// reader, so the round trip is what the stage exercises.
async function writeLintWindowSnapshotFor(
  wikiDir: string,
): Promise<Map<string, string>> {
  const dataRoot = join(wikiDir, "..");
  const path = lintWindowPath(dataRoot);

  await writeLintWindowSnapshot(wikiDir, path, dataRoot);
  const read = await readLintWindowSnapshot(path, dataRoot, () => {});

  expect(read).toBeDefined();

  return read as Map<string, string>;
}

describe("readLintWindowSnapshot", () => {
  it("returns undefined for a missing snapshot (first run)", async () => {
    const read = await readLintWindowSnapshot(
      join(tmpdir(), "k-wiki-missing", LINT_WINDOW_FILENAME),
      "/data",
      () => {},
    );

    expect(read).toBeUndefined();
  });

  it("warns and returns undefined for a snapshot stamped for another root", async () => {
    const { dataRoot } = await makeWiki({ "a.md": PAGE_A });
    const path = lintWindowPath(dataRoot);

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ snapshotFor: "/other", pages: {} }),
      "utf8",
    );

    const warnings: string[] = [];
    const read = await readLintWindowSnapshot(path, dataRoot, (m) =>
      warnings.push(m),
    );

    expect(read).toBeUndefined();
    expect(warnings[0]).toContain("stamped for /other");
  });

  it("throws on invalid JSON", async () => {
    const { dataRoot } = await makeWiki({ "a.md": PAGE_A });
    const path = lintWindowPath(dataRoot);

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "not json", "utf8");

    await expect(
      readLintWindowSnapshot(path, dataRoot, () => {}),
    ).rejects.toThrow("not valid JSON");
  });
});

describe("deriveLintWindow", () => {
  it("returns the changed page plus its reverse-link neighbors", async () => {
    const { wikiDir } = await makeWiki({
      "a.md": PAGE_A,
      "b.md": PAGE_B,
      "c.md": PAGE_C,
    });
    const snapshot = await snapshotOf(wikiDir);

    await writeFile(join(wikiDir, "b.md"), `${PAGE_B}edited\n`, "utf8");

    const window = await deriveLintWindow(wikiDir, snapshot);

    // b changed; a links to b (neighbor); c links to a, not b.
    expect(window.pages).toEqual(["a.md", "b.md"]);
    expect(window.changedCount).toBe(1);
  });

  it("includes a new page and everything that links to it", async () => {
    const { wikiDir } = await makeWiki({ "a.md": PAGE_A, "c.md": PAGE_C });
    const snapshot = await snapshotOf(wikiDir);

    await writeFile(
      join(wikiDir, "b.md"),
      "---\ntitle: B\ntype: concept\n---\n\nnew\n",
      "utf8",
    );

    const window = await deriveLintWindow(wikiDir, snapshot);

    expect(window.pages).toEqual(["a.md", "b.md"]);
  });

  it("pulls in the linkers of a deleted page", async () => {
    const { wikiDir } = await makeWiki({
      "a.md": PAGE_A,
      "b.md": PAGE_B,
    });
    const snapshot = await snapshotOf(wikiDir);

    await rm(join(wikiDir, "b.md"));

    const window = await deriveLintWindow(wikiDir, snapshot);

    // b is gone (cannot be audited); a linked to it and is the audit
    // target.
    expect(window.pages).toEqual(["a.md"]);
    expect(window.changedCount).toBe(1);
  });

  it("returns an empty window when nothing changed", async () => {
    const { wikiDir } = await makeWiki({ "a.md": PAGE_A });
    const snapshot = await snapshotOf(wikiDir);

    expect(await deriveLintWindow(wikiDir, snapshot)).toEqual({
      pages: [],
      changedCount: 0,
    });
  });

  it("ignores cross-wiki targets when pulling neighbors", async () => {
    const { wikiDir } = await makeWiki({
      "a.md": "---\ntitle: A\ntype: concept\n---\n\nLinks to [[c]].\n",
      "d.md": "---\ntitle: D\n---\n\nSee [[other-wiki/b]].\n",
    });
    const snapshot = await snapshotOf(wikiDir);

    await writeFile(join(wikiDir, "b.md"), PAGE_B, "utf8");

    const window = await deriveLintWindow(wikiDir, snapshot);

    // b is new; d's link is cross-wiki (never resolves here), so d is
    // not pulled in; a links to c, not b.
    expect(window.pages).toEqual(["b.md"]);
  });
});

describe("writeLintWindowSnapshot", () => {
  it("records every page hash stamped for the data root", async () => {
    const { dataRoot, wikiDir } = await makeWiki({
      "a.md": PAGE_A,
      "b.md": PAGE_B,
    });

    await writeLintWindowSnapshot(wikiDir, lintWindowPath(dataRoot), dataRoot);

    const text = await readFile(lintWindowPath(dataRoot), "utf8");

    expect(JSON.parse(text)).toEqual({
      snapshotFor: dataRoot,
      pages: {
        "a.md": expect.any(String),
        "b.md": expect.any(String),
      },
    });
  });

  it("removes a stale temp sibling and leaves only the valid snapshot", async () => {
    // R3-F1 (gate run 01M2C6EAMYH54C4V6PFK7KFX1M): the write is atomic
    // temp-then-rename, so a crash mid-write can never leave a
    // truncated snapshot (the reader throws on invalid JSON and would
    // wedge every future lint); a leftover .tmp from an interrupted
    // write must be cleared, and the directory must hold no residue.
    const { dataRoot, wikiDir } = await makeWiki({
      "a.md": PAGE_A,
      "b.md": PAGE_B,
    });
    const snapshotPath = lintWindowPath(dataRoot);
    const tempPath = `${snapshotPath}.tmp`;

    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, "{ truncated garbage", "utf8");

    await writeLintWindowSnapshot(wikiDir, snapshotPath, dataRoot);

    const entries = (await readdir(dirname(snapshotPath))).filter((name) =>
      name.startsWith("lint-window.json"),
    );

    expect(entries).toEqual(["lint-window.json"]);

    const read = await readLintWindowSnapshot(snapshotPath, dataRoot, () => {});

    expect(read?.get("a.md")).toEqual(expect.any(String));
  });
});
