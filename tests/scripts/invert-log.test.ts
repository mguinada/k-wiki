import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  invertLog,
  logDirection,
  parseWikiLog,
} from "../../scripts/invert-log.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temp wiki dir; `log` is written to wiki/log.md when given. */
async function makeWiki(log?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-invert-log-"));

  tempDirs.push(dir);

  const wikiDir = join(dir, "wiki");

  await mkdir(wikiDir, { recursive: true });

  if (log !== undefined) {
    await writeFile(join(wikiDir, "log.md"), log, "utf8");
  }

  return wikiDir;
}

/** A temp git repo whose wiki/ holds `log`, committed clean. */
async function makeRepo(log: string): Promise<string> {
  const wikiDir = await makeWiki(log);
  const dataRoot = join(wikiDir, "..");

  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "--quiet", "-m", "init"],
  ]) {
    await run("git", args, { cwd: dataRoot });
  }

  return wikiDir;
}

async function readLog(wikiDir: string): Promise<string> {
  return readFile(join(wikiDir, "log.md"), "utf8");
}

const OLDEST_FIRST = [
  "# Wiki Log",
  "",
  "## [2026-07-01] ingest | Old",
  "",
  "Old body.",
  "",
  "## [2026-08-01] ingest | New",
  "",
  "New body.",
  "",
].join("\n");

describe("parseWikiLog", () => {
  it("splits the log into the header, byte-exact entries, separators, and tail", () => {
    expect(parseWikiLog(OLDEST_FIRST)).toEqual({
      header: "# Wiki Log\n\n",
      entries: [
        "## [2026-07-01] ingest | Old\n\nOld body.",
        "## [2026-08-01] ingest | New\n\nNew body.",
      ],
      separators: ["\n\n"],
      tail: "\n",
    });
  });

  it("round-trips losslessly: the parsed parts reassemble into the original text", () => {
    const { header, entries, separators, tail } = parseWikiLog(OLDEST_FIRST);

    expect(`${header}${entries.join(separators[0])}${tail}`).toBe(OLDEST_FIRST);
  });

  it("keeps uneven separators and a multi-newline tail byte-exact", () => {
    const text =
      "# Wiki Log\n\n## [2026-07-01] a | x\n\nB.\n## [2026-08-01] b | y\n\nC.\n\n";

    expect(parseWikiLog(text)).toEqual({
      header: "# Wiki Log\n\n",
      entries: ["## [2026-07-01] a | x\n\nB.", "## [2026-08-01] b | y\n\nC."],
      separators: ["\n"],
      tail: "\n\n",
    });
  });

  it("returns the whole text as header for a log without entries", () => {
    expect(parseWikiLog("# Wiki Log\n")).toEqual({
      header: "# Wiki Log\n",
      entries: [],
      separators: [],
      tail: "",
    });
  });
});

describe("logDirection", () => {
  it("classifies non-increasing dates as newest-first", () => {
    expect(
      logDirection(["## [2026-08-01] a | x\n", "## [2026-07-01] b | y\n"]),
    ).toBe("newest-first");
  });

  it("classifies non-decreasing dates as oldest-first", () => {
    expect(
      logDirection(["## [2026-07-01] a | x\n", "## [2026-08-01] b | y\n"]),
    ).toBe("oldest-first");
  });

  it("classifies dates out of order in both directions as ambiguous", () => {
    expect(
      logDirection([
        "## [2026-07-01] a | x\n",
        "## [2026-08-01] b | y\n",
        "## [2026-07-15] c | z\n",
      ]),
    ).toBe("ambiguous");
  });

  it("classifies flat dates as newest-first (their reverse is themselves)", () => {
    expect(
      logDirection(["## [2026-08-01] a | x\n", "## [2026-08-01] b | y\n"]),
    ).toBe("newest-first");
  });
});

describe("invertLog", () => {
  it("refuses an ambiguous log without writing", async () => {
    const wikiDir = await makeWiki(
      [
        "# Wiki Log",
        "",
        "## [2026-07-01] a | x",
        "",
        "## [2026-08-01] b | y",
        "",
        "## [2026-07-15] c | z",
        "",
      ].join("\n"),
    );

    await expect(
      invertLog(wikiDir, { date: "2026-09-01", write: true }),
    ).rejects.toThrow(/ambiguous/);

    expect(await readLog(wikiDir)).toContain("## [2026-07-15] c | z");
  });

  it("reports a missing log.md as a clean no-op", async () => {
    const wikiDir = await makeWiki();

    await expect(
      invertLog(wikiDir, { date: "2026-09-01", write: true }),
    ).resolves.toEqual({
      outcome: "no-op",
      entries: 0,
      reason: "log absent",
    });
  });

  it("exits as a no-op when a prior log-inversion entry proves migration", async () => {
    const wikiDir = await makeWiki(
      [
        "# Wiki Log",
        "",
        "## [2026-09-01] log-inversion | 2 entries",
        "",
        "## [2026-08-01] ingest | New",
        "",
        "## [2026-07-01] ingest | Old",
        "",
      ].join("\n"),
    );

    await expect(
      invertLog(wikiDir, { date: "2026-09-02", write: true }),
    ).resolves.toMatchObject({ outcome: "no-op", reason: "log-inversion" });
  });

  it("exits as a no-op when the dates already run newest-first", async () => {
    const log = [
      "# Wiki Log",
      "",
      "## [2026-08-01] ingest | New",
      "",
      "## [2026-07-01] ingest | Old",
      "",
    ].join("\n");
    const wikiDir = await makeWiki(log);

    await expect(
      invertLog(wikiDir, { date: "2026-09-01", write: true }),
    ).resolves.toMatchObject({ outcome: "no-op", reason: "newest-first" });

    expect(await readLog(wikiDir)).toBe(log);
  });

  it("writes nothing on the dry-run default", async () => {
    const wikiDir = await makeWiki(OLDEST_FIRST);

    const report = await invertLog(wikiDir, { date: "2026-09-01" });

    expect(report).toEqual({
      outcome: "inverted",
      entries: 2,
      written: false,
    });

    expect(await readLog(wikiDir)).toBe(OLDEST_FIRST);
  });

  it("inverts the entries losslessly with the audit entry on top", async () => {
    const wikiDir = await makeRepo(OLDEST_FIRST);

    const report = await invertLog(wikiDir, {
      date: "2026-09-01",
      write: true,
    });

    expect(report).toEqual({
      outcome: "inverted",
      entries: 2,
      written: true,
    });

    expect(await readLog(wikiDir)).toBe(
      [
        "# Wiki Log",
        "",
        "## [2026-09-01] log-inversion | 2 entries",
        "",
        "## [2026-08-01] ingest | New",
        "",
        "New body.",
        "",
        "## [2026-07-01] ingest | Old",
        "",
        "Old body.",
        "",
      ].join("\n"),
    );
  });

  it("is idempotent: a re-run is a no-op", async () => {
    const wikiDir = await makeRepo(OLDEST_FIRST);

    await invertLog(wikiDir, { date: "2026-09-01", write: true });

    const before = await readLog(wikiDir);

    await expect(
      invertLog(wikiDir, { date: "2026-09-02", write: true }),
    ).resolves.toMatchObject({ outcome: "no-op" });

    expect(await readLog(wikiDir)).toBe(before);
  });

  it("inverts a headerless legacy log and creates the header", async () => {
    const wikiDir = await makeRepo(
      "## [2026-07-01] sandbox | old\n\nPages; expires X.\n## [2026-08-01] sandbox | new\n\nPages; expires Y.\n",
    );

    const report = await invertLog(wikiDir, {
      date: "2026-09-01",
      write: true,
    });

    expect(report).toEqual({
      outcome: "inverted",
      entries: 2,
      written: true,
    });

    expect(await readLog(wikiDir)).toBe(
      [
        "# Wiki Log",
        "",
        "## [2026-09-01] log-inversion | 2 entries",
        "",
        "## [2026-08-01] sandbox | new",
        "",
        "Pages; expires Y.",
        "## [2026-07-01] sandbox | old",
        "",
        "Pages; expires X.",
        "",
      ].join("\n"),
    );
  });

  it("preserves uneven separators byte-exactly through a write", async () => {
    const uneven =
      "# Wiki Log\n\n## [2026-07-01] a | x\n\nB.\n## [2026-08-01] b | y\n\nC.\n\n";
    const wikiDir = await makeRepo(uneven);

    await invertLog(wikiDir, { date: "2026-09-01", write: true });

    expect(await readLog(wikiDir)).toBe(
      "# Wiki Log\n\n## [2026-09-01] log-inversion | 2 entries\n\n## [2026-08-01] b | y\n\nC.\n## [2026-07-01] a | x\n\nB.\n\n",
    );
  });

  it("inverts a header missing its blank line without tripping the post-write gate", async () => {
    const wikiDir = await makeRepo(
      "# Wiki Log\n## [2026-07-01] a | x\n\nOld.\n## [2026-08-01] b | y\n\nNew.\n",
    );

    await expect(
      invertLog(wikiDir, { date: "2026-09-01", write: true }),
    ).resolves.toEqual({
      outcome: "inverted",
      entries: 2,
      written: true,
    });

    expect(await readLog(wikiDir)).toBe(
      "# Wiki Log\n\n## [2026-09-01] log-inversion | 2 entries\n## [2026-08-01] b | y\n\nNew.\n## [2026-07-01] a | x\n\nOld.\n",
    );
  });

  it("inverts a log missing its trailing newline without tripping the post-write gate", async () => {
    const wikiDir = await makeRepo(
      "# Wiki Log\n\n## [2026-07-01] a | x\n\nOld.\n\n## [2026-08-01] b | y\n\nNew.",
    );

    await expect(
      invertLog(wikiDir, { date: "2026-09-01", write: true }),
    ).resolves.toEqual({
      outcome: "inverted",
      entries: 2,
      written: true,
    });

    expect(await readLog(wikiDir)).toBe(
      "# Wiki Log\n\n## [2026-09-01] log-inversion | 2 entries\n\n## [2026-08-01] b | y\n\nNew.\n\n## [2026-07-01] a | x\n\nOld.\n",
    );
  });

  it("refuses --write on a dirty tree", async () => {
    const wikiDir = await makeRepo(OLDEST_FIRST);

    await writeFile(join(wikiDir, "index.md"), "dirty\n", "utf8");

    await expect(
      invertLog(wikiDir, { date: "2026-09-01", write: true }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it("refuses a wiki dir that does not exist", async () => {
    await expect(
      invertLog("/nonexistent-wiki", { date: "2026-09-01", write: true }),
    ).rejects.toThrow(/does not exist/);
  });
});
