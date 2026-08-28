import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { linkSources } from "../scripts/link-sources.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../bin/link-sources.ts",
);

const run = promisify(execFile);
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A wiki tree at `<root>/wiki`. */
async function makeWiki(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-link-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(pages)) {
    await mkdir(join(root, "wiki", dirname(file)), { recursive: true });
    await writeFile(join(root, "wiki", file), content);
  }

  return join(root, "wiki");
}

/** A `type: source` hub with an origin and its own raw-path cite. */
function hub(name: string, origin: string, sources: readonly string[]): string {
  return [
    "---",
    `title: "${name}"`,
    "type: source",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - source",
    `origin: raw/${origin}`,
    "sources:",
    ...sources.map((entry) => `  - "${entry}"`),
    "---",
    "",
    "digest",
    "",
  ].join("\n");
}

/** A derived page citing the given `sources` entries. */
function citing(entries: readonly string[]): string {
  return [
    "---",
    'title: "Cites"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    ...entries.map((entry) => `  - "${entry}"`),
    "---",
    "",
    "body",
    "",
  ].join("\n");
}

const SIMPLE_HUB = hub("Gpu memory math", "notes/V/gpu-memory-math.md", []);
const SELF_CITING_HUB = hub("Gpu memory math", "notes/V/gpu-memory-math.md", [
  "notes/V/gpu-memory-math.md",
]);

const CHAPTER = "notes/Books/SDN/04. Rate Limiter/Readme.md";
const MULTIPART_HUB = hub(
  "System design interview notes",
  "notes/Books/SDN/Readme.md",
  ["notes/Books/SDN/Readme.md", CHAPTER],
);

describe("linkSources", () => {
  it("rewrites a cited path matching a hub's origin to a plain wikilink", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toEqual([
      {
        page: "concepts/cites.md",
        entry: "notes/V/gpu-memory-math.md",
        replacement: "[[gpu-memory-math]]",
      },
    ]);
  });

  it("rewrites the hub's own origin cite to a self wikilink", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SELF_CITING_HUB,
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toEqual([
      {
        page: "sources/gpu-memory-math.md",
        entry: "notes/V/gpu-memory-math.md",
        replacement: "[[gpu-memory-math]]",
      },
    ]);
  });

  it("rewrites a chapter cite covered by a hub's own sources to an aliased wikilink", async () => {
    const wikiDir = await makeWiki({
      "sources/system-design-interview-notes.md": MULTIPART_HUB,
      "concepts/rate-limiting.md": citing([CHAPTER]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toEqual([
      {
        page: "concepts/rate-limiting.md",
        entry: CHAPTER,
        replacement: "[[system-design-interview-notes|04. Rate Limiter]]",
      },
      {
        page: "sources/system-design-interview-notes.md",
        entry: "notes/Books/SDN/Readme.md",
        replacement: "[[system-design-interview-notes]]",
      },
      {
        page: "sources/system-design-interview-notes.md",
        entry: CHAPTER,
        replacement: "[[system-design-interview-notes|04. Rate Limiter]]",
      },
    ]);
  });

  it("rewrites a late path-form cite against a migrated hub's self-wikilinks", async () => {
    const wikiDir = await makeWiki({
      "sources/system-design-interview-notes.md": hub(
        "System design interview notes",
        "notes/Books/SDN/Readme.md",
        [
          "[[system-design-interview-notes]]",
          "[[system-design-interview-notes|04. Rate Limiter]]",
        ],
      ),
      "concepts/rate-limiting.md": citing([CHAPTER]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toEqual([
      {
        page: "concepts/rate-limiting.md",
        entry: CHAPTER,
        replacement: "[[system-design-interview-notes|04. Rate Limiter]]",
      },
    ]);
  });

  it("counts a migrated hub's already-linked cites", async () => {
    const wikiDir = await makeWiki({
      "sources/system-design-interview-notes.md": hub(
        "System design interview notes",
        "notes/Books/SDN/Readme.md",
        [
          "[[system-design-interview-notes]]",
          "[[system-design-interview-notes|04. Rate Limiter]]",
        ],
      ),
      "concepts/rate-limiting.md": citing([CHAPTER]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
      entry: "notes/V/y.md",
      replacement: "[[b]]",
    });

    expect(report.alreadyLinked).toBe(2);
  });

  it("prefers the origin match over the citation match", async () => {
    const wikiDir = await makeWiki({
      "sources/a.md": hub("A", "notes/V/x.md", [
        "notes/V/x.md",
        "notes/V/y.md",
      ]),
      "sources/b.md": hub("B", "notes/V/y.md", ["notes/V/y.md"]),
      "concepts/cites.md": citing(["notes/V/y.md"]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toContainEqual({
      page: "concepts/cites.md",
      entry: "notes/V/y.md",
      replacement: "[[b]]",
    });
  });

  const NO_ORIGIN_HUB = [
    "---",
    'title: "System design interview notes"',
    "type: source",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - source",
    "sources:",
    `  - "${CHAPTER}"`,
    "---",
    "",
    "digest",
    "",
  ].join("\n");

  it("skips and reports a no-origin hub's own chapter cite while migrating the citing page", async () => {
    const noOriginHub = NO_ORIGIN_HUB;
    const wikiDir = await makeWiki({
      "sources/sdn.md": noOriginHub,
      "concepts/rate-limiting.md": citing([CHAPTER]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.skipped).toEqual([
      {
        page: "sources/sdn.md",
        entry: CHAPTER,
        reason: "hub has no origin to anchor its own chapter coverage",
      },
    ]);
  });

  it("migrates the citing page past a no-origin hub", async () => {
    const wikiDir = await makeWiki({
      "sources/sdn.md": NO_ORIGIN_HUB,
      "concepts/rate-limiting.md": citing([CHAPTER]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toEqual([
      {
        page: "concepts/rate-limiting.md",
        entry: CHAPTER,
        replacement: "[[sdn|04. Rate Limiter]]",
      },
    ]);
  });

  it("leaves the no-origin hub untouched", async () => {
    const wikiDir = await makeWiki({
      "sources/sdn.md": NO_ORIGIN_HUB,
      "concepts/rate-limiting.md": citing([CHAPTER]),
    });

    await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(await readFile(join(wikiDir, "sources", "sdn.md"), "utf8")).toBe(
      NO_ORIGIN_HUB,
    );
  });

  it("rewrites a hub with an origin's own chapter cite to a self-wikilink", async () => {
    const wikiDir = await makeWiki({
      "sources/system-design-interview-notes.md": MULTIPART_HUB,
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.rewrites).toEqual([
      {
        page: "sources/system-design-interview-notes.md",
        entry: "notes/Books/SDN/Readme.md",
        replacement: "[[system-design-interview-notes]]",
      },
      {
        page: "sources/system-design-interview-notes.md",
        entry: CHAPTER,
        replacement: "[[system-design-interview-notes|04. Rate Limiter]]",
      },
    ]);
    expect(report.skipped).toEqual([]);
  });

  it("skips nothing when the hub has an origin", async () => {
    const wikiDir = await makeWiki({
      "sources/system-design-interview-notes.md": MULTIPART_HUB,
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.skipped).toEqual([]);
  });

  it("skips and reports a cited path no hub covers", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/uncovered.md"]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.skipped).toEqual([
      {
        page: "concepts/cites.md",
        entry: "notes/V/uncovered.md",
        reason: "no hub covers this path",
      },
    ]);
  });

  it("skips and reports a path covered by two hubs", async () => {
    const wikiDir = await makeWiki({
      "sources/one.md": hub("One", "notes/V/x.md", []),
      "sources/two.md": hub("Two", "notes/V/x.md", []),
      "concepts/cites.md": citing(["notes/V/x.md"]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(report.skipped).toEqual([
      {
        page: "concepts/cites.md",
        entry: "notes/V/x.md",
        reason: "covered by more than one hub",
      },
    ]);
  });

  it("leaves wikilink entries untouched and counts them", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["[[gpu-memory-math]]"]),
    });

    const report = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(`${report.rewrites.length}:${report.alreadyLinked}`).toBe("0:1");
  });

  it("writes the rewritten sources list and nothing else", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": [
        "---",
        'title: "Cites"',
        "type: concept",
        "created: 2026-08-20",
        "updated: 2026-08-20",
        "tags:",
        "  - llm",
        "sources:",
        '  - "notes/V/gpu-memory-math.md"',
        "---",
        "",
        "body mentions notes/V/gpu-memory-math.md verbatim",
        "",
      ].join("\n"),
    });

    await linkSources(wikiDir, { write: true, date: "2026-08-26" });

    expect(await readFile(join(wikiDir, "concepts", "cites.md"), "utf8")).toBe(
      [
        "---",
        'title: "Cites"',
        "type: concept",
        "created: 2026-08-20",
        "updated: 2026-08-20",
        "tags:",
        "  - llm",
        "sources:",
        '  - "[[gpu-memory-math]]"',
        "---",
        "",
        "body mentions notes/V/gpu-memory-math.md verbatim",
        "",
      ].join("\n"),
    );
  });

  it("writes nothing in dry-run mode", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    await linkSources(wikiDir, { write: false, date: "2026-08-26" });

    expect(await readFile(join(wikiDir, "concepts", "cites.md"), "utf8")).toBe(
      citing(["notes/V/gpu-memory-math.md"]),
    );
  });

  it("is idempotent: a second write run reports no rewrites", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    await linkSources(wikiDir, { write: true, date: "2026-08-26" });
    const second = await linkSources(wikiDir, {
      write: true,
      date: "2026-08-26",
    });

    expect(second.rewrites).toEqual([]);
  });

  it("appends an audit entry to wiki/log.md on a write with rewrites", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    await linkSources(wikiDir, { write: true, date: "2026-08-26" });
    const log = await readFile(join(wikiDir, "log.md"), "utf8");

    expect(log).toContain(
      "## [2026-08-26] sources-wikilink-migration | 1 page",
    );
  });

  it("lists the rewrite in the audit entry", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    await linkSources(wikiDir, { write: true, date: "2026-08-26" });
    const log = await readFile(join(wikiDir, "log.md"), "utf8");

    expect(log).toContain(
      '- wiki/concepts/cites.md: "notes/V/gpu-memory-math.md" -> "[[gpu-memory-math]]"',
    );
  });

  it("writes no log entry when a dry run or a write finds no rewrites", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["[[gpu-memory-math]]"]),
    });

    await linkSources(wikiDir, { write: true, date: "2026-08-26" });

    await expect(
      readFile(join(wikiDir, "log.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws when the wiki directory does not exist", async () => {
    await expect(
      linkSources("/nonexistent-wiki", { write: false, date: "2026-08-26" }),
    ).rejects.toThrow("wiki directory does not exist");
  });
});

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Spawn the CLI with NO_COLOR, real path (macOS tmp symlink). */
async function runCli(args: readonly string[]): Promise<RunResult> {
  const real = realpathSync(script);

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [real, ...args],
      { env: { ...process.env, NO_COLOR: "1" } },
      (error, out, err) => {
        resolve({
          code: error === null ? 0 : Number(error.code ?? 1),
          out: out ?? "",
          err: err ?? "",
        });
      },
    );

    child.on("error", reject);
  });
}

describe("link-sources CLI", () => {
  it("prints the usage line for --help with exit 0", async () => {
    const result = await runCli(["--help"]);

    expect(
      `${result.code}: ${result.out.startsWith("Usage: link-sources")}`,
    ).toBe("0: true");
  });

  it("plans rewrites but writes nothing with no switch", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    const result = await runCli([wikiDir]);

    expect(`${result.code}: ${result.out.includes("--write")}`).toBe("0: true");
  });

  it("prints the planned rewrite without --write", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    const result = await runCli([wikiDir]);

    expect(result.out).toContain(
      'wiki/concepts/cites.md: "notes/V/gpu-memory-math.md" -> "[[gpu-memory-math]]"',
    );
  });

  it("leaves the citing page unwritten without --write", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    await runCli([wikiDir]);

    expect(await readFile(join(wikiDir, "concepts", "cites.md"), "utf8")).toBe(
      citing(["notes/V/gpu-memory-math.md"]),
    );
  });

  it("performs the rewrite with --write", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    const result = await runCli([wikiDir, "--write"]);

    expect(result.code).toBe(0);
  });

  it("rewrites the citing page with --write", async () => {
    const wikiDir = await makeWiki({
      "sources/gpu-memory-math.md": SIMPLE_HUB,
      "concepts/cites.md": citing(["notes/V/gpu-memory-math.md"]),
    });

    await runCli([wikiDir, "--write"]);

    expect(await readFile(join(wikiDir, "concepts", "cites.md"), "utf8")).toBe(
      citing(["[[gpu-memory-math]]"]),
    );
  });

  it("refuses --write on a wiki tree with uncommitted changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-link-dirty-"));

    tempDirs.push(root);

    await mkdir(join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(join(root, "wiki", "concepts", "cites.md"), citing([]));
    await run("git", ["init", "--quiet"], { cwd: root });
    await run(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: root },
    );
    await writeFile(
      join(root, "wiki", "concepts", "cites.md"),
      citing(["[[dirty]]"]),
    );

    const result = await runCli([join(root, "wiki"), "--write"]);

    expect(
      `${result.code}: ${result.err.includes("uncommitted changes")}`,
    ).toBe("1: true");
  });

  it("exits 1 with a clean message on bad arguments", async () => {
    const result = await runCli(["--bogus"]);

    expect(`${result.code}: ${result.err.startsWith("link-sources:")}`).toBe(
      "1: true",
    );
  });
});
