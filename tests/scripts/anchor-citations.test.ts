import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { anchorCitations } from "../../scripts/anchor-citations.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../bin/anchor-citations.ts",
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A wiki tree at `<root>/wiki`. */
async function makeWiki(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-anchor-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(pages)) {
    await mkdir(join(root, "wiki", dirname(file)), { recursive: true });
    await writeFile(join(root, "wiki", file), content);
  }

  return join(root, "wiki");
}

/** A `type: source` hub page whose own sources cite chapters. */
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

/** A migrated multi-part hub: origin self-link plus two aliased
 *  chapter self-citations, one with irregular double whitespace. */
const MIGRATED_HUB = {
  "sources/sdn.md": hub(
    "System design interview notes",
    "notes/Books/SDN/Readme.md",
    ["[[sdn]]", "[[sdn|04. Rate Limiter]]", "[[sdn|27.  Digital Wallet]]"],
  ),
} as const;

describe("anchorCitations", () => {
  it("rewrites a citing page's aliased chapter citation to the anchored form", async () => {
    const wikiDir = await makeWiki({
      "sources/sdn.md": hub(
        "System design interview notes",
        "notes/Books/SDN/Readme.md",
        ["[[sdn]]", "[[sdn#04. Rate Limiter]]", "[[sdn#27.  Digital Wallet]]"],
      ),
      "concepts/cites.md": citing(["[[sdn|04. Rate Limiter]]"]),
    });

    const report = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(report.rewrites).toEqual([
      {
        page: "concepts/cites.md",
        entry: "[[sdn|04. Rate Limiter]]",
        replacement: "[[sdn#04. Rate Limiter]]",
      },
    ]);
  });

  it("rewrites the hub's own aliased chapter self-citations", async () => {
    const wikiDir = await makeWiki({ ...MIGRATED_HUB });

    const report = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(report.rewrites).toEqual([
      {
        page: "sources/sdn.md",
        entry: "[[sdn|04. Rate Limiter]]",
        replacement: "[[sdn#04. Rate Limiter]]",
      },
      {
        page: "sources/sdn.md",
        entry: "[[sdn|27.  Digital Wallet]]",
        replacement: "[[sdn#27.  Digital Wallet]]",
      },
    ]);
  });

  it("inserts one heading per cited chapter into each hub body, in citation order", async () => {
    const wikiDir = await makeWiki({ ...MIGRATED_HUB });

    const report = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(report.headings).toEqual([
      { page: "sources/sdn.md", chapter: "04. Rate Limiter" },
      { page: "sources/sdn.md", chapter: "27.  Digital Wallet" },
    ]);
  });

  it("writes the generated headings byte-identical to the chapter names", async () => {
    const wikiDir = await makeWiki({ ...MIGRATED_HUB });

    await anchorCitations(wikiDir, { write: true, date: "2026-08-30" });
    const text = await readFile(join(wikiDir, "sources", "sdn.md"), "utf8");

    expect(
      text.endsWith(
        "digest\n\n## 04. Rate Limiter\n\n## 27.  Digital Wallet\n",
      ),
    ).toBe(true);
  });

  it("is idempotent: a second run reports nothing and changes no file", async () => {
    const wikiDir = await makeWiki({
      ...MIGRATED_HUB,
      "concepts/cites.md": citing(["[[sdn|04. Rate Limiter]]"]),
    });

    await anchorCitations(wikiDir, { write: true, date: "2026-08-30" });
    const settled = await readFile(join(wikiDir, "sources", "sdn.md"), "utf8");
    const second = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(
      `${second.rewrites.length}:${second.headings.length}:${(await readFile(join(wikiDir, "sources", "sdn.md"), "utf8")) === settled}`,
    ).toBe("0:0:true");
  });

  it("leaves a display alias to a concept page untouched", async () => {
    const wikiDir = await makeWiki({
      "concepts/event-sourcing.md": hub(
        "Event sourcing",
        "notes/V/es.md",
        [],
      ).replace("type: source", "type: concept"),
      "concepts/cites.md": citing(["[[event-sourcing|event logs]]"]),
    });

    const report = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(`${report.rewrites.length}:${report.skipped.length}`).toBe("0:0");
  });

  it("skips and reports a hub alias that names no chapter of that hub", async () => {
    const wikiDir = await makeWiki({
      ...MIGRATED_HUB,
      "concepts/cites.md": citing(["[[sdn|Utah]]"]),
    });

    const report = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(report.skipped).toEqual([
      {
        page: "concepts/cites.md",
        entry: "[[sdn|Utah]]",
        reason: "alias does not name a chapter of this hub",
      },
    ]);
  });

  it("generates headings for a hub whose own chapters are still legacy path entries", async () => {
    const wikiDir = await makeWiki({
<<<<<<< Updated upstream
      "sources/sdn.md": hub("System design interview notes", "notes/Books/SDN/Readme.md", [
        "notes/Books/SDN/Readme.md",
        "notes/Books/SDN/04. Rate Limiter/Readme.md",
      ]),
=======
      "sources/sdn.md": hub(
        "System design interview notes",
        "notes/Books/SDN/Readme.md",
        [
          "notes/Books/SDN/Readme.md",
          "notes/Books/SDN/04. Rate Limiter/Readme.md",
        ],
      ),
>>>>>>> Stashed changes
    });

    const report = await anchorCitations(wikiDir, {
      write: true,
      date: "2026-08-30",
    });

    expect(report.headings).toEqual([
      { page: "sources/sdn.md", chapter: "04. Rate Limiter" },
    ]);
  });

  it("writes nothing in dry-run mode", async () => {
    const wikiDir = await makeWiki({
      ...MIGRATED_HUB,
      "concepts/cites.md": citing(["[[sdn|04. Rate Limiter]]"]),
    });

    await anchorCitations(wikiDir, { write: false, date: "2026-08-30" });

    expect(await readFile(join(wikiDir, "concepts", "cites.md"), "utf8")).toBe(
      citing(["[[sdn|04. Rate Limiter]]"]),
    );
  });

  it("appends an audit entry with every rewrite and heading to wiki/log.md", async () => {
    const wikiDir = await makeWiki({
      ...MIGRATED_HUB,
      "concepts/cites.md": citing(["[[sdn|04. Rate Limiter]]"]),
    });

    await anchorCitations(wikiDir, { write: true, date: "2026-08-30" });
    const log = await readFile(join(wikiDir, "log.md"), "utf8");

    expect(
      `${log.includes("## [2026-08-30] anchor-citations-migration | 2 pages")}:${log.includes('- wiki/concepts/cites.md: "[[sdn|04. Rate Limiter]]" -> "[[sdn#04. Rate Limiter]]"')}:${log.includes('- wiki/sources/sdn.md: + "## 27.  Digital Wallet"')}`,
    ).toBe("true:true:true");
  });

  it("throws when the wiki directory does not exist", async () => {
    await expect(
      anchorCitations("/nonexistent-wiki", {
        write: false,
        date: "2026-08-30",
      }),
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

describe("anchor-citations CLI", () => {
  it("prints help and exits 0 without touching the wiki", async () => {
    const wikiDir = await makeWiki({ ...MIGRATED_HUB });
    const result = await runCli(["--help", wikiDir]);

    expect(
      `${result.code}:${result.out.includes("Usage: anchor-citations")}:${(await readFile(join(wikiDir, "sources", "sdn.md"), "utf8")) === MIGRATED_HUB["sources/sdn.md"]}`,
    ).toBe("0:true:true");
  });

  it("dry-runs by default and reports the planned migration", async () => {
    const wikiDir = await makeWiki({ ...MIGRATED_HUB });
    const result = await runCli([wikiDir]);

    expect(
      `${result.code}:${result.out.includes("[[sdn#04. Rate Limiter]]")}:${result.out.includes("dry run")}`,
    ).toBe("0:true:true");
  });
});
