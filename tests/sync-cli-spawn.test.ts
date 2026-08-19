import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateFixtureVault, VAULT_NAME } from "../src/fixtures/generate.ts";

/**
 * Child-process tests for the CLI entry points. The import guards and
 * the argument-default paths are observable only in a fresh `node`
 * process, never through in-process imports. Each test copies `src/`
 * into a temp repo so the guards resolve against synthetic data only —
 * a bare default invocation must never touch the repository's real
 * `sync.json` and vault (log hygiene).
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(args: readonly string[]): Promise<RunResult> {
  // argv[1] must be the real path: import.meta.url is realpath'd by
  // Node, and a symlinked spawn path (macOS tmp) would make the CLI
  // import guards compare unequal and skip main().
  const first = args[0] ?? "";

  const realArgs = first.startsWith("-")
    ? args
    : [realpathSync(first), ...args.slice(1)];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, realArgs, { stdio: "pipe" });

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

/** A temp copy of src/ with a fixture sync.json at its root. */
async function makeTmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-cli-"));

  tempDirs.push(dir);

  // Resolve src/ relative to this test file, not process.cwd(): under
  // Stryker the mutated sources live in the sandbox next to the tests,
  // while cwd still points at the original repo root.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

  await cp(srcDir, join(dir, "src"), {
    recursive: true,
  });

  const vaultRoot = await generateFixtureVault(dir);

  await writeFile(
    join(dir, "sync.json"),
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, select: "wiki:true" }],
    }),
  );

  return dir;
}

function importScript(file: string): string[] {
  return ["-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`];
}

describe("generate CLI", () => {
  it("exits with a usage error when no target directory is given", async () => {
    const dir = await makeTmpRepo();

    const result = await runNode([join(dir, "src", "fixtures", "generate.ts")]);

    expect({ code: result.code, err: result.err }).toMatchObject({
      code: 1,
      err: expect.stringMatching(/Usage/),
    });
  });

  it("writes the fixture vault when a target directory is given", async () => {
    const dir = await makeTmpRepo();
    const target = join(dir, "target");

    const result = await runNode([
      join(dir, "src", "fixtures", "generate.ts"),
      target,
    ]);

    expect({ code: result.code, out: result.out }).toMatchObject({
      code: 0,
      out: expect.stringMatching(/Fixture vault written to/),
    });
  });

  it("does nothing when imported as a module", async () => {
    const dir = await makeTmpRepo();

    const result = await runNode(
      importScript(join(dir, "src", "fixtures", "generate.ts")),
    );

    expect(`${result.code}${result.out}${result.err}`).toBe("0");
  });
});

describe("sync-vault CLI", () => {
  it("projects the fixture vault with its default arguments", async () => {
    const dir = await makeTmpRepo();

    const result = await runNode([join(dir, "src", "sync", "sync-vault.ts")]);

    const noteStat = await stat(
      join(dir, "raw", "notes", VAULT_NAME, "AI", "RAG.md"),
    );

    expect(
      `${result.code}${result.out.includes("sync complete")}${noteStat.isFile()}`,
    ).toBe("0truetrue");
  });

  it("does nothing when imported as a module", async () => {
    const dir = await makeTmpRepo();

    const result = await runNode(
      importScript(join(dir, "src", "sync", "sync-vault.ts")),
    );

    expect(`${result.code}${result.out}${result.err}`).toBe("0");
  });
});
