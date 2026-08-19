import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { generateFixtureVault, VAULT_NAME } from "../src/fixtures/generate.ts";
// Static import for Stryker's vitest related mode: without it, this
// file never runs against sync-vault.ts mutants, because the staged
// copy it exercises is invisible to the module graph.
import { main as syncVaultMain } from "../src/sync/sync-vault.ts";

void syncVaultMain;

/**
 * CLI entry-point tests. Two mechanisms, one goal: exercise the import
 * guards and default-argument paths that in-process imports never reach.
 *
 * - Child-process runs verify the real CLI behavior end to end.
 * - In-process dynamic imports of a staged copy verify them under
 *   Stryker: the staged file is the instrumented one, and a dynamic
 *   import executes it in this process, where the active-mutant
 *   globals live — unlike a child process, which runs instrumented
 *   code with no active mutant.
 *
 * Every run resolves against synthetic data only (fixture vault in a
 * temp repo); a bare default invocation must never touch the
 * repository's real sync.json and vault (log hygiene).
 */

const tempDirs: string[] = [];

const stagingRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  ".cli-import-staging",
);

tempDirs.push(stagingRoot);

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
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

function importScript(file: string): string[] {
  return ["-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`];
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

/**
 * A staged copy of src/ inside the test tree, importable in-process.
 * Returns the staged repo root (holds sync.json and src/).
 */
async function stageRepo(): Promise<string> {
  const dir = join(stagingRoot, randomUUID());

  await mkdir(join(dir, "raw"), { recursive: true });
  await cp(
    join(dirname(fileURLToPath(import.meta.url)), "../src"),
    join(dir, "src"),
    { recursive: true },
  );

  const vaultRoot = await generateFixtureVault(join(dir, "vault"));

  await writeFile(
    join(dir, "sync.json"),
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, select: "wiki:true" }],
    }),
  );

  return dir;
}

interface ImportOutcome {
  readonly out: string;
  readonly err: string;
}

/** Import the staged module with a controlled argv; capture console. */
async function importWithArgv(
  modulePath: string,
  argv1: string | undefined,
  args: readonly string[],
): Promise<ImportOutcome> {
  const argv = process.argv;
  const out: string[] = [];
  const err: string[] = [];

  const argv1OrNull = argv1 === undefined ? null : argv1;

  process.argv = [argv[0] ?? "node", argv1OrNull, ...args].filter(
    (part): part is string => part !== null,
  );

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await import(pathToFileURL(modulePath).href);
  } finally {
    process.argv = argv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join("\n"), err: err.join("\n") };
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

  it("runs main when argv[1] is the module itself, with the given target", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "fixtures", "generate.ts");
    const target = join(repo, "target");

    const { out } = await importWithArgv(modulePath, modulePath, [target]);

    expect(out).toContain(
      `Fixture vault written to ${join(target, VAULT_NAME)}`,
    );
  });

  it("runs nothing when argv[1] is a different module, even with a target given", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "fixtures", "generate.ts");
    const target = join(repo, "target");

    const { out, err } = await importWithArgv(
      modulePath,
      join(repo, "other.js"),
      [target],
    );

    expect(out).toBe("");
    expect(err).toBe("");
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

  it("projects the fixture vault into the data root when sync.json sets dataRoot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-cli-"));

    tempDirs.push(dir);

    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

    await cp(srcDir, join(dir, "src"), { recursive: true });

    const vaultRoot = await generateFixtureVault(dir);

    await writeFile(
      join(dir, "sync.json"),
      JSON.stringify({
        dataRoot: join(dir, "k-wiki-data"),
        vaults: [{ name: VAULT_NAME, root: vaultRoot, select: "wiki:true" }],
      }),
    );

    const result = await runNode([join(dir, "src", "sync", "sync-vault.ts")]);

    const noteStat = await stat(
      join(dir, "k-wiki-data", "raw", "notes", VAULT_NAME, "AI", "RAG.md"),
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

  it("runs main with the default config and raw paths when argv[1] is the module itself", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "sync", "sync-vault.ts");

    const { out } = await importWithArgv(modulePath, modulePath, []);

    const noteStat = await stat(
      join(repo, "raw", "notes", VAULT_NAME, "AI", "RAG.md"),
    );

    expect(
      `${out.includes("sync complete: 4 copied")}${noteStat.isFile()}`,
    ).toBe("truetrue");
  });
  it("runs nothing when argv[1] is undefined", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "sync", "sync-vault.ts");

    const { out, err } = await importWithArgv(modulePath, undefined, []);

    expect(`${out}${err}`).toBe("");
  });

  it("stays silent when argv[1] is a different module, even with CLI args given", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "sync", "sync-vault.ts");

    const { out, err } = await importWithArgv(
      modulePath,
      join(repo, "other.js"),
      [join(repo, "sync.json"), join(repo, "raw-untouched")],
    );

    expect(`${out}${err}`).toBe("");
  });

  it("leaves the raw directory untouched when argv[1] is a different module, even with CLI args given", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "sync", "sync-vault.ts");
    const rawDir = join(repo, "raw-untouched");

    await importWithArgv(modulePath, join(repo, "other.js"), [
      join(repo, "sync.json"),
      rawDir,
    ]);

    await expect(stat(rawDir)).rejects.toThrow();
  });
});
