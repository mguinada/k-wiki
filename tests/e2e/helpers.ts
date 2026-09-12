import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  generateFixtureVault,
  vaultName,
} from "../../src/fixtures/generate.ts";

/**
 * Shared e2e infrastructure. Sync and health scratch workspaces live
 * under `.e2e-tmp/<unique>/` at the repo root (gitignored; project-root
 * paths dodge the macOS `/var/folders` symlink trap); the wiki-ingest
 * suite builds its own temp data repos under the system tmpdir. Every
 * CLI run passes explicit arguments — a bare CLI run would use the
 * repo's real `sync.json`, `settings.yml`, and vault root (log
 * hygiene).
 */

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const SYNC_SCRIPT = join(repoRoot, "bin", "sync-vault");
export const HEALTH_SCRIPT = join(repoRoot, "bin", "libexec", "check-raw");
export const INGEST_SCRIPT = join(repoRoot, "bin", "wiki-ingest");
export const SYNC_CYCLE_SCRIPT = join(repoRoot, "bin", "wiki-sync");
export const QUERY_SCRIPT = join(repoRoot, "bin", "wiki-query");
export const K_WIKI_SCRIPT = join(repoRoot, "bin", "k-wiki");

/** The fixture vault's notes ingested under `exclude: "wiki:false"`, sorted. */
export const SELECTED_PATHS = [
  "AI/RAG.md",
  "AI/llms/attention-is-all-you-need.md",
  "AI/rag-evaluation-notes.md",
  "Inbox/clipped-note.md",
  "Inbox/parking-lot.md",
  "Inbox/quick-idea.md",
  "Scratch/temp-research.md",
];

export interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/**
 * Run a repo CLI as a real child process through its bin/ launcher
 * (the only entry path, issue #135). Children run with `NO_COLOR=1`
 * so byte-exact output assertions stay plain; pass `{ color: true }`
 * to drop it, `env` to expose more variables to the child, or `cwd`
 * to run it from another directory (default: this process's cwd).
 */
export function runCli(
  script: string,
  args: readonly string[],
  options: {
    color?: boolean;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    input?: string;
  } = {},
): Promise<CliResult> {
  const realScript = realpathSync(script);
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };

  if (options.color) {
    delete env.NO_COLOR;
  }

  Object.assign(env, options.env);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [realScript, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: options.cwd,
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

    // EOF for CLIs that read stdin; a harmless no-op for the rest.
    child.stdin.end(options.input);
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
      vaults: [{ name: vaultName(), root: vaultRoot, exclude: "wiki:false" }],
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
export const SYNC_REPO_SCRIPT = join(repoRoot, "bin", "sync-repo");

const run = promisify(execFile);

export interface StubDataRepo {
  readonly tmp: string;
  readonly dataRoot: string;
  readonly rawDir: string;
  readonly settingsPath: string;
  /** Repo-relative dated report path the stub agent writes. */
  readonly reportPath: string;
}

/** A temp data repo (git, wiki/, raw/manifest.json) hosting a stub
 *  agent: writes the stub script (its `process.env.LINT_REPORT`
 *  placeholder bound to the dated report path), derives its settings
 *  file, and commits the skeleton. The caller owns the tmp dir's
 *  cleanup. */
export async function makeStubDataRepo(options: {
  readonly stubAgent: string;
  readonly prefix: string;
  readonly model: string;
}): Promise<StubDataRepo> {
  const tmp = await mkdtemp(join(tmpdir(), options.prefix));
  const dataRoot = join(tmp, "data");

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

  const reportPath = `outputs/lint-${new Date().toISOString().slice(0, 10)}.md`;

  await writeFile(
    join(dataRoot, "stub-agent.mjs"),
    options.stubAgent.replaceAll(
      "process.env.LINT_REPORT",
      JSON.stringify(reportPath),
    ),
    { mode: 0o755 },
  );

  const settingsPath = join(tmp, "settings.yml");

  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: ${options.model}\nreasoning: low\n`,
  );
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });

  return {
    tmp,
    dataRoot,
    rawDir: join(dataRoot, "raw"),
    settingsPath,
    reportPath,
  };
}
