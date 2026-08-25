import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { afterAll, describe, expect, it } from "vitest";
import { checkWikiProvenance } from "../src/wiki/provenance.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-provenance.ts",
);

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
  const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

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

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  // argv[1] must be the real path: import.meta.url is realpath'd by
  // Node, and a symlinked spawn path (macOS tmp) would make the CLI
  // import guard compare unequal and skip main().
  const realArgs = [realpathSync(script), ...args];
  const env = { ...process.env };

  delete env.NO_COLOR;
  Object.assign(env, extraEnv);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, realArgs, { stdio: "pipe", env });

    let out = "";
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("checkWikiProvenance", () => {
  it("rejects a raw directory that does not exist", async () => {
    const { wikiDir } = await makeFixture({ "index.md": "# Index" });
    const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

    tempDirs.push(root);

    await expect(
      checkWikiProvenance(wikiDir, join(root, "missing")),
    ).rejects.toThrow(`raw directory does not exist: ${join(root, "missing")}`);
  });

  it("rejects a raw path that is a file, not a directory", async () => {
    const { wikiDir } = await makeFixture({ "index.md": "# Index" });
    const fileAsRaw = join(dirname(wikiDir), "raw", "manifest.json");

    await writeFile(fileAsRaw, "{}\n");

    await expect(checkWikiProvenance(wikiDir, fileAsRaw)).rejects.toThrow(
      `raw directory is not a directory: ${fileAsRaw}`,
    );
  });

  it("passes when every sources link resolves and every origin exists", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\ntitle: Temp research\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
        "concepts/cites.md":
          '---\ntitle: Cites\nsources:\n  - "[[Temp research]]"\n---\nbody',
        "index.md": "# Index",
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
    expect(`${report.sources}/${report.origins}/${report.pages}`).toBe("1/1/3");
  });

  it("reports a sources link whose page is missing", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/cites.md":
        '---\ntitle: Cites\nsources:\n  - "[[Temp research]]"\n---\nbody',
      "index.md": "# Index",
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/cites.md -> [[Temp research]] (missing source page)",
    ]);
  });

  it("reports a sources path that no raw file backs", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "concepts/cites.md":
          '---\nsources:\n  - "notes/V/Scratch/temp.md"\n---\nbody',
      },
      { "notes/V/Scratch/other.md": "other body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/concepts/cites.md -> sources notes/V/Scratch/temp.md (missing under raw/)",
    ]);
  });

  it("resolves a sources path written with the raw/ prefix", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "concepts/cites.md":
          '---\nsources:\n  - "raw/notes/V/Scratch/temp.md"\n---\nbody',
      },
      { "notes/V/Scratch/temp.md": "temp body" },
    );

    expect((await checkWikiProvenance(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("reports a dangling origin that no raw file backs", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/Temp research.md":
          "---\norigin: raw/notes/V/Scratch/temp.md\n---\nbody",
      },
      { "notes/V/Scratch/other.md": "other body" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/Temp research.md -> origin raw/notes/V/Scratch/temp.md (missing under raw/)",
    ]);
  });

  it("resolves an origin written without the raw/ prefix", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/prefixless.md": "---\norigin: notes/V/a.md\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    expect((await checkWikiProvenance(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("reports one line per problem, pages in sorted order", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "a-page.md": '---\nsources:\n  - "[[Missing one]]"\n---\n',
      "b-page.md": '---\nsources:\n  - "[[Missing two]]"\n---\n',
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/a-page.md -> [[Missing one]] (missing source page)",
      "wiki/b-page.md -> [[Missing two]] (missing source page)",
    ]);
  });

  it("does not read sources or origins from AGENTS.md", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "AGENTS.md":
        '---\nsources:\n  - "[[Missing]]"\norigin: raw/notes/V/gone.md\n---\n',
      "index.md": "# Index",
    });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
    expect(report.pages).toBe(1);
  });

  it("counts type: source pages that lack origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/has.md":
          "---\ntype: source\norigin: raw/notes/V/a.md\n---\nbody",
        "sources/lacks.md":
          "---\ntype: source\nsources:\n  - notes/V/a.md\n---\nbody",
        "concepts/plain.md": "---\ntitle: Plain\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(`${report.missingOrigins}: ${report.problems.length}`).toBe("1: 0");
  });

  it("reports zero missing origins when every source page carries one", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/has.md":
          "---\ntype: source\norigin: raw/notes/V/a.md\n---\nbody",
        "concepts/plain.md": "---\ntitle: Plain\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    expect((await checkWikiProvenance(wikiDir, rawDir)).missingOrigins).toBe(0);
  });

  it("does not count a non-source page that lacks origin", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/plain.md": "---\ntitle: Plain\n---\nbody",
    });

    expect((await checkWikiProvenance(wikiDir, rawDir)).missingOrigins).toBe(0);
  });

  it("passes on an empty wiki", async () => {
    const { wikiDir, rawDir } = await makeFixture({ "index.md": "# Index" });

    const report = await checkWikiProvenance(wikiDir, rawDir);

    expect(report.problems).toEqual([]);
    expect(`${report.sources}/${report.origins}`).toBe("0/0");
  });

  it("rejects a wiki directory that does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

    tempDirs.push(root);

    await expect(
      checkWikiProvenance(join(root, "missing"), join(root, "raw")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a raw directory that does not exist", async () => {
    const { wikiDir } = await makeFixture({ "index.md": "# Index" });
    const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

    tempDirs.push(root);

    await expect(
      checkWikiProvenance(wikiDir, join(root, "missing")),
    ).rejects.toThrow(`raw directory does not exist: ${join(root, "missing")}`);
  });
});

describe("check-provenance CLI", () => {
  const paint = createColors(true);

  it("exits 0 with a green summary on a coherent wiki", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/S.md": "---\norigin: raw/notes/V/s.md\n---\nbody",
        "concepts/c.md": '---\nsources:\n  - "[[S]]"\n---\nbody',
      },
      { "notes/V/s.md": "s" },
    );

    const result = await runNode([wikiDir, rawDir]);

    expect(`${result.code}: ${result.out}`).toBe(
      `0: ${paint.green("ok: 1 source link resolves, 1 origin exists across 2 pages")}\n`,
    );
  });

  it("exits 1 and prints each problem line on a dangling origin", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "sources/gone.md": "---\norigin: raw/notes/V/gone.md\n---\nbody",
    });

    const result = await runNode([wikiDir, rawDir]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red("wiki/sources/gone.md -> origin raw/notes/V/gone.md (missing under raw/)")}\n`,
    );
  });

  it("exits 0 on the repository wiki and raw dirs with no arguments", async () => {
    const result = await runNode([]);

    expect(`${result.code}: ${result.out.startsWith("\u001b[32mok:")}`).toBe(
      "0: true",
    );
  });

  it("defaults the raw dir to the sibling of the given wiki dir", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/S.md": "---\norigin: raw/notes/V/s.md\n---\nbody",
      },
      { "notes/V/s.md": "s" },
    );

    const result = await runNode([wikiDir]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("1 origin exists");

    await rm(rawDir, { recursive: true, force: true });

    const failing = await runNode([wikiDir]);

    expect(failing.code).toBe(1);
  });

  it("exits 0 and prints the backfill warning when a source page lacks origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/lacks.md":
          "---\ntype: source\nsources:\n  - notes/V/a.md\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    const result = await runNode([wikiDir, rawDir]);
    const date = result.out.match(/--dry-run --date (\S+)/)?.[1] ?? "";

    expect(
      `${/^\d{4}-\d{2}-\d{2}$/.test(date)}: ${result.code}: ${result.out}`,
    ).toBe(
      `true: 0: ${paint.green("ok: 1 source link resolves, 0 origins exist across 1 page")}\n${paint.yellow("warning: 1 type: source page lacks origin — run a backfill:")}\n  first preview:  npm run backfill-origin -- --dry-run --date ${date} "${wikiDir}" "${rawDir}"\n  then write:     npm run backfill-origin -- --date ${date} "${wikiDir}" "${rawDir}"\n`,
    );
  });

  it("prints no warning when dead provenance exits 1 alongside missing origins", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "sources/lacks.md":
        "---\ntype: source\nsources:\n  - notes/V/gone.md\n---\nbody",
    });

    const result = await runNode([wikiDir, rawDir]);

    expect(`${result.code}: ${result.out.includes("warning:")}`).toBe(
      "1: false",
    );
  });

  it("pluralizes the missing-origin warning across several pages", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/lacks.md": "---\ntype: source\n---\nbody",
        "sources/lacks-too.md": "---\ntype: source\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    const result = await runNode([wikiDir, rawDir]);

    expect(
      `${result.code}: ${result.out.includes("warning: 2 type: source pages lack origin — run a backfill:")}`,
    ).toBe("0: true");
  });

  it("prints the warning without color codes when NO_COLOR is set", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/lacks.md": "---\ntype: source\n---\nbody",
      },
      { "notes/V/a.md": "a" },
    );

    const result = await runNode([wikiDir, rawDir], { NO_COLOR: "1" });

    expect(
      `${result.out.includes("warning: 1 type: source page lacks origin")}:${result.out.includes("\u001b[")}`,
    ).toBe("true:false");
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: check-provenance \[-h \| --help\] \[<wiki-dir> \[<raw-dir>\]\]/,
    );
  });

  it("exits 1 with a clean message when the wiki directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-provenance-"));

    tempDirs.push(root);

    const missing = join(root, "missing");

    const result = await runNode([missing]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red(`check-provenance: wiki directory does not exist: ${missing}`)}\n`,
    );
  });
});
