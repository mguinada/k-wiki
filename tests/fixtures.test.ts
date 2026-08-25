import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureFilePaths,
  generateFixtureVault,
  main,
  VAULT_NAME,
} from "../src/fixtures/generate.ts";

const snapshotVaultRoot = fileURLToPath(
  new URL("./fixtures/Documents", import.meta.url),
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-fixtures-"));

  tempDirs.push(dir);

  return dir;
}

/** Generate a fresh fixture vault in a temp dir and return its root. */
async function newVault(): Promise<string> {
  return generateFixtureVault(await makeTempDir());
}

/**
 * Run the CLI main() with a stubbed argv and captured console output.
 * Restores argv, console, and exit code around the call.
 */
async function runCli(argv2: string | undefined): Promise<string> {
  const argv = process.argv;
  const output: string[] = [];

  process.exitCode = undefined;
  process.argv = [...argv.slice(0, 2), ...(argv2 === undefined ? [] : [argv2])];

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args) => output.push(args.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args) => output.push(args.join(" ")));

  try {
    await main();
  } finally {
    process.argv = argv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return output.join("\n");
}

afterEach(() => {
  process.exitCode = undefined;
});

async function readNote(vaultRoot: string, relPath: string): Promise<string> {
  return readFile(join(vaultRoot, ...relPath.split("/")), "utf8");
}

/** Recursively collect POSIX-style relative file paths under root. */
async function collectFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(join(root, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files.sort();
}

/** Map every file under root to its bytes, keyed by relative path. */
async function readTree(root: string): Promise<Record<string, Uint8Array>> {
  const tree: Record<string, Uint8Array> = {};

  for (const rel of await collectFiles(root)) {
    tree[rel] = await readFile(join(root, ...rel.split("/")));
  }

  return tree;
}

/**
 * Build a regex matching a note whose frontmatter block contains the
 * exact line.
 */
function frontmatterRegex(line: string): RegExp {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(
    `^---\\n(?:[^\\n]*\\n)*?${escaped}\\n(?:[^\\n]*\\n)*?---\\n`,
  );
}

/**
 * Assert a note opens with a frontmatter block that contains the exact
 * line, before the closing delimiter. One expectation: the whole note
 * text must match the frontmatter-with-line pattern.
 */
async function expectFrontmatterLine(
  vaultRoot: string,
  relPath: string,
  line: string,
): Promise<void> {
  expect(await readNote(vaultRoot, relPath)).toMatch(frontmatterRegex(line));
}

/** Collect the nesting depths of every note whose frontmatter has wiki: true. */
async function wikiTrueDepths(vaultRoot: string): Promise<Set<number>> {
  const selector = frontmatterRegex("wiki: true");
  const depths = new Set<number>();

  for (const rel of await collectFiles(vaultRoot)) {
    const note = await readNote(vaultRoot, rel);

    if (rel.endsWith(".md") && selector.test(note)) {
      depths.add(rel.split("/").length - 1);
    }
  }

  return depths;
}

describe("fixture vault generator", () => {
  it("writes the vault at <target>/Documents", async () => {
    const target = await makeTempDir();
    expect(await generateFixtureVault(target)).toBe(join(target, VAULT_NAME));
  });

  it("creates the vault root as a directory", async () => {
    expect((await stat(await newVault())).isDirectory()).toBe(true);
  });

  it("writes exactly the declared fixture file set to disk", async () => {
    expect(await collectFiles(await newVault())).toEqual(fixtureFilePaths());
  });

  it("declares the full case matrix of files", () => {
    expect(fixtureFilePaths()).toEqual([
      ".DS_Store",
      ".obsidian/app.json",
      ".trash/deleted.md",
      "AI/RAG.md",
      "AI/llms/attention-is-all-you-need.md",
      "AI/rag-evaluation-notes.md",
      "Inbox/clipped-note.md",
      "Inbox/parking-lot.md",
      "Inbox/quick-idea.md",
      "Projects/house-renovation.md",
      "Projects/private-clipped.md",
      "Scratch/temp-research.md",
    ]);
  });

  it("selects AI/RAG.md with wiki:true", async () => {
    await expectFrontmatterLine(await newVault(), "AI/RAG.md", "wiki: true");
  });

  it("selects AI/llms/attention-is-all-you-need.md with wiki:true", async () => {
    await expectFrontmatterLine(
      await newVault(),
      "AI/llms/attention-is-all-you-need.md",
      "wiki: true",
    );
  });

  it("selects wiki:true notes at more than one nesting depth", async () => {
    const depths = await wikiTrueDepths(await newVault());

    expect(depths.size).toBeGreaterThan(1);
  });

  it("seeds the hash-change case AI/rag-evaluation-notes.md with wiki:true", async () => {
    await expectFrontmatterLine(
      await newVault(),
      "AI/rag-evaluation-notes.md",
      "wiki: true",
    );
  });

  it("seeds the removal case Scratch/temp-research.md with wiki:true", async () => {
    await expectFrontmatterLine(
      await newVault(),
      "Scratch/temp-research.md",
      "wiki: true",
    );
  });

  it("blocks Projects/house-renovation.md with wiki:false", async () => {
    await expectFrontmatterLine(
      await newVault(),
      "Projects/house-renovation.md",
      "wiki: false",
    );
  });

  it("plants Inbox/parking-lot.md without any frontmatter", async () => {
    expect(
      await readNote(await newVault(), "Inbox/parking-lot.md"),
    ).not.toMatch(/^---/);
  });

  it("plants Inbox/quick-idea.md with a blank wiki flag", async () => {
    await expectFrontmatterLine(
      await newVault(),
      "Inbox/quick-idea.md",
      "wiki:",
    );
  });

  it('plants Inbox/clipped-note.md with a quoted wiki:"true" flag', async () => {
    await expectFrontmatterLine(
      await newVault(),
      "Inbox/clipped-note.md",
      'wiki: "true"',
    );
  });

  it('blocks Projects/private-clipped.md with a quoted wiki:"false" flag', async () => {
    await expectFrontmatterLine(
      await newVault(),
      "Projects/private-clipped.md",
      'wiki: "false"',
    );
  });

  it("plants parseable JSON settings at .obsidian/app.json", async () => {
    const appJson = JSON.parse(
      await readNote(await newVault(), ".obsidian/app.json"),
    );

    expect(appJson).toBeTypeOf("object");
  });

  it("plants a wiki:true note in .trash that sync must skip", async () => {
    await expectFrontmatterLine(
      await newVault(),
      ".trash/deleted.md",
      "wiki: true",
    );
  });

  it("plants a non-empty .DS_Store", async () => {
    const dsStore = await readFile(join(await newVault(), ".DS_Store"));

    expect(dsStore.length).toBeGreaterThan(0);
  });

  it("generates byte-identical trees on repeated runs", async () => {
    const first = await makeTempDir();
    const second = await makeTempDir();

    await generateFixtureVault(first);
    await generateFixtureVault(second);

    expect(await readTree(join(first, VAULT_NAME))).toEqual(
      await readTree(join(second, VAULT_NAME)),
    );
  });

  it("matches the committed snapshot under tests/fixtures", async () => {
    const target = await makeTempDir();

    await generateFixtureVault(target);

    expect(await readTree(join(target, VAULT_NAME))).toEqual(
      await readTree(snapshotVaultRoot),
    );
  });
});

describe("fixtures CLI help", () => {
  it("prints the usage line for --help", async () => {
    const out = await runCli("--help");

    expect(out).toContain("fixtures [-h | --help] <target-dir>");
  });

  it("prints the same help for -h as for --help", async () => {
    expect(await runCli("-h")).toBe(await runCli("--help"));
  });

  it("documents the -h and --help switches themselves", async () => {
    expect(await runCli("--help")).toContain("-h, --help");
  });

  it("explains what the target dir is for", async () => {
    expect(await runCli("--help")).toContain("<target-dir>");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli("--help");

    expect(process.exitCode).toBeUndefined();
  });

  it("writes no fixture vault for --help", async () => {
    const target = await makeTempDir();

    await runCli("--help");

    expect(await collectFiles(target)).toEqual([]);
  });
});

describe("fixture vault CLI", () => {
  it("exits with an error code when the target dir argument is missing", async () => {
    await runCli(undefined);

    expect(process.exitCode).toBe(1);
  });

  it("prints the usage message when the target dir argument is missing", async () => {
    expect(await runCli(undefined)).toContain(
      "Usage: npm run fixtures -- <target-dir>",
    );
  });

  it("writes the fixture vault when run with a target dir", async () => {
    const target = await makeTempDir();

    await runCli(target);

    expect(await collectFiles(join(target, VAULT_NAME))).toEqual(
      fixtureFilePaths(),
    );
  });

  it("prints the vault root when run with a target dir", async () => {
    const target = await makeTempDir();

    expect(await runCli(target)).toContain(
      `Fixture vault written to ${join(target, VAULT_NAME)}`,
    );
  });

  it("prints every fixture path before the vault root when run with a target dir", async () => {
    const target = await makeTempDir();
    const expected = [
      ...fixtureFilePaths().map((path) => `${VAULT_NAME}/${path}`),
      `Fixture vault written to ${join(target, VAULT_NAME)}`,
    ].join("\n");

    expect(await runCli(target)).toBe(expected);
  });
});
