import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { afterAll, describe, expect, it } from "vitest";

/** CLI tests for bin/check-fidelity (scripts/check-fidelity.ts):
 *  exit codes, colored rendering, warnings, --help. The library core
 *  (checkWikiFidelity, extractArtifacts) is tested at its mirrored
 *  path tests/wiki/fidelity.test.ts (issue #260). */

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../bin/check-fidelity",
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
