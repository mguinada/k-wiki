import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { afterAll, describe, expect, it } from "vitest";
import { checkWikiFidelity } from "../scripts/check-fidelity.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-fidelity.ts",
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
  const root = await mkdtemp(join(tmpdir(), "k-wiki-fidelity-"));

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

/** A source page whose tokens the fixture raw file backs. */
function sourcePage(origin: string, body: string, title = "S"): string {
  return `---\ntitle: ${title}\ntype: source\norigin: ${origin}\n---\n\n${body}\n`;
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

describe("checkWikiFidelity", () => {
  it("passes when every quoted token appears in the origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Uses `~/.gitconfig` with `push.pushOption`, `--skip pr`, and `npm run health` per `no-mistakes.skip=pr`.",
        ),
      },
      {
        "notes/V/s.md":
          "`~/.gitconfig` carries `push.pushOption`; run with `--skip pr` after `npm run health` (see `no-mistakes.skip=pr`).",
      },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(
      `${report.problems.length}:${report.quotes}/${report.titles}/${report.pages}`,
    ).toBe("0:5/1/1");
  });

  it("reports a tilde path absent from the origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "The backstop lives in `~/.gitconfig-k-wiki`.",
        ),
      },
      { "notes/V/s.md": "The backstop lives in `~/.gitconfig`." },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/s.md -> `~/.gitconfig-k-wiki` not in origin raw/notes/V/s.md",
    ]);
  });

  it("rejects a tilde path present only as a prefix of a longer origin path", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Edit `~/.gitconfig` directly.",
        ),
      },
      { "notes/V/s.md": "Edit `~/.gitconfig-k-wiki` directly." },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/s.md -> `~/.gitconfig` not in origin raw/notes/V/s.md",
    ]);
  });

  it("accepts a tilde path the origin continues as a subdirectory", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Installs into `~/.no-mistakes`.",
        ),
      },
      { "notes/V/s.md": "Installs into `~/.no-mistakes/bin/no-mistakes`." },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("reports a config key absent from the origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Set `push.pushoption` first.",
        ),
      },
      { "notes/V/s.md": "Set `push.pushOption` first." },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/s.md -> `push.pushoption` not in origin raw/notes/V/s.md",
    ]);
  });

  it("reports a long CLI flag absent from the origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Run with `--fail-on-stale`.",
        ),
      },
      { "notes/V/s.md": "Run with `--fail-stale`." },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/s.md -> `--fail-on-stale` not in origin raw/notes/V/s.md",
    ]);
  });

  it("reports a short CLI flag absent from the origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage("raw/notes/V/s.md", "Accept with `-y`."),
      },
      { "notes/V/s.md": "Accept with `-n`." },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/s.md -> `-y` not in origin raw/notes/V/s.md",
    ]);
  });

  it("reports an npm run command absent from the origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Run `npm run check-fidelity` after ingest.",
        ),
      },
      { "notes/V/s.md": "Run `npm run check-provenance` after ingest." },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/s.md -> `npm run check-fidelity` not in origin raw/notes/V/s.md",
    ]);
  });

  it("does not extract dotted file names from the body", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Configured by `sync.json`.",
        ),
      },
      { "notes/V/s.md": "Configured by the sync config." },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("does not extract hyphenated dotted compounds from the body", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "A `CLAUDE.md-size` budget and a `Builder.io-affiliated` author.",
        ),
      },
      { "notes/V/s.md": "A `CLAUDE.md` budget and a `Builder.io` author." },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("does not extract dotted hostnames from the body", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Published on `dev.to`.",
        ),
      },
      { "notes/V/s.md": "Published on a listicle site." },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("does not extract latin abbreviations from the body", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Some tools, e.g. linters, run first. See also i.e. notes.",
        ),
      },
      { "notes/V/s.md": "Some tools run first." },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("skips quote checking for source pages without origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md":
          "---\ntitle: S\ntype: source\nsources:\n  - notes/V/s.md\n---\nUses `~/.missing`.\n",
      },
      { "notes/V/s.md": "s" },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(`${report.problems.length}:${report.skipped}`).toBe("0:1");
  });

  it("skips quote checking when the origin file is missing under raw", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/gone.md",
          "Uses `~/.gitconfig`.",
        ),
      },
      { "notes/V/other.md": "other" },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(`${report.problems.length}:${report.quotes}`).toBe("0:0");
  });

  it("does not quote-check pages that are not type source", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "concepts/c.md":
          "---\ntitle: C\ntype: concept\norigin: raw/notes/V/s.md\n---\nUses `~/.gitconfig`.\n",
      },
      { "notes/V/s.md": "unrelated" },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("excludes frontmatter closed by an indented fence from the body scan", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md":
          "---\ntitle: S\ntype: source\norigin: raw/notes/V/s.md\nsources:\n  - ~/.stale-cache\n  ---\nClean body.\n",
      },
      { "notes/V/s.md": "clean" },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(`${report.problems.length}:${report.quotes}`).toBe("0:0");
  });

  it("trims trailing punctuation from a tilde path at sentence end", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "The shim lives at ~/Lab/k-wiki/bin/shim.",
        ),
      },
      {
        "notes/V/s.md":
          "The shim lives at ~/Lab/k-wiki/bin/shim, never elsewhere.",
      },
    );

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("reports a title that does not kebab to the file name", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/wiki-page-primitives.md":
        '---\ntitle: "Wiki parsing primitives"\ntype: concept\n---\nbody',
    });

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      'wiki/concepts/wiki-page-primitives.md -> title "Wiki parsing primitives" does not kebab to wiki-page-primitives',
    ]);
  });

  it("passes a title that kebabs to the file name", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "concepts/settings-yml.md":
        "---\ntitle: settings.yml\ntype: concept\n---\nbody",
    });

    expect((await checkWikiFidelity(wikiDir, rawDir)).problems).toEqual([]);
  });

  it("exempts the structural pages from the title check", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "index.md": "---\ntitle: Wiki Index\n---\n",
      "overview.md": "---\ntitle: Wiki Overview\n---\n",
      "log.md": "---\ntitle: Wiki Log\n---\n",
    });

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(`${report.problems.length}:${report.titles}`).toBe("0:0");
  });

  it("reports one line per token, pages in sorted order", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/a.md": sourcePage(
          "raw/notes/V/s.md",
          "Uses `~/.one` and `--two`.",
          "A",
        ),
        "sources/b.md": sourcePage(
          "raw/notes/V/s.md",
          "Uses `npm run x`.",
          "B",
        ),
      },
      { "notes/V/s.md": "nothing machine-checkable here" },
    );

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(report.problems).toEqual([
      "wiki/sources/a.md -> `--two` not in origin raw/notes/V/s.md",
      "wiki/sources/a.md -> `~/.one` not in origin raw/notes/V/s.md",
      "wiki/sources/b.md -> `npm run x` not in origin raw/notes/V/s.md",
    ]);
  });

  it("does not check titles or quotes from AGENTS.md", async () => {
    const { wikiDir, rawDir } = await makeFixture({
      "AGENTS.md":
        "---\ntitle: Wrong\norigin: raw/notes/V/s.md\n---\nUses `~/.gone`.\n",
    });

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(`${report.problems.length}:${report.pages}`).toBe("0:0");
  });

  it("passes on an empty wiki", async () => {
    const { wikiDir, rawDir } = await makeFixture({ "index.md": "# Index" });

    const report = await checkWikiFidelity(wikiDir, rawDir);

    expect(
      `${report.problems.length}:${report.quotes}/${report.titles}/${report.skipped}`,
    ).toBe("0:0/0/0");
  });

  it("rejects a wiki directory that does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-fidelity-"));

    tempDirs.push(root);

    await expect(
      checkWikiFidelity(join(root, "missing"), join(root, "raw")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a raw directory that does not exist", async () => {
    const { wikiDir } = await makeFixture({ "index.md": "# Index" });
    const root = await mkdtemp(join(tmpdir(), "k-wiki-fidelity-"));

    tempDirs.push(root);

    await expect(
      checkWikiFidelity(wikiDir, join(root, "missing")),
    ).rejects.toThrow(`raw directory does not exist: ${join(root, "missing")}`);
  });
});

describe("check-fidelity CLI", () => {
  const paint = createColors(true);

  it("exits 0 with a green summary on a faithful wiki", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "Uses `~/.gitconfig` and `npm run health`.",
        ),
        "concepts/c.md": "---\ntitle: C\n---\nbody",
      },
      {
        "notes/V/s.md": "`~/.gitconfig` after `npm run health`.",
      },
    );

    const result = await runNode([wikiDir, rawDir]);

    expect(`${result.code}: ${result.out}`).toBe(
      `0: ${paint.green("ok: 2 tokens trace to origins, 2 titles match across 2 pages")}\n`,
    );
  });

  it("exits 1 and prints each problem line on a misquoted token", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage(
          "raw/notes/V/s.md",
          "The backstop lives in `~/.gitconfig-k-wiki`.",
        ),
      },
      { "notes/V/s.md": "The backstop lives in `~/.gitconfig`." },
    );

    const result = await runNode([wikiDir, rawDir]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red("wiki/sources/s.md -> `~/.gitconfig-k-wiki` not in origin raw/notes/V/s.md")}\n`,
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
        "sources/s.md": sourcePage("raw/notes/V/s.md", "Uses `~/.gitconfig`."),
      },
      { "notes/V/s.md": "`~/.gitconfig`." },
    );

    const passing = await runNode([wikiDir]);

    await rm(rawDir, { recursive: true, force: true });

    const failing = await runNode([wikiDir]);

    expect(
      `${passing.code}:${passing.out.includes("1 token traces")}:${failing.code}`,
    ).toBe("0:true:1");
  });

  it("prints the backfill warning when a source page lacks origin", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md":
          "---\ntitle: S\ntype: source\nsources:\n  - notes/V/s.md\n---\nbody",
      },
      { "notes/V/s.md": "s" },
    );

    const result = await runNode([wikiDir, rawDir]);
    const date = result.out.match(/--dry-run --date (\S+)/)?.[1] ?? "";

    expect(
      `${/^\d{4}-\d{2}-\d{2}$/.test(date)}: ${result.code}: ${result.out}`,
    ).toBe(
      `true: 0: ${paint.green("ok: 0 tokens trace to origins, 1 title matches across 1 page")}\n${paint.yellow("warning: 1 type: source page lacks origin — run a backfill:")}\n  first preview:  npm run backfill-origin -- --dry-run --date ${date} "${wikiDir}" "${rawDir}"\n  then write:     npm run backfill-origin -- --date ${date} "${wikiDir}" "${rawDir}"\n`,
    );
  });

  it("prints no warning when fidelity problems exit 1 alongside missing origins", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage("raw/notes/V/s.md", "Uses `~/.gone`."),
        "sources/t.md":
          "---\ntitle: Wrong\ntype: source\nsources:\n  - notes/V/s.md\n---\nbody\n",
      },
      { "notes/V/s.md": "s" },
    );

    const result = await runNode([wikiDir, rawDir]);

    expect(`${result.code}: ${result.out.includes("warning:")}`).toBe(
      "1: false",
    );
  });

  it("prints the problem lines without color codes when NO_COLOR is set", async () => {
    const { wikiDir, rawDir } = await makeFixture(
      {
        "sources/s.md": sourcePage("raw/notes/V/s.md", "Uses `~/.gone`."),
      },
      { "notes/V/s.md": "s" },
    );

    const result = await runNode([wikiDir, rawDir], { NO_COLOR: "1" });

    expect(
      `${result.err.includes("~/.gone")}:${result.err.includes("\u001b[")}`,
    ).toBe("true:false");
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: check-fidelity \[-h \| --help\] \[<wiki-dir> \[<raw-dir>\]\]/,
    );
  });

  it("exits 1 with a clean message when the wiki directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-fidelity-"));

    tempDirs.push(root);

    const missing = join(root, "missing");

    const result = await runNode([missing]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red(`check-fidelity: wiki directory does not exist: ${missing}`)}\n`,
    );
  });

  it("exits 1 when given more than two arguments", async () => {
    const result = await runNode(["a", "b", "c"]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red("check-fidelity: expected at most two arguments")}\n`,
    );
  });
});
