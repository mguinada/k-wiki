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

  // Task runners (firstmate worktrees) inject a scoped core.hooksPath
  // through the GIT_CONFIG_COUNT/KEY_n/VALUE_n mechanism; every child
  // here must see stock git, so the injection never crosses the spawn
  // boundary unless a test passes its own env explicitly.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
      delete env[key];
    }
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

/** The recording prelude every wiring-recording stub agent embeds
 *  (issue #434): one JSON line per invocation — the child argv, the
 *  stdin content (empty: the wrapper closes stdin), a secret-safe
 *  env projection (values only for the pipeline's own keys, names
 *  only for everything else), and the spawn cwd — appended to
 *  <cwd>/outputs/agent-recordings.jsonl. Embed at the top of a stub
 *  source, right after the shebang; the imports are namespaced so
 *  embedders keep their own. */
export const STUB_RECORD_PRELUDE = `import { appendFile as __appendFile, mkdir as __mkdir } from "node:fs/promises";
await __mkdir("outputs", { recursive: true });
const __stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", () => resolve(data));
});
const __safe = /^(NO_COLOR|PI_CODING_AGENT_DIR|KWIKI_[A-Z0-9_]+|HOME|PATH|PWD|TMPDIR|SHELL|USER|LANG|LC_ALL)$/;
const __env = {};
const __envPresent = {};
for (const [key, value] of Object.entries(process.env)) {
  if (__safe.test(key)) __env[key] = value ?? "";
  else __envPresent[key] = true;
}
await __appendFile(
  "outputs/agent-recordings.jsonl",
  JSON.stringify({
    argv: process.argv.slice(2),
    stdin: __stdin,
    env: __env,
    envPresentKeys: Object.keys(__envPresent).sort(),
    cwd: process.cwd(),
  }) + "\\n",
);
`;

/** One recorded stub-agent invocation (issue #434): the wiring the
 *  pipeline handed the child, per run. */
export interface AgentRecording {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly envPresentKeys: readonly string[];
  readonly cwd: string;
}

/** Parse the recordings the stub agents appended under <dir>/outputs. */
export async function readAgentRecordings(
  dir: string,
): Promise<AgentRecording[]> {
  const text = await readFile(
    join(dir, "outputs", "agent-recordings.jsonl"),
    "utf8",
  );

  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as AgentRecording);
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
  /** The full audit's own `-full` report path. */
  readonly fullReportPath: string;
}

/** A temp data repo (git, wiki/, raw/manifest.json) hosting a stub
 *  agent: writes the stub script, derives its settings file, and
 *  commits the skeleton. The caller owns the tmp dir's cleanup. */
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
  // The per-instance ignore entries a real data repo carries after
  // its first run, so clean-tree assertions survive the stages'
  // gitignore hygiene (issue #112). The lint-window snapshot's
  // entries live in .git/info/exclude, re-applied by every run.
  await writeFile(
    join(dataRoot, ".gitignore"),
    "outputs/last-ingested-manifest.json\n",
  );

  const date = new Date().toISOString().slice(0, 10);
  const reportPath = `outputs/lint-${date}.md`;
  const fullReportPath = `outputs/lint-${date}-full.md`;

  await writeFile(join(dataRoot, "stub-agent.mjs"), options.stubAgent, {
    mode: 0o755,
  });

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
    fullReportPath,
  };
}
