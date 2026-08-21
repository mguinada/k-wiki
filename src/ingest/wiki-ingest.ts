import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../cli/is-main.ts";
import { createProgressRenderer, formatDuration } from "../cli/progress.ts";
import { runGit } from "../data/init-data-repo.ts";
import { loadSyncConfig, resolveRawDir } from "../sync/config.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  readManifestText,
  type VaultNotes,
  writeManifest,
} from "../sync/manifest.ts";

/**
 * wiki-ingest: the headless wiki agent run (guide §18, issue #11). It
 * diffs `raw/manifest.json` against the snapshot from the previous
 * successful run, picks `prompts/ingest.md` (first run) or
 * `prompts/incremental.md` (with the changed sources appended), invokes
 * the agent CLI non-interactively in the data repo root, and writes a
 * digest the human can review in under a minute. Guardrails (checks,
 * auto-revert) are issue #12; scheduling is #14.
 */

export interface AgentSettings {
  /** Agent CLI command; run non-interactively in the data repo root. */
  readonly command: string;
  /** Passed to the agent as `--model`. */
  readonly model: string;
  /** Reasoning level; passed to the agent as `--thinking`. */
  readonly reasoning: string;
}

const SETTING_KEYS = ["command", "model", "reasoning"] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

function unquote(value: string): string {
  const quote = value[0];

  return quote === '"' || quote === "'"
    ? value.slice(1, value.length - 1)
    : value;
}

/**
 * Parse the settings file: a YAML subset of top-level `key: value`
 * scalars, `#` comments on their own line or trailing the value, and
 * optionally quoted values. Anything else (nesting, lists) is rejected
 * so a typo cannot silently change the agent configuration.
 */
export function parseSettings(text: string, origin: string): AgentSettings {
  const values = new Map<SettingKey, string>();

  for (const rawLine of text.split("\n")) {
    if (/^\s/.test(rawLine)) {
      const indented = rawLine.trim();

      if (indented !== "" && !indented.startsWith("#")) {
        throw new Error(
          `invalid agent settings at ${origin}: nested values are not supported`,
        );
      }

      continue;
    }

    const line = rawLine.replace(/\s+#.*$/, "").trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf(":");

    if (separator < 1) {
      throw new Error(
        `invalid agent settings at ${origin}: expected \`key: value\`, got ${JSON.stringify(line)}`,
      );
    }

    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());

    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `invalid agent settings at ${origin}: unknown setting ${JSON.stringify(key)}`,
      );
    }

    if (values.has(key as SettingKey)) {
      throw new Error(
        `invalid agent settings at ${origin}: duplicate setting ${JSON.stringify(key)}`,
      );
    }

    if (value === "") {
      throw new Error(
        `invalid agent settings at ${origin}: setting ${JSON.stringify(key)} needs a value`,
      );
    }

    values.set(key as SettingKey, value);
  }

  for (const key of SETTING_KEYS) {
    if (!values.has(key)) {
      throw new Error(
        `invalid agent settings at ${origin}: missing setting ${JSON.stringify(key)}`,
      );
    }
  }

  return {
    command: values.get("command") ?? "",
    model: values.get("model") ?? "",
    reasoning: values.get("reasoning") ?? "",
  };
}

/** Read and parse the agent settings file; missing values are errors. */
export async function loadAgentSettings(path: string): Promise<AgentSettings> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read agent settings at ${path}`, { cause });
  }

  return parseSettings(text, path);
}

/** One vault's source changes between two manifests. */
export interface VaultSourceChange {
  readonly vault: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

export interface ManifestDiff {
  /** Only vaults with at least one change, sorted by vault name. */
  readonly vaults: readonly VaultSourceChange[];
  readonly empty: boolean;
}

/** Diff two manifests by note path and hash; vaults sort by name. */
export function diffManifests(
  previous: Manifest,
  current: Manifest,
): ManifestDiff {
  const names = [
    ...new Set([
      ...Object.keys(previous.vaults),
      ...Object.keys(current.vaults),
    ]),
  ].sort();
  const vaults = names
    .map((name) => {
      const before: VaultNotes = previous.vaults[name] ?? {};
      const after: VaultNotes = current.vaults[name] ?? {};

      const added = Object.keys(after)
        .filter((path) => before[path] === undefined)
        .sort();
      const changed = Object.keys(after)
        .filter((path) => {
          const prior = before[path];
          const next = after[path];

          return prior !== undefined && next !== undefined
            ? prior.hash !== next.hash
            : false;
        })
        .sort();
      const removed = Object.keys(before)
        .filter((path) => after[path] === undefined)
        .sort();

      return { vault: name, added, changed, removed };
    })
    .filter(
      (vault) =>
        vault.added.length + vault.changed.length + vault.removed.length > 0,
    );

  return { vaults, empty: vaults.length === 0 };
}

/**
 * Compose the agent message: the prompt file text, plus the explicit
 * changed-source list for an incremental run (the prompt restricts the
 * agent to those files). A full ingest gets the prompt unmodified.
 */
export function composePrompt(
  promptText: string,
  diff: ManifestDiff | undefined,
): string {
  if (diff === undefined) {
    return promptText;
  }

  const lines = [
    promptText,
    "",
    "Changed sources since the previous ingestion:",
    "",
  ];

  for (const vault of diff.vaults) {
    for (const path of vault.added) {
      lines.push(`+ ${vault.vault}/${path}`);
    }

    for (const path of vault.changed) {
      lines.push(`~ ${vault.vault}/${path}`);
    }

    for (const path of vault.removed) {
      lines.push(`- ${vault.vault}/${path}`);
    }
  }

  return lines.join("\n");
}

/** Wiki page changes, read from the data repo's git status. */
export interface WikiPages {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  /** Set when git could not report; the run itself still succeeded. */
  readonly unavailable: string | undefined;
}

/** One completed run, everything the digest reports. */
export interface IngestRun {
  readonly startedAt: Date;
  readonly mode: "full" | "incremental";
  readonly promptFile: string;
  readonly settings: AgentSettings;
  readonly diff: ManifestDiff;
  readonly pages: WikiPages;
  readonly agentOutput: string;
}

function sourceCount(
  diff: ManifestDiff,
  key: "added" | "changed" | "removed",
): number {
  return diff.vaults.reduce((total, vault) => total + vault[key].length, 0);
}

/** Render the per-run digest markdown: counts first, details after. */
export function formatDigest(run: IngestRun): string {
  const { settings } = run;
  const lines: string[] = [
    `# Wiki ingest digest — ${run.startedAt.toISOString()}`,
    "",
    `- **Agent:** \`${settings.command}\` · model \`${settings.model}\` · reasoning \`${settings.reasoning}\``,
    `- **Mode:** ${run.mode} · prompt \`${run.promptFile}\``,
    `- **Sources:** ${sourceCount(run.diff, "added")} added, ${sourceCount(run.diff, "changed")} changed, ${sourceCount(run.diff, "removed")} removed`,
  ];

  if (run.pages.unavailable === undefined) {
    lines.push(
      `- **Wiki pages:** ${run.pages.created.length} created, ${run.pages.updated.length} updated`,
    );
  } else {
    lines.push(`- **Wiki pages:** unavailable — ${run.pages.unavailable}`);
  }

  lines.push(
    "- **Contradictions and unresolved questions:** in the agent report below",
  );

  if (run.mode === "incremental") {
    lines.push("", "## Changed sources", "");

    for (const vault of run.diff.vaults) {
      lines.push(`**${vault.vault}**`);

      for (const path of vault.added) {
        lines.push(`- + ${vault.vault}/${path}`);
      }

      for (const path of vault.changed) {
        lines.push(`~ ${vault.vault}/${path}`);
      }

      for (const path of vault.removed) {
        lines.push(`- − ${vault.vault}/${path}`);
      }
    }
  }

  lines.push("", "## Wiki pages (git diff)", "");

  if (run.pages.unavailable !== undefined) {
    lines.push(`unavailable: ${run.pages.unavailable}`);
  } else {
    lines.push("Created:");

    for (const path of run.pages.created) {
      lines.push(`- ${path}`);
    }

    lines.push("", "Updated:");

    for (const path of run.pages.updated) {
      lines.push(`- ${path}`);
    }
  }

  lines.push("", "## Agent report", "", run.agentOutput);

  return `${lines.join("\n")}\n`;
}

/** How the agent is invoked; injectable for tests. */
export type AgentRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number | undefined;
  },
) => Promise<{ stdout: string; stderr: string }>;

/** The agent gets 30 minutes by default; a hung run must not hang the wrapper. */
export const AGENT_TIMEOUT_MS = 30 * 60_000;

/** Liveness line on the progress sink while the agent runs. */
export const HEARTBEAT_MS = 60_000;

/** Prefix of the agent heartbeat sentence; the TTY renderer keeps the
 *  matching messages on one animated line (spinner + clock). */
export const AGENT_HEARTBEAT_PREFIX = "wiki-ingest: agent still running";

/** Collected output cap: 16 MB, far above any final agent report. */
const AGENT_MAX_BUFFER = 16 * 1024 * 1024;

/** The last 500 characters of a buffer — where the failure lands. */
function tail(text: string): string {
  return text.slice(-500).trim();
}

/**
 * Run the agent CLI non-interactively, capturing its final output.
 * stdin is closed ("ignore"): an open pipe never reaching EOF makes
 * the agent wait on stdin forever — verified against pi 0.84.2, whose
 * `-p` mode reads stdin even when the prompt arrives via `--print`.
 * A run exceeding AGENT_TIMEOUT_MS is killed and reported as failed.
 */
export function spawnAgent(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number | undefined;
  },
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const seconds = Math.ceil(timeoutMs / 1000);

      reject(
        new Error(
          `agent ${command} timed out after ${seconds} second${seconds === 1 ? "" : "s"}`,
        ),
      );
    }, timeoutMs);

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > AGENT_MAX_BUFFER) {
        child.kill("SIGKILL");

        return;
      }

      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`agent ${command} could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const out = Buffer.concat(stdout).toString("utf8");
      const errText = Buffer.concat(stderr).toString("utf8");

      if (code === 0) {
        resolve({ stdout: out, stderr: errText });

        return;
      }

      const why =
        signal !== null
          ? `killed with ${signal} (output over ${AGENT_MAX_BUFFER} bytes, or wrapper shutdown)`
          : `exited with code ${code}`;

      reject(new Error(`agent ${why}: ${tail(errText)}`));
    });
  });
}

/**
 * Wiki pages created and updated by the run, from the data repo's git
 * status: untracked or added paths count as created, modified paths as
 * updated. When git cannot report, the digest says so instead of
 * failing a run that did update the wiki.
 */
async function wikiPages(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<WikiPages> {
  let stdout: string;

  try {
    ({ stdout } = await runGit(
      dataRoot,
      ["status", "--porcelain", "-uall", "--", "wiki"],
      env,
    ));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    return { created: [], updated: [], unavailable: reason };
  }

  const created: string[] = [];
  const updated: string[] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }

    const code = line.slice(0, 2);
    const path = line.slice(3);

    if (code.includes("A") || code.includes("?")) {
      created.push(path);
    } else if (code.includes("M")) {
      updated.push(path);
    }
  }

  return {
    created: created.sort(),
    updated: updated.sort(),
    unavailable: undefined,
  };
}

export interface IngestOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The raw dir holding manifest.json; its parent is the data repo. */
  readonly rawDir: string;
  /** Digest and snapshot destination (the repo's outputs/). */
  readonly outputsDir: string;
  /** Directory holding ingest.md and incremental.md. */
  readonly promptsDir: string;
  /** Environment for child processes; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock for the digest timestamp; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Agent runner; defaults to the real non-interactive invocation. */
  readonly runAgent?: AgentRunner;
  /** Kill the agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while the agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

export type IngestResult =
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "ran";
      readonly mode: "full" | "incremental";
      readonly digestPath: string;
      readonly digest: string;
      readonly pages: WikiPages;
    };

async function readPrompt(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read prompt at ${path}`, { cause });
  }
}

/**
 * One headless ingest run. The snapshot is written only after a
 * successful agent run, so a failure retries the same sources next
 * time instead of silently skipping them.
 */
export async function runWikiIngest(
  options: IngestOptions,
): Promise<IngestResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress ?? (() => {});
  const settings = await loadAgentSettings(options.settingsPath);

  onProgress(`wiki-ingest: raw dir ${options.rawDir}`);

  const manifestPath = join(options.rawDir, "manifest.json");
  const manifestText = await readManifestText(manifestPath);

  if (manifestText === undefined) {
    throw new Error(`no manifest at ${manifestPath}: run sync-vault first`);
  }

  const current = parseManifest(manifestText, manifestPath);
  const snapshotPath = join(options.outputsDir, "last-ingested-manifest.json");
  const snapshotText = await readManifestText(snapshotPath);
  const previous =
    snapshotText === undefined
      ? undefined
      : parseManifest(snapshotText, snapshotPath);
  const diff = diffManifests(previous ?? emptyManifest(), current);

  if (diff.empty) {
    const reason = "no changed sources since the last ingest; nothing to do";

    onProgress(reason);

    return { status: "skipped", reason };
  }

  const mode = previous === undefined ? "full" : "incremental";
  const promptFile = mode === "full" ? "ingest.md" : "incremental.md";
  const promptText = await readPrompt(join(options.promptsDir, promptFile));
  const composed = composePrompt(
    promptText,
    mode === "incremental" ? diff : undefined,
  );

  const args = [
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    composed,
  ];
  const dataRoot = dirname(options.rawDir);
  const runAgent = options.runAgent ?? spawnAgent;

  onProgress(
    `wiki-ingest: mode ${mode}, invoking agent: ${settings.command} --model ${settings.model} --thinking ${settings.reasoning}`,
  );

  const agentStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = formatDuration(Date.now() - agentStartedAt);

    onProgress(`${AGENT_HEARTBEAT_PREFIX} (${elapsed})`);
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  let stdout: string;

  try {
    ({ stdout } = await runAgent(settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs: options.timeoutMs,
    }));
  } finally {
    clearInterval(heartbeat);
  }

  onProgress("wiki-ingest: agent finished");

  const pages = await wikiPages(dataRoot, env);

  await mkdir(options.outputsDir, { recursive: true });
  await mkdir(join(options.outputsDir, "runs"), { recursive: true });

  const startedAt = now();
  const run: IngestRun = {
    startedAt,
    mode,
    promptFile: `prompts/${promptFile}`,
    settings,
    diff,
    pages,
    agentOutput: stdout,
  };
  const digest = formatDigest(run);
  const digestPath = join(
    options.outputsDir,
    "runs",
    `${startedAt.toISOString().replaceAll(":", "-")}.md`,
  );

  await writeFile(digestPath, digest, "utf8");
  await writeManifest(snapshotPath, current);

  return { status: "ran", mode, digestPath, digest, pages };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]

Run the wiki agent headless over the sources that changed since the
last ingest, then write a per-run digest (guide §18, issue #11).

Flow: read the raw manifest, diff it against the snapshot from the
previous successful run (outputs/last-ingested-manifest.json), pick
prompts/ingest.md (no snapshot yet — first run) or
prompts/incremental.md (changed sources appended to the prompt), invoke
the agent CLI non-interactively in the data repo root (the parent of
the raw dir), and record what happened.

Switches and arguments:
  --settings <path>  Agent settings file. Default: the repo's
                     settings.yml — command, model, and reasoning
                     level, passed to the agent as --model/--thinking;
                     never hardcoded.
  --outputs <dir>    Where the digest (runs/<timestamp>.md) and the
                     manifest snapshot go. Default: the repo's outputs/.
  --timeout <secs>   Kill the agent run after this many seconds and
                     fail it; the snapshot stays untouched. Default:
                     1800 (30 minutes).
  -h, --help         Print this help and exit; no side effects.
  <raw-dir>          raw/ directory holding manifest.json. Default:
                     <dataRoot>/raw from sync.json, otherwise the
                     repo's own raw/.

What it writes:
  - wiki pages, by the agent, in the data repo (never raw/);
  - outputs/last-ingested-manifest.json — the manifest snapshot the
    next run diffs against (only after a successful agent run);
  - outputs/runs/<timestamp>.md — the digest, also printed to stdout.

With no changed sources since the snapshot nothing runs: it says so
and exits 0. On a terminal (TTY, color enabled) the agent run shows
one animated status line - a braille spinner plus the elapsed time -
rewritten in place; piped, redirected, CI, or NO_COLOR runs get one
plain heartbeat line per 60 seconds instead. A run that fails or
exceeds the timeout exits 1 and leaves the snapshot and digest
untouched, so the next run retries the same sources. Live progress
goes to stderr; the digest goes to stdout. Guardrails (checks,
auto-revert) are issue #12; scheduling is #14.`;

function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  console.error(colors().red(`wiki-ingest: ${message}`));
  process.exitCode = 1;
}

/** A stderr progress surface: plain lines, or one animated line. */
export interface ProgressSink {
  render(message: string): void;
  end(): void;
}

/**
 * The stderr presentation for one wiki-ingest run: agent heartbeats
 * keep one animated line (spinner + clock) on a TTY; every other
 * message scrolls. Non-animated runs append plain lines only.
 */
export function createAgentProgressSink(
  write: (text: string) => void,
  writeLine: (text: string) => void,
  animated: boolean,
  dim: (text: string) => string,
): ProgressSink {
  if (!animated) {
    return {
      render: (message) => writeLine(dim(message)),
      end: () => {},
    };
  }

  const renderer = createProgressRenderer(write);

  return {
    render: (message) => {
      if (message.startsWith(AGENT_HEARTBEAT_PREFIX)) {
        renderer.live(dim(message));
      } else {
        renderer.event(dim(message));
      }
    },
    end: () => renderer.end(),
  };
}

/** wiki-ingest entry point: `wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const values = new Map<string, string | undefined>();
  const consumed = new Set<number>();

  for (const flag of ["--settings", "--outputs", "--timeout"]) {
    const index = args.indexOf(flag);

    if (index !== -1) {
      values.set(flag, args[index + 1]);
      consumed.add(index);
      consumed.add(index + 1);
    }
  }

  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (consumed.has(index)) {
      continue;
    }

    if (arg.startsWith("-")) {
      fail(`unknown option ${JSON.stringify(arg)}`);

      return;
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    fail(`expected at most one <raw-dir> argument, got ${positional.length}`);

    return;
  }

  for (const [flag, value] of values) {
    if (flag === "--timeout") {
      continue;
    }

    if (value === undefined) {
      fail(`${flag} needs a path value`);

      return;
    }
  }

  const timeoutArg = values.get("--timeout");

  if (
    values.has("--timeout") &&
    (timeoutArg === undefined || !/^[1-9][0-9]*$/.test(timeoutArg))
  ) {
    fail("--timeout needs a positive integer number of seconds");

    return;
  }

  const settingsPath =
    values.get("--settings") ?? join(repoRoot, "settings.yml");

  const animated = process.stderr.isTTY === true && !process.env.NO_COLOR;
  const sink = createAgentProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    (text) => colors().dim(text),
  );

  try {
    const config = await loadSyncConfig(join(repoRoot, "sync.json"), homedir());
    const rawDir = positional[0] ?? resolveRawDir(config.dataRoot, repoRoot);
    const result = await runWikiIngest({
      settingsPath,
      rawDir,
      outputsDir: values.get("--outputs") ?? join(repoRoot, "outputs"),
      promptsDir: join(repoRoot, "prompts"),
      timeoutMs:
        timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
      heartbeatMs: animated ? 100 : undefined,
      onProgress: sink.render,
    });

    sink.end();

    if (result.status === "skipped") {
      console.log(`wiki-ingest: ${result.reason}`);

      return;
    }

    console.log(result.digest);
  } catch (error) {
    sink.end();
    console.error(
      colors().red(
        `wiki-ingest: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url);

/* v8 ignore next: covered only under `node src/ingest/wiki-ingest.ts` */
if (isMain) {
  await main();
}
