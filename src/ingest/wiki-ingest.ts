import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../cli/is-main.ts";
import { createProgressRenderer, formatDuration } from "../cli/progress.ts";
import { runGit } from "../data/init-data-repo.ts";
import {
  isPlainObject,
  loadSyncConfig,
  resolveRawDir,
} from "../sync/config.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  readManifestText,
  type VaultNotes,
  writeManifest,
} from "../sync/manifest.ts";
import {
  buildPageIndex,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  type PageFields,
  readPageFields,
  wikilinkTarget,
} from "../wiki/pages.ts";
import {
  capturePreRunState,
  type GuardrailFailure,
  type PreRunState,
  parseStatus,
  revertToPreRun,
  runGuardrails,
} from "./guardrails.ts";

/**
 * wiki-ingest: the headless wiki agent run (guide §18, issue #11). It
 * diffs `raw/manifest.json` against the snapshot from the previous
 * successful run, picks `prompts/ingest.md` (first run),
 * `prompts/incremental.md` (changed sources appended), or
 * `prompts/expunge.md` (a synced note was deleted — issue #65: the
 * removed note's last content from git history and the deterministic
 * direct set are appended, and a mixed run also gets incremental.md
 * appended so its non-removed sources are ingested), invokes the agent
 * CLI non-interactively in
 * the data repo root, runs the post-run guardrails (issue #12:
 * immutability, frontmatter, wikilinks — auto-reverting to the
 * pre-run commit on failure, expunge runs included), and writes a
 * digest the human can review in under a minute. Scheduling is #14.
 */

export interface AgentSettings {
  /** Agent CLI command; run non-interactively in the data repo root. */
  readonly command: string;
  /** Passed to the agent as `--model`. */
  readonly model: string;
  /** Reasoning level; passed to the agent as `--thinking`. */
  readonly reasoning: string;
  /** Passed to the agent as `--provider` when set. */
  readonly provider?: string;
  /** Domain wiki dirs for the cycle's crosslink audit (wiki-sync,
   *  issue #96); undefined leaves the stage out entirely. Paths are
   *  as written — `~` expands at use, like every settings value. */
  readonly secondBrainDomains?: readonly string[];
}

const REQUIRED_KEYS = ["command", "model", "reasoning"] as const;
const OPTIONAL_KEYS = ["provider"] as const;
const DOMAIN_KEY = "secondBrain.domains";
const SETTING_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

function unquote(value: string): string {
  const quote = value[0];

  return quote === '"' || quote === "'"
    ? value.slice(1, value.length - 1)
    : value;
}

/** The dirs of a `secondBrain.domains` value: an optional `[...]`
 *  wrapper, then comma-separated paths (each optionally quoted).
 *  Empty items are dropped; an empty list is an error. */
function parseDomainDirs(value: string, origin: string): string[] {
  const list = value.replace(/^\[/, "").replace(/\]$/, "");
  const dirs = list
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== "");

  if (dirs.length === 0) {
    throw new Error(
      `invalid agent settings at ${origin}: setting ${JSON.stringify(DOMAIN_KEY)} needs at least one wiki dir`,
    );
  }

  return dirs;
}

/**
 * Parse the settings file: a YAML subset of top-level `key: value`
 * scalars, `#` comments on their own line or trailing the value, and
 * optionally quoted values — plus the one list-valued key
 * `secondBrain.domains`. Anything else (nesting, other lists) is
 * rejected so a typo cannot silently change the agent configuration.
 */
export function parseSettings(text: string, origin: string): AgentSettings {
  const values = new Map<SettingKey, string>();
  let domains: readonly string[] | undefined;

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

    if (key === DOMAIN_KEY) {
      if (domains !== undefined) {
        throw new Error(
          `invalid agent settings at ${origin}: duplicate setting ${JSON.stringify(key)}`,
        );
      }

      domains = parseDomainDirs(value, origin);

      continue;
    }

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

  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) {
      throw new Error(
        `invalid agent settings at ${origin}: missing setting ${JSON.stringify(key)}`,
      );
    }
  }

  const provider = values.get("provider");

  return {
    command: values.get("command") ?? "",
    model: values.get("model") ?? "",
    reasoning: values.get("reasoning") ?? "",
    ...(provider !== undefined && { provider }),
    ...(domains !== undefined && { secondBrainDomains: domains }),
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
  /** Remove+add pairs with identical content hash: moves, not deletions. */
  readonly renamed: readonly NoteRename[];
}

/** A note that moved within one vault without changing its content. */
export interface NoteRename {
  readonly from: string;
  readonly to: string;
}

export interface ManifestDiff {
  /** Only vaults with at least one change, sorted by vault name. */
  readonly vaults: readonly VaultSourceChange[];
  readonly empty: boolean;
}

/**
 * Pair remove+add notes with equal hashes as renames (a move in the
 * same vault, issue #65): each added path pairs with the first
 * unmatched removed path of equal hash, in sorted order, so the
 * pairing is deterministic even between equal-content notes.
 */
function extractRenames(
  before: VaultNotes,
  after: VaultNotes,
  added: readonly string[],
  removed: readonly string[],
): { renamed: NoteRename[]; added: string[]; removed: string[] } {
  const renamed: NoteRename[] = [];
  const taken = new Set<string>();

  for (const to of added) {
    const hash = after[to]?.hash;
    const from = removed.find(
      (path) => !taken.has(path) && before[path]?.hash === hash,
    );

    if (from !== undefined) {
      taken.add(from);
      renamed.push({ from, to });
    }
  }

  return {
    renamed,
    added: added.filter((path) => !renamed.some((r) => r.to === path)),
    removed: removed.filter((path) => !taken.has(path)),
  };
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

      const addedRaw = Object.keys(after)
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
      const removedRaw = Object.keys(before)
        .filter((path) => after[path] === undefined)
        .sort();
      const { renamed, added, removed } = extractRenames(
        before,
        after,
        addedRaw,
        removedRaw,
      );

      return { vault: name, added, changed, removed, renamed };
    })
    .filter(
      (vault) =>
        vault.added.length +
          vault.changed.length +
          vault.removed.length +
          vault.renamed.length >
        0,
    );

  return { vaults, empty: vaults.length === 0 };
}

/** Render the changed-source list appended below incremental and expunge prompts. */
function changedSourceLines(diff: ManifestDiff): string[] {
  const lines: string[] = [];

  for (const vault of diff.vaults) {
    for (const path of vault.added) {
      lines.push(`+ ${vault.vault}/${path}`);
    }

    for (const path of vault.changed) {
      lines.push(`~ ${vault.vault}/${path}`);
    }

    for (const rename of vault.renamed) {
      lines.push(
        `→ ${vault.vault}/${rename.from} → ${vault.vault}/${rename.to}`,
      );
    }

    for (const path of vault.removed) {
      lines.push(`- ${vault.vault}/${path}`);
    }
  }

  return lines;
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

  return [
    promptText,
    "",
    "Changed sources since the previous ingestion:",
    "",
    ...changedSourceLines(diff),
  ].join("\n");
}

/** A removed source note: its identity plus its last synced content. */
export interface RemovedNote {
  readonly vault: string;
  /** Vault-relative note path, as the manifest records it. */
  readonly path: string;
  /** Data-repo-relative raw path, `raw/notes/<vault>/<path>`. */
  readonly rawPath: string;
  /** Last synced content from git history; undefined when unrecorded. */
  readonly content: string | undefined;
}

/** A markdown fence longer than any backtick run in the content it wraps,
 *  so a note body can never close its own wrapper. */
function wrappingFence(content: string): string {
  let longest = 0;

  for (const run of content.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }

  return "`".repeat(Math.max(4, longest + 1));
}

/**
 * Compose the expunge agent message: the expunge prompt, the changed
 * sources (an expunge run may also carry adds and edits), each removed
 * note's last synced content, and the deterministic direct set. The
 * direct set is a lower bound the agent extends by search (guide §14a).
 * When the run also carries added, edited, or renamed sources, the
 * incremental prompt is appended so those sources are ingested in the
 * same run instead of being marked processed without ever reaching
 * the agent.
 */
export function composeExpungePrompt(
  promptText: string,
  diff: ManifestDiff,
  removedNotes: readonly RemovedNote[],
  directSet: readonly string[],
  incrementalText?: string,
): string {
  const lines = [promptText];

  if (incrementalText !== undefined) {
    lines.push(
      "",
      "This run also carries added, edited, or renamed sources (`+`, `~`, `→` in the list below). In the same run, process them exactly as an incremental ingestion would:",
      "",
      incrementalText,
    );
  }

  lines.push(
    "",
    "Changed sources since the previous ingestion:",
    "",
    ...changedSourceLines(diff),
    "",
    "Removed notes with their last synced content:",
    "",
  );

  for (const note of removedNotes) {
    lines.push(`### ${note.vault}/${note.path} (${note.rawPath})`, "");

    if (note.content === undefined) {
      lines.push(
        "(last synced content unavailable: no committed git history — purge by path, title, and full-text search)",
      );
    } else {
      const fence = wrappingFence(note.content);

      lines.push(`${fence}markdown`, note.content, fence);
    }

    lines.push("");
  }

  lines.push(
    "Direct set (deterministic seed — a lower bound, not a boundary):",
    "",
  );

  for (const page of directSet) {
    lines.push(`- wiki/${page}`);
  }

  return lines.join("\n");
}

/** A git command's stdout, or undefined when git fails for any reason. */
async function tryGit(
  dataRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(dataRoot, args, env);

    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * The last synced content of a removed raw note, from the data repo's
 * git history. The note is absent from the working tree (sync removed
 * it), so HEAD either still holds it (removal not yet committed) or the
 * last commit that touched the path is its deletion — whose parent
 * tree holds the final content. Undefined when git never knew the path.
 */
export async function removedNoteContent(
  dataRoot: string,
  rawRelPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const atHead = await tryGit(dataRoot, ["show", `HEAD:${rawRelPath}`], env);

  if (atHead !== undefined) {
    return atHead;
  }

  const sha = (
    await tryGit(dataRoot, ["rev-list", "-1", "HEAD", "--", rawRelPath], env)
  )?.trim();

  if (sha === undefined || sha === "") {
    return undefined;
  }

  return tryGit(dataRoot, ["show", `${sha}^:${rawRelPath}`], env);
}

/**
 * The deterministic expunge seed (guide §14a): every source page whose
 * `origin` names a removed raw path, every page whose `sources` cites a
 * removed raw path or a seeded source page, plus `index.md` and
 * `overview.md` unconditionally. A missing wiki tree seeds only the
 * unconditional pair — the prompt's full-text search covers the rest.
 */
export async function directSetForRemovals(
  wikiRoot: string,
  removedRawPaths: readonly string[],
): Promise<readonly string[]> {
  let files: string[];

  try {
    files = await listWikiPages(wikiRoot);
  } catch {
    files = [];
  }

  const wanted = new Set(removedRawPaths.map(normalizeRawPath));
  const fields = new Map<string, PageFields>();
  const originPages = new Set<string>();

  for (const file of files) {
    const pageFields = await readPageFields(join(wikiRoot, file));

    fields.set(file, pageFields);

    if (
      pageFields.origin !== undefined &&
      wanted.has(normalizeRawPath(pageFields.origin))
    ) {
      originPages.add(file);
    }
  }

  const nameToPage = buildPageIndex(files);
  const seed = new Set<string>(["index.md", "overview.md"]);

  for (const file of originPages) {
    seed.add(file);
  }

  for (const [file, pageFields] of fields) {
    const cites = pageFields.sources.some((entry) => {
      if (isWikilinkEntry(entry)) {
        const cited = nameToPage.get(wikilinkTarget(entry));

        return cited !== undefined && originPages.has(cited);
      }

      return wanted.has(normalizeRawPath(entry));
    });

    if (cites) {
      seed.add(file);
    }
  }

  return [...seed].sort();
}

/**
 * Read the frontmatter of created and updated wiki pages and return
 * those with exactly one sources entry — the mechanical unverified
 * frontier (issue #79).
 */
async function readUnverifiedFrontier(
  dataRoot: string,
  pages: WikiPages,
): Promise<{ path: string; sources: readonly string[] }[]> {
  const result: { path: string; sources: readonly string[] }[] = [];

  for (const path of [...pages.created, ...pages.updated]) {
    const fields = await readPageFields(join(dataRoot, path));

    if (fields.sources.length === 1) {
      result.push({ path, sources: fields.sources });
    }
  }

  return result;
}

/** Wiki page changes, read from the data repo's git status. */
export interface WikiPages {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  /** Pages the run deleted — an expunge run's most important action. */
  readonly deleted: readonly string[];
  /** Set when git could not report; the run itself still succeeded. */
  readonly unavailable: string | undefined;
}

/** One completed run, everything the digest reports. */
export interface UnverifiedFrontierPage {
  readonly path: string;
  readonly sources: readonly string[];
}

export interface IngestRun {
  readonly startedAt: Date;
  readonly mode: "full" | "incremental" | "expunge";
  readonly promptFile: string;
  readonly settings: AgentSettings;
  readonly diff: ManifestDiff;
  readonly pages: WikiPages;
  /** Deterministic expunge seed; set only for expunge runs. */
  readonly directSet: readonly string[] | undefined;
  readonly agentOutput: string;
  /** Pages created or updated with exactly one sources entry. */
  readonly unverifiedFrontier: readonly UnverifiedFrontierPage[];
  /** The guardrail that tripped, when the run was auto-reverted. */
  readonly guardrailFailure?: GuardrailFailure | undefined;
}

/** Total note count of one kind (added, changed, or removed) across
 *  every vault of a diff. */
export function sourceCount(
  diff: ManifestDiff,
  key: "added" | "changed" | "removed" | "renamed",
): number {
  return diff.vaults.reduce((total, vault) => total + vault[key].length, 0);
}

/** Render the digest's per-vault changed-source listing. */
function digestVaultLines(diff: ManifestDiff): string[] {
  const lines: string[] = [];

  for (const vault of diff.vaults) {
    lines.push(`**${vault.vault}**`);

    for (const path of vault.added) {
      lines.push(`- + ${vault.vault}/${path}`);
    }

    for (const path of vault.changed) {
      lines.push(`~ ${vault.vault}/${path}`);
    }

    for (const rename of vault.renamed) {
      lines.push(
        `→ ${vault.vault}/${rename.from} → ${vault.vault}/${rename.to}`,
      );
    }

    for (const path of vault.removed) {
      lines.push(`- − ${vault.vault}/${path}`);
    }
  }

  return lines;
}

/** Render the per-run digest markdown: counts first, details after. */
export function formatDigest(run: IngestRun): string {
  const { settings } = run;
  const label = run.mode === "expunge" ? " (expunge)" : "";
  const lines: string[] = [
    `# Wiki ingest digest${label} — ${run.startedAt.toISOString()}`,
    "",
    `- **Agent:** \`${settings.command}\`${settings.provider ? ` · provider \`${settings.provider}\`` : ""} · model \`${settings.model}\` · reasoning \`${settings.reasoning}\``,
    `- **Mode:** ${run.mode} · prompt \`${run.promptFile}\``,
    `- **Sources:** ${sourceCount(run.diff, "added")} added, ${sourceCount(run.diff, "changed")} changed, ${sourceCount(run.diff, "removed")} removed, ${sourceCount(run.diff, "renamed")} renamed`,
  ];

  if (run.pages.unavailable === undefined) {
    lines.push(
      `- **Wiki pages:** ${run.pages.created.length} created, ${run.pages.updated.length} updated, ${run.pages.deleted.length} deleted`,
    );
  } else {
    lines.push(`- **Wiki pages:** unavailable — ${run.pages.unavailable}`);
  }

  if (run.guardrailFailure !== undefined) {
    const failure = run.guardrailFailure;

    lines.push(
      "",
      "## Guardrails failed",
      "",
      `Check ${failure.check} (${failure.name}) tripped; the run was auto-reverted to the pre-run commit.`,
      "",
    );

    for (const problem of failure.problems) {
      lines.push(`- ${problem}`);
    }
  }

  lines.push(
    "- **Contradictions and unresolved questions:** in the agent report below",
  );

  if (run.mode !== "full") {
    lines.push("", "## Changed sources", "", ...digestVaultLines(run.diff));
  }

  if (run.mode === "expunge" && run.directSet !== undefined) {
    lines.push("", "## Expunge direct set", "");

    for (const page of run.directSet) {
      lines.push(`- wiki/${page}`);
    }
  }

  if (run.unverifiedFrontier.length > 0) {
    lines.push(
      "",
      "## Unverified frontier",
      "",
      "Pages with exactly one source (mechanical):",
    );

    for (const page of run.unverifiedFrontier) {
      lines.push(`- ${page.path} (1 source: ${page.sources[0]})`);
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

    lines.push("", "Deleted:");

    for (const path of run.pages.deleted) {
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

/** Heartbeat sentence prefixes (plain or expunge-labeled); the TTY
 *  renderer keeps matching messages on one animated line (spinner + clock). */
export const AGENT_HEARTBEAT_PREFIX = [
  "wiki-ingest: agent still running",
  "wiki-ingest: expunge agent still running",
] as const;

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
 * Wiki pages created, updated, and deleted by the run, from the data
 * repo's git status: untracked or added paths count as created,
 * modified paths as updated, deleted paths (staged or not) as deleted.
 * Deleting a page that was still untracked leaves no status entry at
 * all, so with the pre-run state those pages count as deleted when
 * their file is gone; a deletion that predates the run (already `D`
 * pre-run) is not the run's doing. When git cannot report, the digest
 * says so instead of failing a run that did update the wiki.
 */
export async function wikiPages(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pathspec = "wiki",
  pre?: PreRunState,
): Promise<WikiPages> {
  let stdout: string;

  try {
    ({ stdout } = await runGit(
      dataRoot,
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain",
        "-uall",
        "--",
        pathspec,
      ],
      env,
    ));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    return { created: [], updated: [], deleted: [], unavailable: reason };
  }

  const entries = parseStatus(stdout);
  const before = new Map(
    (pre?.status ?? []).map((entry) => [entry.path, entry] as const),
  );
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];

  for (const { code, path } of entries) {
    if (code.includes("A") || code.includes("?")) {
      created.push(path);
    } else if (code.includes("M")) {
      updated.push(path);
    } else if (code.includes("D") && !before.get(path)?.code.includes("D")) {
      deleted.push(path);
    }
  }

  for (const entry of before.values()) {
    if (
      entry.code.includes("?") &&
      entry.path.startsWith(`${pathspec}/`) &&
      entry.path.endsWith(".md") &&
      !entries.some((current) => current.path === entry.path)
    ) {
      deleted.push(entry.path);
    }
  }

  return {
    created: created.sort(),
    updated: updated.sort(),
    deleted: deleted.sort(),
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
  readonly runAgent?: AgentRunner | undefined;
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
      readonly mode: "full" | "incremental" | "expunge";
      readonly digestPath: string;
      readonly digest: string;
      readonly pages: WikiPages;
      /** The manifest diff the run ingested; feeds the cycle's commit
       *  message (issue #13). */
      readonly diff: ManifestDiff;
    };

export async function readPrompt(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read prompt at ${path}`, { cause });
  }
}

/** Prompt file per mode: first run, later changes, deletions. */
function promptFileFor(mode: "full" | "incremental" | "expunge"): string {
  if (mode === "full") {
    return "ingest.md";
  }

  return mode === "expunge" ? "expunge.md" : "incremental.md";
}

/** The removed notes of a diff, each with its last synced content
 *  recovered from the data repo's git history. */
async function collectRemovedNotes(
  dataRoot: string,
  diff: ManifestDiff,
  env: NodeJS.ProcessEnv,
): Promise<RemovedNote[]> {
  const removedNotes: RemovedNote[] = [];

  for (const vault of diff.vaults) {
    for (const path of vault.removed) {
      const rawPath = `raw/notes/${vault.vault}/${path}`;
      const content = await removedNoteContent(dataRoot, rawPath, env);

      removedNotes.push({ vault: vault.vault, path, rawPath, content });
    }
  }

  return removedNotes;
}

/**
 * Read the last-ingested snapshot when it belongs to this data repo.
 * The snapshot is stamped with its data root at write time (issue #95):
 * a stamp that names another instance — or an unstamped legacy
 * snapshot, whose origin is unknowable — is foreign state. Diffing
 * against it would silently mis-shape the change set (worst case a
 * spurious expunge), so warn loudly and return undefined; the caller
 * falls back to the full mode. Missing file: first run, no warning.
 */
async function readSnapshot(
  snapshotPath: string,
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<Manifest | undefined> {
  const text = await readManifestText(snapshotPath);

  if (text === undefined) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid manifest at ${snapshotPath}: not valid JSON`, {
      cause,
    });
  }

  const snapshotFor =
    isPlainObject(parsed) && typeof parsed.snapshotFor === "string"
      ? parsed.snapshotFor
      : undefined;

  if (snapshotFor !== dataRoot) {
    const origin =
      snapshotFor === undefined
        ? "has no instance stamp"
        : `is stamped for ${snapshotFor}`;

    onProgress(
      `wiki-ingest: WARNING — snapshot ${snapshotPath} ${origin}, not this instance (${dataRoot}); ignoring it and falling back to a full run; the next successful ingest rewrites the snapshot, so this warning will not repeat`,
    );

    return undefined;
  }

  return parseManifest(text, snapshotPath);
}

/**
 * One headless ingest run. The snapshot is written only after a
 * successful agent run, so a failure retries the same sources next
 * time instead of silently skipping them. A manifest diff with removed
 * entries routes to the expunge flow (issue #65); removed entries that
 * pair with equal-hash additions are renames and never route there.
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

  const dataRoot = dirname(options.rawDir);
  const current = parseManifest(manifestText, manifestPath);
  const snapshotPath = join(options.outputsDir, "last-ingested-manifest.json");
  const previous = await readSnapshot(snapshotPath, dataRoot, onProgress);
  const diff = diffManifests(previous ?? emptyManifest(), current);

  if (diff.empty) {
    const reason = "no changed sources since the last ingest; nothing to do";

    onProgress(reason);

    return { status: "skipped", reason };
  }

  const removedCount = sourceCount(diff, "removed");
  const mode =
    previous === undefined
      ? "full"
      : removedCount > 0
        ? "expunge"
        : "incremental";
  const promptFile = promptFileFor(mode);
  const promptText = await readPrompt(join(options.promptsDir, promptFile));

  let composed: string;
  let directSet: readonly string[] | undefined;

  if (mode === "expunge") {
    const removedNotes = await collectRemovedNotes(dataRoot, diff, env);

    directSet = await directSetForRemovals(
      join(dataRoot, "wiki"),
      removedNotes.map((note) => note.rawPath),
    );

    const carriesNonRemovals =
      sourceCount(diff, "added") +
        sourceCount(diff, "changed") +
        sourceCount(diff, "renamed") >
      0;
    const incrementalText = carriesNonRemovals
      ? await readPrompt(join(options.promptsDir, "incremental.md"))
      : undefined;

    composed = composeExpungePrompt(
      promptText,
      diff,
      removedNotes,
      directSet,
      incrementalText,
    );

    onProgress(
      `wiki-ingest: expunge — ${removedCount} removed source${removedCount === 1 ? "" : "s"}; direct set: ${directSet.map((page) => `wiki/${page}`).join(", ")}`,
    );
  } else {
    composed = composePrompt(
      promptText,
      mode === "incremental" ? diff : undefined,
    );
  }

  const args = [
    ...(settings.provider ? ["--provider", settings.provider] : []),
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    composed,
  ];
  const runAgent = options.runAgent ?? spawnAgent;
  const pre = await capturePreRunState(dataRoot, env);

  const providerFlag = settings.provider
    ? ` --provider ${settings.provider}`
    : "";

  onProgress(
    `wiki-ingest: mode ${mode}, invoking agent: ${settings.command}${providerFlag} --model ${settings.model} --thinking ${settings.reasoning}`,
  );

  const agentStartedAt = now().getTime();
  const heartbeat = setInterval(() => {
    const elapsed = formatDuration(now().getTime() - agentStartedAt);
    const label = mode === "expunge" ? "expunge " : "";

    onProgress(`wiki-ingest: ${label}agent still running (${elapsed})`);
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  let stdout = "";
  let agentError: unknown;

  try {
    ({ stdout } = await runAgent(settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs: options.timeoutMs,
    }));
  } catch (error) {
    agentError = error;
  } finally {
    clearInterval(heartbeat);
  }

  if (agentError === undefined) {
    onProgress("wiki-ingest: agent finished");
  }

  const post = await runGuardrails(dataRoot, env, pre);
  const startedAt = now();

  await mkdir(options.outputsDir, { recursive: true });
  await mkdir(join(options.outputsDir, "runs"), { recursive: true });

  const digestPath = join(
    options.outputsDir,
    "runs",
    `${startedAt.toISOString().replaceAll(":", "-")}.md`,
  );

  if (post.failure !== undefined) {
    const failure = post.failure;

    onProgress(
      `wiki-ingest: guardrail check ${failure.check} (${failure.name}) failed — reverting to ${pre.commit.slice(0, 8)}`,
    );

    await revertToPreRun(dataRoot, env, pre, post.entries);
    await writeFile(
      digestPath,
      formatDigest({
        startedAt,
        mode,
        promptFile: `prompts/${promptFile}`,
        settings,
        diff,
        pages: {
          created: [],
          updated: [],
          deleted: [],
          unavailable: `run reverted — guardrail check ${failure.check} (${failure.name}) tripped`,
        },
        directSet: undefined,
        agentOutput: stdout,
        unverifiedFrontier: [],
        guardrailFailure: failure,
      }),
      "utf8",
    );

    throw new Error(
      `guardrail check ${failure.check} (${failure.name}) failed; run reverted to ${pre.commit.slice(0, 8)} — ${failure.problems.join("; ")}`,
      { cause: agentError },
    );
  }

  onProgress("wiki-ingest: guardrails passed");

  if (agentError !== undefined) {
    onProgress("wiki-ingest: agent failed — guardrails passed, changes kept");

    throw agentError;
  }

  const pages = await wikiPages(dataRoot, env, "wiki", pre);
  const unverifiedFrontier = await readUnverifiedFrontier(dataRoot, pages);

  const run: IngestRun = {
    startedAt,
    mode,
    promptFile: `prompts/${promptFile}`,
    settings,
    diff,
    pages,
    directSet,
    agentOutput: stdout,
    unverifiedFrontier,
  };
  const digest = formatDigest(run);

  await writeFile(digestPath, digest, "utf8");
  await writeManifest(snapshotPath, current, { snapshotFor: dataRoot });

  return { status: "ran", mode, digestPath, digest, pages, diff };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<raw-dir>]

Run the wiki agent headless over the sources that changed since the
last ingest, then write a per-run digest (guide §18, issue #11).

Flow: read the raw manifest, diff it against the snapshot from the
previous successful run (outputs/last-ingested-manifest.json), pick
prompts/ingest.md (no snapshot yet — first run),
prompts/incremental.md (changed sources appended to the prompt), or
prompts/expunge.md (a synced note was deleted — the removed note's
last content is recovered from the data repo's git history and
appended with the deterministic direct set of affected wiki pages; a
remove+add pair in one vault with an identical content hash is a
rename/retitle, not a deletion; an expunge run that also carries
added, edited, or renamed sources gets prompts/incremental.md
appended below the expunge prompt, so those sources are ingested in
the same run), invoke the agent CLI non-interactively in the data
repo root (the parent of the raw dir), and record what happened.

Switches and arguments:
  --settings <path>  Agent settings file. Default: the repo's
                     settings.yml — command, model, provider, and reasoning
                     level, passed to the agent as --model/--thinking;
                     provider is optional and passed as --provider when set.
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
    next run diffs against (only after a successful agent run),
    stamped with its data repo root: a snapshot stamped for another
    instance — or an unstamped legacy one — is ignored with a loud
    warning and the run falls back to full mode (issue #95);
  - outputs/runs/<timestamp>.md — the digest, also printed to stdout.

After every agent run three guardrails check the data repo (guide
§1, §7, §9; issue #12): (1) immutability — only wiki/ (never the
wiki/AGENTS.md contract), outputs/, and raw/manifest.json may change,
and HEAD may not move; (2) frontmatter — every changed wiki page
parses with the required fields (wiki/log.md, the append-only log,
is exempt); (3) wikilinks — every [[wikilink]]
in a changed page resolves, and no remaining page links to a page
the run deleted. A tripped check auto-reverts the data repo to its
pre-run state (the pre-run commit plus the uncommitted work that
preceded the run), writes a failure digest naming the check, and
exits 1.

With no changed sources since the snapshot nothing runs: it says so
and exits 0. A digest is labeled expunge when the run purged deleted
sources: it carries the direct-set preview, a deleted wiki-pages
category, and the agent's threshold decision. On a terminal (TTY, color enabled) the agent run shows
one animated status line - a braille spinner plus the elapsed time -
rewritten in place; piped, redirected, CI, or NO_COLOR runs get one
plain heartbeat line per 60 seconds instead. A run that fails or
exceeds the timeout still runs the guardrails, exits 1, and leaves
the snapshot untouched, so the next run retries the same sources. Live progress
goes to stderr; the digest goes to stdout. Scheduling is #14.`;

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
 * Severity is detected here, at the render boundary: WARNING messages
 * render yellow, everything else dim.
 */
export function createAgentProgressSink(
  write: (text: string) => void,
  writeLine: (text: string) => void,
  animated: boolean,
  tones: { dim: (text: string) => string; yellow: (text: string) => string },
  heartbeatPrefix: string | readonly string[] = AGENT_HEARTBEAT_PREFIX,
): ProgressSink {
  const prefixes =
    typeof heartbeatPrefix === "string" ? [heartbeatPrefix] : heartbeatPrefix;
  const styled = (message: string) =>
    message.includes("WARNING") ? tones.yellow(message) : tones.dim(message);

  if (!animated) {
    return {
      render: (message) => writeLine(styled(message)),
      end: () => {},
    };
  }

  const renderer = createProgressRenderer(write);

  return {
    render: (message) => {
      if (prefixes.some((prefix) => message.startsWith(prefix))) {
        renderer.live(styled(message));
      } else {
        renderer.event(styled(message));
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
    colors(),
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
