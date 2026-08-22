import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { afterAll, describe, expect, it } from "vitest";
import { checkWikiLinks } from "../scripts/check-links.ts";
import {
  buildPageIndex,
  extractWikilinks,
  wikilinkBodyTarget,
} from "../src/wiki-links.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-links.ts",
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A minimal wiki tree at `<root>/wiki` holding the given files. */
async function makeWiki(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-links-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, "wiki", dirname(file)), { recursive: true });
    await writeFile(join(root, "wiki", file), content);
  }

  return root;
}

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(args: readonly string[]): Promise<RunResult> {
  // argv[1] must be the real path: import.meta.url is realpath'd by
  // Node, and a symlinked spawn path (macOS tmp) would make the CLI
  // import guard compare unequal and skip main().
  const realArgs = [realpathSync(script), ...args];

  // Colored expectations: drop NO_COLOR so the child always renders
  // codes (one dedicated test below runs with NO_COLOR=1 instead).
  const env = { ...process.env };

  delete env.NO_COLOR;

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

describe("extractWikilinks", () => {
  it("extracts the page name of a bare wikilink", () => {
    expect(
      extractWikilinks("See [[retrieval-augmented-generation]] here."),
    ).toEqual([
      {
        target: "retrieval-augmented-generation",
        line: 1,
        raw: "[[retrieval-augmented-generation]]",
      },
    ]);
  });

  it("keeps only the page name of an aliased wikilink", () => {
    expect(extractWikilinks("[[vector-database|my db]]")).toEqual([
      {
        target: "vector-database",
        line: 1,
        raw: "[[vector-database|my db]]",
      },
    ]);
  });

  it("drops the heading anchor from the page name", () => {
    expect(extractWikilinks("[[vector-database#Vendors]]")[0]?.target).toBe(
      "vector-database",
    );
  });

  it("records the 1-based line of each wikilink", () => {
    const text = "First.\n\nThen [[fine-tuning]] and later [[kv-cache]].\n";

    expect(extractWikilinks(text).map((link) => link.line)).toEqual([3, 3]);
  });

  it("ignores anchor-only links and single-bracket text", () => {
    expect(
      extractWikilinks("[[#Details]] and [[|alias]] and [not a link]"),
    ).toEqual([]);
  });

  it("skips wikilinks inside a fenced code block", () => {
    const text = [
      "Example:",
      "",
      "```text",
      "[[missing-page|alias]]",
      "```",
      "",
      "See [[real-page]].",
    ].join("\n");

    expect(extractWikilinks(text)).toEqual([
      {
        target: "real-page",
        line: 7,
        raw: "[[real-page]]",
      },
    ]);
  });

  it("does not end a backtick fence at a tilde delimiter", () => {
    const text = [
      "```text",
      "~~~",
      "[[inside-fence]]",
      "```",
      "[[after-fence]]",
    ].join("\n");

    expect(extractWikilinks(text)).toEqual([
      {
        target: "after-fence",
        line: 5,
        raw: "[[after-fence]]",
      },
    ]);
  });
});

describe("wikilinkBodyTarget", () => {
  it("keeps only the page name before an alias", () => {
    expect(wikilinkBodyTarget("vector-database|my db")).toBe("vector-database");
  });

  it("keeps only the page name before a heading anchor", () => {
    expect(wikilinkBodyTarget("vector-database#Vendors")).toBe(
      "vector-database",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(wikilinkBodyTarget(" vector-db ")).toBe("vector-db");
  });

  it("returns the body unchanged when it has no alias or anchor", () => {
    expect(wikilinkBodyTarget("Temp research")).toBe("Temp research");
  });
});

describe("buildPageIndex", () => {
  it("maps a kebab-case file name to its wiki-relative path", () => {
    expect(
      buildPageIndex(["concepts/vector-database.md"]).get("vector-database"),
    ).toBe("concepts/vector-database.md");
  });

  it("ignores files that are not markdown", () => {
    expect(
      buildPageIndex(["concepts/vector-database.txt"]).has("vector-database"),
    ).toBe(false);
  });
});

describe("checkWikiLinks", () => {
  it("resolves a wikilink across wiki subdirectories", async () => {
    const root = await makeWiki({
      "index.md": "Start at [[vector-database]].\n",
      "concepts/vector-database.md": "# Vector Database\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(report.broken).toEqual([]);
  });

  it("counts the found links and scanned pages of a clean tree", async () => {
    const root = await makeWiki({
      "index.md": "Start at [[vector-database]].\n",
      "concepts/vector-database.md": "# Vector Database\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(`${report.links}/${report.pages}`).toBe("1/2");
  });

  it("reports a broken link as file:line -> [[link]]", async () => {
    const root = await makeWiki({
      "index.md": "Intro line.\nBroken [[missing-page]] here.\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(report.broken).toEqual(["wiki/index.md:2 -> [[missing-page]]"]);
  });

  it("prints the original aliased text for a broken link", async () => {
    const root = await makeWiki({
      "index.md": "Broken [[missing-page|alias]] here.\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(report.broken).toEqual([
      "wiki/index.md:1 -> [[missing-page|alias]]",
    ]);
  });

  it("does not report wikilinks inside AGENTS.md", async () => {
    const root = await makeWiki({
      "AGENTS.md": "Use `[[missing-page]]` syntax.\n",
      "index.md": "# Home\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(report.broken).toEqual([]);
  });

  it("does not count AGENTS.md as a scanned page", async () => {
    const root = await makeWiki({
      "AGENTS.md": "# Contract\n",
      "index.md": "# Home\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(report.pages).toBe(1);
  });

  it("does not resolve AGENTS as a wikilink target", async () => {
    const root = await makeWiki({
      "AGENTS.md": "# Contract\n",
      "index.md": "See [[AGENTS]].\n",
    });

    const report = await checkWikiLinks(join(root, "wiki"));

    expect(report.broken).toEqual(["wiki/index.md:1 -> [[AGENTS]]"]);
  });

  it("rejects a wiki directory that does not exist", async () => {
    const root = await makeWiki({ "index.md": "# Home\n" });

    await expect(checkWikiLinks(join(root, "missing"))).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a wiki directory path that is a file", async () => {
    const root = await makeWiki({ "index.md": "# Home\n" });

    await expect(
      checkWikiLinks(join(root, "wiki", "index.md")),
    ).rejects.toThrow(
      `wiki directory is not a directory: ${join(root, "wiki", "index.md")}`,
    );
  });
});

describe("check-links CLI", () => {
  const paint = createColors(true);

  it("exits 0 with a green summary on a wiki tree where every link resolves", async () => {
    const root = await makeWiki({
      "index.md": "Start at [[vector-database]].\n",
      "concepts/vector-database.md": "# Vector Database\n",
    });

    const result = await runNode([join(root, "wiki")]);

    expect(`${result.code}: ${result.out}`).toBe(
      `0: ${paint.green("ok: 1 wikilink resolves across 2 pages")}\n`,
    );
  });

  it("exits 1 and prints the broken link on a wiki tree with a broken link", async () => {
    const root = await makeWiki({
      "index.md": "Intro line.\nBroken [[missing-page]] here.\n",
    });

    const result = await runNode([join(root, "wiki")]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red("wiki/index.md:2 -> [[missing-page]]")}\n`,
    );
  });

  it("exits 0 on the repository wiki with no arguments", async () => {
    const result = await runNode([]);

    expect(`${result.code}: ${result.out.startsWith("\u001b[32mok:")}`).toBe(
      "0: true",
    );
  });

  it("exits 1 with a clean message when the wiki directory does not exist", async () => {
    const root = await makeWiki({ "index.md": "# Home\n" });
    const missing = join(root, "missing");

    const result = await runNode([missing]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red(`check-links: wiki directory does not exist: ${missing}`)}\n`,
    );
  });

  it("exits 1 with a clean message when the wiki path is a file", async () => {
    const root = await makeWiki({ "index.md": "# Home\n" });
    const file = join(root, "wiki", "index.md");

    const result = await runNode([file]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red(`check-links: wiki directory is not a directory: ${file}`)}\n`,
    );
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: check-links \[-h \| --help\] \[<wiki-dir>\]/,
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runNode(["-h"])).out).toBe((await runNode(["--help"])).out);
  });

  it("documents the -h and --help switches themselves", async () => {
    expect((await runNode(["--help"])).out).toContain("-h, --help");
  });

  it("prints plain text when NO_COLOR is set", async () => {
    const root = await makeWiki({ "index.md": "Broken [[missing]].\n" });
    const realArgs = [realpathSync(script), join(root, "wiki")];
    const child = spawn(process.execPath, realArgs, {
      stdio: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    const err = await new Promise<string>((resolve, reject) => {
      let text = "";

      child.stderr.on("data", (chunk: Buffer) => {
        text += chunk;
      });
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });

    expect(err).toBe("wiki/index.md:1 -> [[missing]]\n");
  });

  it("prints help before validating the wiki path", async () => {
    const result = await runNode(["--help", "/no/such/wiki"]);

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("Usage: check-links");
  });
});
