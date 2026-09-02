import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFixtureVault,
  VAULT_NAME,
} from "../../src/fixtures/generate.ts";
// Static import for Stryker's vitest related mode: without it, this
// file never runs against sync-vault.ts mutants, because the staged
// copy it exercises is invisible to the module graph.
import { main as syncVaultMain } from "../../src/sync/sync-vault.ts";

void syncVaultMain;

/**
 * CLI entry-point tests. Two mechanisms, one goal: exercise the bin
 * launcher wiring and default-argument paths that in-process imports
 * never reach (issue #135: launchers are the only entry path).
 *
 * - Child-process runs verify the real CLI behavior end to end.
 * - In-process dynamic imports of a staged launcher verify them under
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
    const child = spawn(process.execPath, realArgs, {
      stdio: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

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

  // Resolve src/, bin/, and dev/ relative to this test file, not
  // process.cwd(): under Stryker the mutated sources live in the
  // sandbox next to the tests, while cwd still points at the original
  // repo root.
  const testsDir = dirname(fileURLToPath(import.meta.url));

  await cp(join(testsDir, "../../src"), join(dir, "src"), {
    recursive: true,
  });
  await cp(join(testsDir, "../../bin"), join(dir, "bin"), {
    recursive: true,
  });
  await cp(join(testsDir, "../../dev"), join(dir, "dev"), {
    recursive: true,
  });

  // The CLI imports runtime dependencies (picocolors); link the repo's
  // node_modules so the staged copy can resolve them.
  await symlink(
    join(testsDir, "../../node_modules"),
    join(dir, "node_modules"),
  );

  const vaultRoot = await generateFixtureVault(dir);

  await writeFile(
    join(dir, "sync.json"),
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, exclude: "wiki:false" }],
    }),
  );

  return dir;
}

/**
 * A staged copy of src/, bin/, and dev/ inside the test tree,
 * importable in-process. Returns the staged repo root (holds
 * sync.json, src/, bin/, and dev/).
 */
async function stageRepo(): Promise<string> {
  const dir = join(stagingRoot, randomUUID());
  const testsDir = dirname(fileURLToPath(import.meta.url));

  await mkdir(join(dir, "raw"), { recursive: true });
  await cp(join(testsDir, "../../src"), join(dir, "src"), { recursive: true });
  await cp(join(testsDir, "../../bin"), join(dir, "bin"), { recursive: true });
  await cp(join(testsDir, "../../dev"), join(dir, "dev"), { recursive: true });

  const vaultRoot = await generateFixtureVault(join(dir, "vault"));

  await writeFile(
    join(dir, "sync.json"),
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, exclude: "wiki:false" }],
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

    const result = await runNode([join(dir, "dev", "generate.ts")]);

    expect({ code: result.code, err: result.err }).toMatchObject({
      code: 1,
      err: expect.stringMatching(/Usage/),
    });
  });

  it("writes the fixture vault when a target directory is given", async () => {
    const dir = await makeTmpRepo();
    const target = join(dir, "target");

    const result = await runNode([join(dir, "dev", "generate.ts"), target]);

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

  it("runs main when imported through its dev launcher, with the given target", async () => {
    const repo = await stageRepo();
    const launcherPath = join(repo, "dev", "generate.ts");
    const target = join(repo, "target");

    const { out } = await importWithArgv(launcherPath, launcherPath, [target]);

    expect(out).toContain(
      `Fixture vault written to ${join(target, VAULT_NAME)}`,
    );
  });

  it("runs nothing when imported as a module with a foreign argv[1], even with a target given", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "fixtures", "generate.ts");
    const target = join(repo, "target");

    const { out, err } = await importWithArgv(
      modulePath,
      join(repo, "other.js"),
      [target],
    );

    expect({ out, err }).toEqual({ out: "", err: "" });
  });
});

/**
 * Read the projected note; on failure, embed the child's exit code,
 * stdout, and stderr instead of letting stat throw a bare ENOENT
 * (issue #44: a failed child surfaced as an undiagnosable ENOENT).
 */
async function noteMarker(rawDir: string, result: RunResult): Promise<string> {
  return stat(join(rawDir, "notes", VAULT_NAME, "AI", "RAG.md")).then(
    (info) => (info.isFile() ? "true" : "false"),
    () =>
      `stat failed; child exit ${result.code}, stdout: ${JSON.stringify(result.out)}, stderr: ${JSON.stringify(result.err)}`,
  );
}

describe("sync-vault CLI", () => {
  it("projects the fixture vault with its default arguments", async () => {
    const dir = await makeTmpRepo();

    const result = await runNode([join(dir, "bin", "sync-vault.ts")]);

    const note = await noteMarker(join(dir, "raw"), result);

    expect(`${result.code}${result.out.includes("sync complete")}${note}`).toBe(
      "0truetrue",
    );
  });

  it("projects the fixture vault into the data root when sync.json sets dataRoot", async () => {
    const dir = await makeTmpRepo();

    await writeFile(
      join(dir, "sync.json"),
      JSON.stringify({
        dataRoot: join(dir, "k-wiki-data"),
        vaults: [
          {
            name: VAULT_NAME,
            root: join(dir, VAULT_NAME),
            exclude: "wiki:false",
          },
        ],
      }),
    );

    const result = await runNode([join(dir, "bin", "sync-vault.ts")]);

    const note = await noteMarker(join(dir, "k-wiki-data", "raw"), result);

    expect(`${result.code}${result.out.includes("sync complete")}${note}`).toBe(
      "0truetrue",
    );
  });

  it("does nothing when imported as a module", async () => {
    const dir = await makeTmpRepo();

    const result = await runNode(
      importScript(join(dir, "src", "sync", "sync-vault.ts")),
    );

    expect(`${result.code}${result.out}${result.err}`).toBe("0");
  });

  it("runs main with the default config and raw paths when imported through its bin launcher", async () => {
    const repo = await stageRepo();
    const launcherPath = join(repo, "bin", "sync-vault.ts");

    const { out } = await importWithArgv(launcherPath, launcherPath, []);

    const noteStat = await stat(
      join(repo, "raw", "notes", VAULT_NAME, "AI", "RAG.md"),
    );

    expect(
      `${out.includes("sync complete: 7 copied")}${noteStat.isFile()}`,
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
