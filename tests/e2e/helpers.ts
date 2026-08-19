import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateFixtureVault,
  VAULT_NAME,
} from "../../src/fixtures/generate.ts";

/**
 * Shared e2e infrastructure. Every scratch artifact lives under
 * `.e2e-tmp/<unique>/` at the repo root (gitignored; project-root
 * paths dodge the macOS `/var/folders` symlink trap), and every CLI
 * run passes explicit `<config> <raw>` arguments — a bare CLI run
 * would use the repo's real `sync.json` and vault root (log hygiene).
 */

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const SYNC_SCRIPT = join(repoRoot, "src", "sync", "sync-vault.ts");
export const HEALTH_SCRIPT = join(repoRoot, "src", "health", "check-raw.ts");

/** The fixture vault's `wiki: true` notes, sorted. */
export const SELECTED_PATHS = [
  "AI/RAG.md",
  "AI/llms/attention-is-all-you-need.md",
  "AI/rag-evaluation-notes.md",
  "Scratch/temp-research.md",
];

export interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/**
 * Run a repo CLI as a real child process. `argv[1]` must be the real
 * path: `import.meta.url` is realpath'd by Node, and a symlinked spawn
 * path would make the CLI import guards compare unequal and skip
 * `main()`.
 */
export function runCli(
  script: string,
  args: readonly string[],
): Promise<CliResult> {
  const realScript = realpathSync(script);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [realScript, ...args], {
      stdio: "pipe",
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

export interface Workspace {
  readonly dir: string;
  readonly vaultRoot: string;
  readonly configPath: string;
  readonly rawDir: string;
}

const workspaces: string[] = [];

/** A scratch workspace: fixture vault, single-vault sync.json, raw dir. */
export async function buildWorkspace(): Promise<Workspace> {
  const dir = join(repoRoot, ".e2e-tmp", randomUUID());
  const vaultRoot = await generateFixtureVault(dir);
  const configPath = join(dir, "sync.json");
  const rawDir = join(dir, "raw");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, select: "wiki:true" }],
    }),
  );

  workspaces.push(dir);

  return { dir, vaultRoot, configPath, rawDir };
}

/** Remove every workspace this test file created; call from afterAll. */
export async function cleanupWorkspaces(): Promise<void> {
  await Promise.all(
    workspaces.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** The sha-256 hex digest of the file at `path`. */
export async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Recursively collect POSIX-style relative file paths under root. */
export async function collectFiles(
  root: string,
  prefix = "",
): Promise<string[]> {
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
