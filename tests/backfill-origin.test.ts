import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { backfillOrigins } from "../scripts/backfill-origin.ts";
import { parsePageFields } from "../src/wiki/pages.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../bin/backfill-origin.ts",
);

const run = promisify(execFile);
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly wikiDir: string;
  readonly rawDir: string;
}

/** A wiki tree at `<root>/wiki` and a raw projection at `<root>/raw`. */
async function makeFixture(
  wikiFiles: Record<string, string>,
  rawFiles: Record<string, string> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-backfill-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(wikiFiles)) {
    await mkdir(join(root, "wiki", dirname(file)), { recursive: true });
    await writeFile(join(root, "wiki", file), content);
  }

  await mkdir(join(root, "raw"), { recursive: true });

  for (const [file, content] of Object.entries(rawFiles)) {
    await mkdir(join(root, "raw", dirname(file)), { recursive: true });
    await writeFile(join(root, "raw", file), content);
  }

  return { wikiDir: join(root, "wiki"), rawDir: join(root, "raw") };
}

/** A type: source page citing raw paths in `sources`. */
function sourcePage(
  entries: readonly string[],
  options: { extra?: string; title?: string } = {},
): string {
  return [
    "---",
    `title: "${options.title ?? "Gpu memory math"}"`,
    "type: source",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    ...entries.map((entry) => `  - "${entry}"`),
    options.extra ?? "",
    "---",
    "",
    "body",
    "",
  ].join("\n");
}

const NOTE = "notes/V/gpu-memory-math.md";

describe("backfillOrigins", () => {
  it("writes the single verifiable raw path as origin and bumps updated", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.backfilled).toEqual([
      {
        page: "sources/gpu-memory-math.md",
        origin: `raw/${NOTE}`,
      },
    ]);
    expect(
      await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
    ).toContain(`origin: raw/${NOTE}`);
  });

  it("backfills a page whose origin line carries an empty value", async () => {
    const f = await makeFixture(
      {
        "sources/gpu-memory-math.md": sourcePage([NOTE], { extra: "origin:" }),
      },
      { [NOTE]: "note body" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(`${report.backfilled.length}: ${report.untouched}`).toBe("1: 0");
  });

  it("replaces the empty origin line instead of stacking a second one", async () => {
    const f = await makeFixture(
      {
        "sources/gpu-memory-math.md": sourcePage([NOTE], { extra: "origin:" }),
      },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    const page = await readFile(
      join(f.wikiDir, "sources/gpu-memory-math.md"),
      "utf8",
    );

    expect(page.match(/^origin:.*$/gm)).toEqual([`origin: raw/${NOTE}`]);
  });

  it("stays idempotent on a re-run over an empty-origin page just backfilled", async () => {
    const f = await makeFixture(
      {
        "sources/gpu-memory-math.md": sourcePage([NOTE], { extra: "origin:" }),
      },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });
    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(`${report.backfilled.length}: ${report.untouched}`).toBe("0: 1");
  });

  it("backfills a page whose closing fence is indented", async () => {
    const page = [
      "---",
      'title: "Gpu memory math"',
      "type: source",
      "updated: 2026-08-20",
      "sources:",
      `  - "${NOTE}"`,
      "  ---",
      "",
      "body",
    ].join("\n");
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": page },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    expect(
      parsePageFields(
        await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
      ).origin,
    ).toBe(`raw/${NOTE}`);
  });

  it("ignores a page with no opening fence even when the body mimics frontmatter", async () => {
    const page = ["# Gpu memory math", "type: source", "---", "body"].join(
      "\n",
    );
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": page },
      { [NOTE]: "note body" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(
      `${report.backfilled.length}/${report.needsJudgment.length}/${report.untouched}`,
    ).toBe("0/0/0");
  });

  it("bumps updated only inside the frontmatter, never a body line", async () => {
    const page = sourcePage([NOTE]).replace(
      "body",
      "updated: 2020-01-01 (a body line that must survive)",
    );
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": page },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    const text = await readFile(
      join(f.wikiDir, "sources/gpu-memory-math.md"),
      "utf8",
    );

    expect(text).toContain(
      "updated: 2020-01-01 (a body line that must survive)",
    );
  });

  it("accepts a raw/ prefix on the sources entry", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([`raw/${NOTE}`]) },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    expect(
      await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
    ).toContain(`origin: raw/${NOTE}`);
  });

  it("skips and reports a page with two verifiable raw paths", async () => {
    const f = await makeFixture(
      { "sources/multi.md": sourcePage([NOTE, "notes/V/b.md"]) },
      { [NOTE]: "a", "notes/V/b.md": "b" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.needsJudgment[0]?.reason).toContain("2 verifiable");
    expect(
      await readFile(join(f.wikiDir, "sources/multi.md"), "utf8"),
    ).not.toContain("origin:");
  });

  it("skips and reports a page whose only sources entry is a wikilink", async () => {
    const f = await makeFixture({
      "sources/wikilink.md": sourcePage(["[[Some other page]]"]),
    });

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.needsJudgment[0]).toMatchObject({
      page: "sources/wikilink.md",
    });
  });

  it("skips and reports a page whose raw path does not exist", async () => {
    const f = await makeFixture({
      "sources/dead.md": sourcePage(["notes/V/gone.md"]),
    });

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.needsJudgment[0]?.reason).toContain("0 verifiable");
  });

  it("skips and reports a page whose title shares no tokens with the note name", async () => {
    const f = await makeFixture(
      {
        "sources/mismatch.md": sourcePage(["notes/V/unrelated-thing.md"], {
          title: "Gpu memory math",
        }),
      },
      { "notes/V/unrelated-thing.md": "different note" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.needsJudgment[0]?.reason).toContain("does not corroborate");
    expect(
      await readFile(join(f.wikiDir, "sources/mismatch.md"), "utf8"),
    ).not.toContain("origin:");
  });

  it("backfills a page whose title corroborates the note name on one long token", async () => {
    const f = await makeFixture(
      {
        "sources/paperclip.md": sourcePage(["notes/V/paperclip-anything.md"], {
          title: "Paperclip",
        }),
      },
      { "notes/V/paperclip-anything.md": "note" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.backfilled).toHaveLength(1);
  });

  it("leaves a page that already has an origin byte-identical", async () => {
    const f = await makeFixture(
      {
        "sources/done.md": sourcePage([NOTE], { extra: `origin: raw/${NOTE}` }),
      },
      { [NOTE]: "note body" },
    );

    const before = await readFile(join(f.wikiDir, "sources/done.md"), "utf8");
    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.untouched).toBe(1);
    expect(await readFile(join(f.wikiDir, "sources/done.md"), "utf8")).toBe(
      before,
    );
  });

  it("ignores pages that are not type source", async () => {
    const f = await makeFixture(
      {
        "concepts/x.md": [
          "---",
          'title: "Gpu memory math"',
          "type: concept",
          "sources:",
          `  - "${NOTE}"`,
          "---",
          "body",
        ].join("\n"),
      },
      { [NOTE]: "note body" },
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
    });

    expect(report.backfilled).toEqual([]);
    expect(
      await readFile(join(f.wikiDir, "concepts/x.md"), "utf8"),
    ).not.toContain("origin:");
  });

  it("writes nothing on a second run over the same tree", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });
    const after = await readFile(
      join(f.wikiDir, "sources/gpu-memory-math.md"),
      "utf8",
    );
    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-24",
    });

    expect(report.backfilled).toEqual([]);
    expect(
      await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
    ).toBe(after);
  });

  it("keeps the page body byte-identical apart from the frontmatter edit", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    expect(
      (
        await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8")
      ).endsWith("body\n"),
    ).toBe(true);
  });

  it("writes no file and no log entry on a dry run", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );
    const before = await readFile(
      join(f.wikiDir, "sources/gpu-memory-math.md"),
      "utf8",
    );

    const report = await backfillOrigins(f.wikiDir, f.rawDir, {
      date: "2026-08-23",
      dryRun: true,
    });

    expect(report.backfilled).toHaveLength(1);
    expect(
      await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
    ).toBe(before);
    await expect(
      readFile(join(f.wikiDir, "log.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends the origin-backfill entry to log.md naming each pair", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    expect(await readFile(join(f.wikiDir, "log.md"), "utf8")).toContain(
      [
        "## [2026-08-23] origin-backfill | 1 page",
        "",
        `- wiki/sources/gpu-memory-math.md -> raw/${NOTE}`,
      ].join("\n"),
    );
  });

  it("creates log.md with the standard header when absent", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    expect(await readFile(join(f.wikiDir, "log.md"), "utf8")).toContain(
      "# Wiki Log",
    );
  });

  it("appends nothing to log.md when no page was backfilled", async () => {
    const f = await makeFixture(
      { "sources/multi.md": sourcePage([NOTE, "notes/V/b.md"]) },
      { [NOTE]: "a", "notes/V/b.md": "b" },
    );

    await backfillOrigins(f.wikiDir, f.rawDir, { date: "2026-08-23" });

    await expect(
      readFile(join(f.wikiDir, "log.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** Run the CLI as a child process against a real-path script. */
function runCli(args: readonly string[]): Promise<RunResult> {
  const env = { ...process.env };

  delete env.NO_COLOR;

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [realpathSync(script), ...args],
      { env },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          out: stdout,
          err: stderr,
        });
      },
    );

    child.on("error", reject);
  });
}

describe("backfill-origin CLI", () => {
  it("answers --help with usage and exit 0", async () => {
    const { out } = await runCli(["--help"]);

    expect(out).toMatch(/Usage: backfill-origin/);
  });

  it("documents --dry-run, --date, and the log entry in the help text", async () => {
    const { out } = await runCli(["--help"]);

    expect(out).toContain("--dry-run");
    expect(out).toContain("--date");
    expect(out).toContain("log.md");
  });

  it("runs on a wiki outside git after warning about the missing safety net", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    const result = await runCli(["--date", "2026-08-23", f.wikiDir, f.rawDir]);

    expect(result.code).toBe(0);
    expect(result.err).toContain("no git repo");
    expect(result.out).toContain("1 backfilled");
    expect(
      await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
    ).toContain(`origin: raw/${NOTE}`);
  });

  it("prints each backfilled pair with its origin path", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    const result = await runCli([
      "--dry-run",
      "--date",
      "2026-08-23",
      f.wikiDir,
      f.rawDir,
    ]);

    expect(result.out).toContain(
      `wiki/sources/gpu-memory-math.md -> raw/${NOTE}`,
    );
    expect(result.out).toContain("dry run — nothing written");
  });

  it("refuses to write when the wiki tree has uncommitted changes", async () => {
    const f = await makeFixture(
      { "sources/gpu-memory-math.md": sourcePage([NOTE]) },
      { [NOTE]: "note body" },
    );

    await run("git", ["-C", f.wikiDir, "init", "--quiet"]);
    await run("git", ["-C", f.wikiDir, "add", "-A"]);
    await run("git", [
      "-C",
      f.wikiDir,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    await writeFile(
      join(f.wikiDir, "sources/gpu-memory-math.md"),
      sourcePage([NOTE]).replace("body", "edited body"),
    );

    const result = await runCli(["--date", "2026-08-23", f.wikiDir, f.rawDir]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("uncommitted");
    expect(
      await readFile(join(f.wikiDir, "sources/gpu-memory-math.md"), "utf8"),
    ).not.toContain("origin:");
  });

  it("refuses to write when the wiki dir is a subdir of a dirty repo (real data-repo layout)", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-backfill-sub-"));

    tempDirs.push(root);

    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await mkdir(join(root, "raw", "notes/V"), { recursive: true });
    await writeFile(
      join(root, "wiki", "sources/gpu-memory-math.md"),
      sourcePage([NOTE]),
    );
    await writeFile(join(root, "raw", NOTE), "note body");

    await run("git", ["-C", root, "init", "--quiet"]);
    await run("git", ["-C", root, "add", "-A"]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    await writeFile(
      join(root, "wiki", "sources/gpu-memory-math.md"),
      sourcePage([NOTE]).replace("body", "edited body"),
    );

    const result = await runCli([
      "--date",
      "2026-08-23",
      join(root, "wiki"),
      join(root, "raw"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("uncommitted");
    expect(
      await readFile(join(root, "wiki", "sources/gpu-memory-math.md"), "utf8"),
    ).not.toContain("origin:");
  });
});
