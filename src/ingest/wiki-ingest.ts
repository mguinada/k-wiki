import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canAnimate,
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../cli/colors.ts";
import {
  flagValueError,
  readFlagValues as sharedReadFlagValues,
} from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import {
  createProgressRenderer,
  formatDuration,
  isWarning,
} from "../cli/progress.ts";
import { writeDashboard } from "../dashboard/generate.ts";
import { runGit } from "../data/git.ts";
import {
  isPlainObject,
  loadSyncConfig,
  resolveRawDir,
} from "../sync/config.ts";
import { sha256 } from "../sync/hash.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
  readManifestText,
  type VaultNotes,
  writeManifest,
} from "../sync/manifest.ts";
import {
  bodyAfterFrontmatter,
  buildPageIndex,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  type PageFields,
  readPageFields,
  unquote,
  wikilinkTarget,
} from "../wiki/pages.ts";
import {
  capturePreRunState,
  type GuardrailFailure,
  type PreRunState,
  parseStatus,
  revertToPreRun,
  runGuardrails,
  type StatusEntry,
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
  /** False opts out of the pi isolation flags (issue #118);
   *  unset means isolated — the safe default. Agent-agnostic: the
   *  setting becomes flags at the spawn site (agentArgs), so a
   *  non-pi agent's settings simply omit it or opt out. */
  readonly isolate?: boolean;
  /** Domain wiki dirs for the cycle's crosslink audit (wiki-sync,
   *  issue #96); undefined leaves the stage out entirely. Paths are
   *  as written — `~` expands at use, like every settings value. */
  readonly secondBrainDomains?: readonly string[];
}

const REQUIRED_KEYS = ["command", "model", "reasoning"] as const;
const OPTIONAL_KEYS = ["provider", "isolate"] as const;
const DOMAIN_KEY = "secondBrain.domains";
const SETTING_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

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

/** One parsed settings line: skipped, the one list-valued key,
 *  or one scalar setting. */
type ParsedSettingLine =
  | { readonly kind: "skip" }
  | { readonly kind: "domain"; readonly value: string }
  | {
      readonly kind: "setting";
      readonly key: SettingKey;
      readonly value: string;
    };

/** Parse one settings line: reject nesting and malformed pairs,
 *  drop blanks and comments, split `key: value`. */
function parseSettingLine(rawLine: string, origin: string): ParsedSettingLine {
  if (/^\s/.test(rawLine)) {
    const indented = rawLine.trim();

    if (indented !== "" && !indented.startsWith("#")) {
      throw new Error(
        `invalid agent settings at ${origin}: nested values are not supported`,
      );
    }

    return { kind: "skip" };
  }

  const line = rawLine.replace(/\s+#.*$/, "").trim();

  if (line === "" || line.startsWith("#")) {
    return { kind: "skip" };
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
    return { kind: "domain", value };
  }

  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `invalid agent settings at ${origin}: unknown setting ${JSON.stringify(key)}`,
    );
  }

  return { kind: "setting", key: key as SettingKey, value };
}

/** Record the `secondBrain.domains` value; a second one is an error. */
function recordDomain(
  domains: readonly string[] | undefined,
  value: string,
  origin: string,
): readonly string[] {
  if (domains !== undefined) {
    throw new Error(
      `invalid agent settings at ${origin}: duplicate setting ${JSON.stringify(DOMAIN_KEY)}`,
    );
  }

  return parseDomainDirs(value, origin);
}

/** Record one scalar setting; duplicates and empty values are errors. */
function recordSetting(
  values: Map<SettingKey, string>,
  key: SettingKey,
  value: string,
  origin: string,
): void {
  if (values.has(key)) {
    throw new Error(
      `invalid agent settings at ${origin}: duplicate setting ${JSON.stringify(key)}`,
    );
  }

  if (value === "") {
    throw new Error(
      `invalid agent settings at ${origin}: setting ${JSON.stringify(key)} needs a value`,
    );
  }

  values.set(key, value);
}

/** After the loop: every required key present, isolate a boolean. */
function validateSettings(
  values: Map<SettingKey, string>,
  origin: string,
): void {
  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) {
      throw new Error(
        `invalid agent settings at ${origin}: missing setting ${JSON.stringify(key)}`,
      );
    }
  }

  const isolate = values.get("isolate");

  if (isolate !== undefined && isolate !== "true" && isolate !== "false") {
    throw new Error(
      `invalid agent settings at ${origin}: setting ${JSON.stringify("isolate")} must be true or false, got ${JSON.stringify(isolate)}`,
    );
  }
}

/** The AgentSettings the parsed map and domain list describe. */
function finalizeSettings(
  values: Map<SettingKey, string>,
  domains: readonly string[] | undefined,
): AgentSettings {
  const provider = values.get("provider");
  const isolate = values.get("isolate");

  return {
    command: values.get("command") ?? "",
    model: values.get("model") ?? "",
    reasoning: values.get("reasoning") ?? "",
    ...(provider !== undefined && { provider }),
    ...(isolate !== undefined && { isolate: isolate === "true" }),
    ...(domains !== undefined && { secondBrainDomains: domains }),
  };
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
    const parsed = parseSettingLine(rawLine, origin);

    if (parsed.kind === "skip") {
      continue;
    }

    if (parsed.kind === "domain") {
      domains = recordDomain(domains, parsed.value, origin);
    } else {
      recordSetting(values, parsed.key, parsed.value, origin);
    }
  }

  validateSettings(values, origin);

  return finalizeSettings(values, domains);
}

/** The pi isolation flags (issue #118): mechanically disable every
 *  ambient configuration source — context files (AGENTS.md/CLAUDE.md
 *  discovery), extensions, skills — so a spawned run cannot inherit
 *  globally installed persona, tools, or prompts. Available since
 *  pi 0.67.4. */
const ISOLATION_FLAGS = [
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
] as const;

/** The non-interactive agent argv (issue #118): the isolation flags
 *  (unless the operator opted out with `isolate: false`), then the
 *  settings' provider, model, and reasoning, with the prompt as the
 *  `--print` payload. With `isolate: false` the argv is
 *  byte-identical to the pre-isolation one. */
export function agentArgs(settings: AgentSettings, prompt: string): string[] {
  return [
    ...(settings.isolate === false ? [] : ISOLATION_FLAGS),
    ...(settings.provider ? ["--provider", settings.provider] : []),
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    prompt,
  ];
}

/** The isolation state of a spawned run, for progress and digest
 *  lines (issue #118): `isolated` unless the operator opted out. */
function isolationLabel(settings: AgentSettings): string {
  return settings.isolate === false ? "not isolated" : "isolated";
}

/** The `command [--provider P] --model M --thinking T (state)` tail
 *  the spawn sites print when invoking the agent (issue #118) — the
 *  auditable counterpart of agentArgs, one source for both. */
export function formatAgentInvocation(settings: AgentSettings): string {
  const providerFlag = settings.provider
    ? ` --provider ${settings.provider}`
    : "";

  return `${settings.command}${providerFlag} --model ${settings.model} --thinking ${settings.reasoning} (${isolationLabel(settings)})`;
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

/** The text after a closed frontmatter block: exported by
 *  wiki/pages.ts (beside closingFence) so the ingest rename pairing
 *  (issue #143) and the fidelity core share one fence rule. */

/** SHA-256 of a note's text after the frontmatter fence. */
function bodyHash(content: string): string {
  return sha256(Buffer.from(bodyAfterFrontmatter(content), "utf8"));
}

/** Pair one vault's leftover removed+added notes whose body hashes
 *  match as renames (issue #143's per-vault step). */
async function pairVaultBodyRenames(
  vault: VaultSourceChange,
  readRemoved: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
  readAdded: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
): Promise<VaultSourceChange> {
  if (vault.removed.length === 0 || vault.added.length === 0) {
    return vault;
  }

  const removedHashes = new Map<string, string>();
  const taken = new Set<string>();
  const renamed = [...vault.renamed];

  for (const path of vault.removed) {
    const content = await readRemoved(vault.vault, path);

    if (content !== undefined) {
      removedHashes.set(path, bodyHash(content));
    }
  }

  const added: string[] = [];

  for (const to of vault.added) {
    const content = await readAdded(vault.vault, to);
    const hash = content === undefined ? undefined : bodyHash(content);
    const from =
      hash === undefined
        ? undefined
        : vault.removed.find(
            (path) => !taken.has(path) && removedHashes.get(path) === hash,
          );

    if (from === undefined) {
      added.push(to);

      continue;
    }

    taken.add(from);
    renamed.push({ from, to });
  }

  return {
    ...vault,
    added,
    renamed,
    removed: vault.removed.filter((path) => !taken.has(path)),
  };
}

/**
 * Reclassify leftover removed+added pairs whose bodies (text after
 * the frontmatter fence) hash equal as renames (issue #143): a move
 * plus a same-day frontmatter edit is mechanically a rename and
 * never routes to expunge. Equal full-file hashes are the primary
 * path, already paired by `diffManifests`; this pass pairs only the
 * leftovers, so a note whose body also changed stays
 * removed + added — that ambiguity stays with the agent. Content a
 * reader cannot supply (no git history, unreadable file) leaves the
 * pair unpaired: the pre-#143 behavior.
 */
export async function pairBodyIdenticalRenames(
  diff: ManifestDiff,
  readRemoved: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
  readAdded: (
    vault: string,
    path: string,
  ) => string | undefined | Promise<string | undefined>,
): Promise<ManifestDiff> {
  const vaults = await Promise.all(
    diff.vaults.map((vault) =>
      pairVaultBodyRenames(vault, readRemoved, readAdded),
    ),
  );

  return { vaults, empty: vaults.length === 0 };
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

/** The most specific decomposition of one `--sources` path: the
 *  manifest entry whose vault name is the longest matching
 *  prefix. */
function longestVaultMatch(
  manifest: Manifest,
  source: string,
): { vault: string; path: string } | undefined {
  let match: { vault: string; path: string } | undefined;

  for (const [vault, notes] of Object.entries(manifest.vaults)) {
    const prefix = `${vault}/`;

    if (!source.startsWith(prefix)) {
      continue;
    }

    const path = source.slice(prefix.length);

    if (
      notes[path] !== undefined &&
      (match === undefined || vault.length > match.vault.length)
    ) {
      match = { vault, path };
    }
  }

  return match;
}

/** The synthetic changed-source set of an explicit `--sources` run
 *  (issue #133): every listed path must name one manifest entry and
 *  renders as a `~` (changed) line, so the composed prompt and the
 *  digest read exactly like an incremental run over those sources.
 *  Paths are exact manifest paths — no globbing, no substring
 *  matching: a path naming no entry is an error listing every
 *  offender, never a guess. A path that decomposes two ways (vault
 *  "A" holding "B/c.md" and vault "A/B" holding "c.md") resolves to
 *  the longest vault name — the most specific decomposition. */
export function explicitSourceDiff(
  manifest: Manifest,
  sources: readonly string[],
): ManifestDiff {
  const pathsByVault = new Map<string, string[]>();
  const unknown: string[] = [];

  for (const source of sources) {
    const match = longestVaultMatch(manifest, source);

    if (match === undefined) {
      unknown.push(source);

      continue;
    }

    const paths = pathsByVault.get(match.vault) ?? [];

    paths.push(match.path);
    pathsByVault.set(match.vault, paths);
  }

  if (unknown.length > 0) {
    throw new Error(
      `unknown --sources path(s): ${unknown.join(", ")} — paths are exact manifest paths (<vault name>/<vault-relative path>); no globbing, no substring matching`,
    );
  }

  const vaults = [...pathsByVault.entries()]
    .map(([vault, paths]) => ({
      vault,
      added: [] as string[],
      changed: [...new Set(paths)].sort(),
      removed: [] as string[],
      renamed: [] as NoteRename[],
    }))
    .sort((a, b) => (a.vault < b.vault ? -1 : a.vault > b.vault ? 1 : 0));

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
 *
 * With `expectedHash` (the manifest snapshot's recorded hash for the
 * path), the content is instead the newest committed blob whose
 * full-file hash equals it — the state the snapshot saw, not the
 * note's final content, so edits a failed ingest never processed are
 * not mistaken for the snapshot's state. Undefined when no committed
 * blob matches (the state is unrecoverable).
 */
export async function removedNoteContent(
  dataRoot: string,
  rawRelPath: string,
  env: NodeJS.ProcessEnv,
  expectedHash?: string,
): Promise<string | undefined> {
  if (expectedHash !== undefined) {
    return snapshotNoteContent(dataRoot, rawRelPath, env, expectedHash);
  }

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

/** The newest committed blob of a raw path whose full-file hash
 *  equals `expectedHash`, walking the path's history from HEAD;
 *  undefined when no committed blob ever matched. */
async function snapshotNoteContent(
  dataRoot: string,
  rawRelPath: string,
  env: NodeJS.ProcessEnv,
  expectedHash: string,
): Promise<string | undefined> {
  const log = await tryGit(
    dataRoot,
    ["log", "--format=%H", "HEAD", "--", rawRelPath],
    env,
  );

  if (log === undefined) {
    return undefined;
  }

  for (const sha of log.split("\n")) {
    if (sha === "") {
      continue;
    }

    const content = await tryGit(
      dataRoot,
      ["show", `${sha}:${rawRelPath}`],
      env,
    );

    if (
      content !== undefined &&
      sha256(Buffer.from(content, "utf8")) === expectedHash
    ) {
      return content;
    }
  }

  return undefined;
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

/** A created or updated page citing exactly one source — the
 *  mechanical unverified frontier (issue #79). */
export interface UnverifiedFrontierPage {
  readonly path: string;
  readonly sources: readonly string[];
}

/** One completed run, everything the digest reports. */
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
  /** True when the run ingested explicit `--sources` paths
   *  (issue #133); the digest Mode line records it. */
  readonly explicitSources?: boolean | undefined;
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

/** The digest header: run identity, agent, mode, sources, counts. */
function digestHeaderLines(run: IngestRun): string[] {
  const { settings } = run;
  const label = run.mode === "expunge" ? " (expunge)" : "";
  const scoped =
    run.explicitSources === true ? " · sources selected explicitly" : "";
  const lines: string[] = [
    `# Wiki ingest digest${label} — ${run.startedAt.toISOString()}`,
    "",
    `- **Agent:** \`${settings.command}\`${settings.provider ? ` · provider \`${settings.provider}\`` : ""} · model \`${settings.model}\` · reasoning \`${settings.reasoning}\` · ${isolationLabel(settings)}`,
    `- **Mode:** ${run.mode}${scoped} · prompt \`${run.promptFile}\``,
    `- **Sources:** ${sourceCount(run.diff, "added")} added, ${sourceCount(run.diff, "changed")} changed, ${sourceCount(run.diff, "removed")} removed, ${sourceCount(run.diff, "renamed")} renamed`,
  ];

  if (run.pages.unavailable === undefined) {
    lines.push(
      `- **Wiki pages:** ${run.pages.created.length} created, ${run.pages.updated.length} updated, ${run.pages.deleted.length} deleted`,
    );
  } else {
    lines.push(`- **Wiki pages:** unavailable — ${run.pages.unavailable}`);
  }

  return lines;
}

/** The Guardrails-failed section, or nothing when none tripped. */
function digestGuardrailLines(failure: GuardrailFailure | undefined): string[] {
  if (failure === undefined) {
    return [];
  }

  const lines = [
    "",
    "## Guardrails failed",
    "",
    `Check ${failure.check} (${failure.name}) tripped; the run was auto-reverted to the pre-run commit.`,
    "",
  ];

  for (const problem of failure.problems) {
    lines.push(`- ${problem}`);
  }

  return lines;
}

/** The expunge run's deterministic direct set, or nothing. */
function digestDirectSetLines(run: IngestRun): string[] {
  if (run.mode !== "expunge" || run.directSet === undefined) {
    return [];
  }

  const lines = ["", "## Expunge direct set", ""];

  for (const page of run.directSet) {
    lines.push(`- wiki/${page}`);
  }

  return lines;
}

/** The unverified-frontier section, or nothing when empty. */
function digestFrontierLines(
  frontier: readonly UnverifiedFrontierPage[],
): string[] {
  if (frontier.length === 0) {
    return [];
  }

  const lines = [
    "",
    "## Unverified frontier",
    "",
    "Pages with exactly one source (mechanical):",
  ];

  for (const page of frontier) {
    lines.push(`- ${page.path} (1 source: ${page.sources[0]})`);
  }

  return lines;
}

/** The git-diff page listing: created, updated, deleted — or why
 *  git could not report. */
function digestPageDiffLines(pages: WikiPages): string[] {
  if (pages.unavailable !== undefined) {
    return [`unavailable: ${pages.unavailable}`];
  }

  const lines = ["Created:"];

  for (const path of pages.created) {
    lines.push(`- ${path}`);
  }

  lines.push("", "Updated:");

  for (const path of pages.updated) {
    lines.push(`- ${path}`);
  }

  lines.push("", "Deleted:");

  for (const path of pages.deleted) {
    lines.push(`- ${path}`);
  }

  return lines;
}

/** Render the per-run digest markdown: counts first, details after. */
export function formatDigest(run: IngestRun): string {
  const lines = digestHeaderLines(run);

  lines.push(...digestGuardrailLines(run.guardrailFailure));
  lines.push(
    "- **Contradictions and unresolved questions:** in the agent report below",
  );

  if (run.mode !== "full") {
    lines.push("", "## Changed sources", "", ...digestVaultLines(run.diff));
  }

  lines.push(...digestDirectSetLines(run));
  lines.push(...digestFrontierLines(run.unverifiedFrontier));
  lines.push(
    "",
    "## Wiki pages (git diff)",
    "",
    ...digestPageDiffLines(run.pages),
  );
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
const AGENT_TIMEOUT_MS = 30 * 60_000;

/** Interval for the progress-sink liveness line while the agent
 *  runs (see AGENT_HEARTBEAT_PREFIX for the line's wording). */
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

/** Bucket the post-run status entries: created (added or
 *  untracked), updated (modified), deleted (deleted now but not
 *  already deleted pre-run). */
function currentEntryBuckets(
  entries: readonly StatusEntry[],
  before: ReadonlyMap<string, StatusEntry>,
): { created: string[]; updated: string[]; deleted: string[] } {
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

  return { created, updated, deleted };
}

/** Pre-run untracked pages whose file vanished during the run: git
 *  status never lists them, so the pre-run state is the only witness. */
function vanishedUntracked(
  before: ReadonlyMap<string, StatusEntry>,
  entries: readonly StatusEntry[],
  pathspec: string,
): string[] {
  const deleted: string[] = [];

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

  return deleted;
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
  const { created, updated, deleted } = currentEntryBuckets(entries, before);

  return {
    created: created.sort(),
    updated: updated.sort(),
    deleted: [
      ...deleted,
      ...vanishedUntracked(before, entries, pathspec),
    ].sort(),
    unavailable: undefined,
  };
}

export interface IngestOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The raw dir holding manifest.json; its parent is the data repo. */
  readonly rawDir: string;
  /** Digest destination (the repo's outputs/); a legacy snapshot
   *  found here is adopted into the data repo (issue #112). */
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
  /** Explicit `--sources` paths (issue #133): scoped re-ingest. The
   *  deduped list replaces the manifest diff as the run's
   *  changed-source set (every path a sorted `~` line) and bypasses
   *  the no-change skip; mode resolves to incremental (the snapshot
   *  precondition below guarantees a previous manifest, and the
   *  synthetic diff carries no removals). An empty list behaves as
   *  an absent flag. A scoped run never advances the snapshot: it
   *  does not claim the manifest diff was processed. */
  readonly sources?: readonly string[] | undefined;
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

const SNAPSHOT_FILENAME = "last-ingested-manifest.json";

/** Append `entry` under `comment` to the data repo's .gitignore;
 *  false when an accepted form of the entry is already present.
 *  Shared by the snapshot and dashboard ignore guards. */
async function appendGitignoreEntry(
  dataRoot: string,
  entry: string,
  accepted: readonly string[],
  comment: string,
): Promise<boolean> {
  const ignorePath = join(dataRoot, ".gitignore");
  const existing = (await readManifestText(ignorePath)) ?? "";

  if (existing.split("\n").some((line) => accepted.includes(line.trim()))) {
    return false;
  }

  const body =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;

  await writeFile(ignorePath, `${body}${comment}\n${entry}\n`, "utf8");

  return true;
}

/**
 * Keep the manifest snapshot out of the data repo's history (issue
 * #112): the snapshot is per-instance state, and a commit or clean
 * must never take it. Appends the ignore entry when the data repo's
 * .gitignore lacks it.
 */
async function ensureSnapshotIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const entry = `outputs/${SNAPSHOT_FILENAME}`;

  if (
    await appendGitignoreEntry(
      dataRoot,
      entry,
      [entry],
      "# wiki-ingest manifest snapshot: per-instance state, never committed (issue #112)",
    )
  ) {
    onProgress(
      `wiki-ingest: ignoring ${entry} in the data repo (${join(dataRoot, ".gitignore")}) so no commit or clean can take the snapshot`,
    );
  }
}

/**
 * Keep the regenerated dashboard out of the data repo's history
 * (issue #73): dashboard.html is per-checkout derived output, and a
 * bare `git add .` must never commit it. Appends the ignore entry
 * when the data repo's .gitignore lacks it.
 */
async function ensureDashboardIgnored(
  dataRoot: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const entry = "dashboard.html";

  if (
    await appendGitignoreEntry(
      dataRoot,
      entry,
      [entry, `/${entry}`],
      "# static dashboard: regenerated per checkout, never committed (issue #73)",
    )
  ) {
    onProgress(
      `wiki-ingest: ignoring ${entry} in the data repo (${join(dataRoot, ".gitignore")})`,
    );
  }
}

/**
 * Adopt a pre-#112 snapshot into the data repo: the snapshot is
 * per-instance state and now lives in the data repo's outputs/ —
 * the code repo's outputs/ is gitignored, shared by every worktree,
 * and cleanable. The copy is byte-for-byte, so the snapshotFor
 * stamp check still guards wrong-root snapshots, foreign or
 * unstamped alike. A data-repo snapshot always wins; the legacy
 * file is left in place, harmless where it is.
 */
async function adoptLegacySnapshot(
  legacyPath: string,
  snapshotPath: string,
  onProgress: (message: string) => void,
): Promise<void> {
  if ((await readManifestText(snapshotPath)) !== undefined) {
    return;
  }

  if ((await readManifestText(legacyPath)) === undefined) {
    return;
  }

  await mkdir(dirname(snapshotPath), { recursive: true });
  await copyFile(legacyPath, snapshotPath);
  onProgress(
    `wiki-ingest: adopting legacy snapshot from ${legacyPath} into the data repo (${snapshotPath})`,
  );
}

/**
 * Pre-flight signal (issue #146): a tracked file that matches an
 * ignore rule is the external-writer guardrail-1 hazard — gitignore
 * does not apply to tracked files, so the rule covers nothing and an
 * outside writer (the operator's open Obsidian) trips the
 * immutability check and reverts runs. One warning per file, each
 * naming its fix; a signal, not a gate. Runs after
 * ensureSnapshotIgnored so a tracked snapshot is flagged too.
 */
export async function warnTrackedIgnored(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  onProgress: (message: string) => void,
): Promise<void> {
  const stdout = await tryGit(
    dataRoot,
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--ignored",
      "--exclude-standard",
      "--cached",
    ],
    env,
  );

  if (stdout === undefined) {
    return;
  }

  for (const path of stdout.split("\n").filter(Boolean)) {
    onProgress(
      `wiki-ingest: WARNING — ${path} is tracked but ignored; the rule covers nothing, and an external writer changing it will trip guardrail 1 — untrack it: git rm --cached ${path}`,
    );
  }
}

/** The run's ambient context — environment, clock, progress sink —
 *  with their defaults applied. */
function runContext(options: IngestOptions): {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  onProgress: (message: string) => void;
} {
  return {
    env: options.env ?? process.env,
    now: options.now ?? (() => new Date()),
    onProgress: options.onProgress ?? (() => {}),
  };
}

/** The run's manifest and data repo root; a missing manifest means
 *  sync-vault has not run. */
async function readRunManifest(
  rawDir: string,
): Promise<{ dataRoot: string; current: Manifest }> {
  const manifestPath = join(rawDir, "manifest.json");
  const manifestText = await readManifestText(manifestPath);

  if (manifestText === undefined) {
    throw new Error(`no manifest at ${manifestPath}: run sync-vault first`);
  }

  return {
    dataRoot: dirname(rawDir),
    current: parseManifest(manifestText, manifestPath),
  };
}

/** The removed-content reader for rename pairing: each removed
 *  path's content as the snapshot's hash records it. */
function removedContentReader(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  previous: Manifest | undefined,
): (vault: string, path: string) => Promise<string | undefined> {
  return (vault, path) =>
    removedNoteContent(
      dataRoot,
      `raw/notes/${vault}/${path}`,
      env,
      previous?.vaults[vault]?.[path]?.hash,
    );
}

/** The manifest diff this run ingests: the explicit `--sources` set
 *  when given (which requires a valid snapshot), else snapshot vs
 *  current — with body-identical remove+add pairs paired as renames. */
async function computeRunDiff(
  current: Manifest,
  previous: Manifest | undefined,
  options: IngestOptions,
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  snapshotPath: string,
): Promise<{ diff: ManifestDiff; explicitDiff: ManifestDiff | undefined }> {
  const explicitSources =
    options.sources !== undefined && options.sources.length > 0
      ? [...new Set(options.sources)]
      : undefined;
  const explicitDiff =
    explicitSources === undefined
      ? undefined
      : explicitSourceDiff(current, explicitSources);

  if (explicitDiff !== undefined && previous === undefined) {
    throw new Error(
      `--sources needs a valid snapshot for this data root (${snapshotPath}): run a full ingest first`,
    );
  }

  const diff = await pairBodyIdenticalRenames(
    explicitDiff ?? diffManifests(previous ?? emptyManifest(), current),
    removedContentReader(dataRoot, env, previous),
    (vault, path) =>
      readFile(join(options.rawDir, "notes", vault, path), "utf8").catch(
        () => undefined,
      ),
  );

  return { diff, explicitDiff };
}

/** The run's mode and removed-source count: first run full, removals
 *  expunge, everything else incremental. */
function resolveRunMode(
  previous: Manifest | undefined,
  diff: ManifestDiff,
): { mode: "full" | "incremental" | "expunge"; removedCount: number } {
  const removedCount = sourceCount(diff, "removed");
  const mode =
    previous === undefined
      ? "full"
      : removedCount > 0
        ? "expunge"
        : "incremental";

  return { mode, removedCount };
}

/** What composeRunPrompt needs: the resolved run mode with its
 *  prompt text, and the run's coordinates. */
interface PromptComposition {
  readonly mode: "full" | "incremental" | "expunge";
  readonly removedCount: number;
  readonly promptText: string;
  readonly promptsDir: string;
  readonly dataRoot: string;
  readonly diff: ManifestDiff;
  readonly env: NodeJS.ProcessEnv;
  readonly onProgress: (message: string) => void;
}

/** Compose the agent message and, for an expunge run, its
 *  deterministic direct set. */
async function composeRunPrompt(
  run: PromptComposition,
): Promise<{ composed: string; directSet: readonly string[] | undefined }> {
  const { mode, removedCount, promptText, promptsDir, dataRoot, diff, env } =
    run;

  if (mode !== "expunge") {
    return {
      composed: composePrompt(
        promptText,
        mode === "incremental" ? diff : undefined,
      ),
      directSet: undefined,
    };
  }

  const removedNotes = await collectRemovedNotes(dataRoot, diff, env);

  const directSet = await directSetForRemovals(
    join(dataRoot, "wiki"),
    removedNotes.map((note) => note.rawPath),
  );

  const carriesNonRemovals =
    sourceCount(diff, "added") +
      sourceCount(diff, "changed") +
      sourceCount(diff, "renamed") >
    0;
  const incrementalText = carriesNonRemovals
    ? await readPrompt(join(promptsDir, "incremental.md"))
    : undefined;
  const composed = composeExpungePrompt(
    promptText,
    diff,
    removedNotes,
    directSet,
    incrementalText,
  );

  run.onProgress(
    `wiki-ingest: expunge — ${removedCount} removed source${removedCount === 1 ? "" : "s"}; direct set: ${directSet.map((page) => `wiki/${page}`).join(", ")}`,
  );

  return { composed, directSet };
}

/** Start the agent liveness heartbeat; the caller clears it when the
 *  agent settles. */
function startHeartbeat(beat: {
  mode: "full" | "incremental" | "expunge";
  now: () => Date;
  intervalMs: number | undefined;
  onProgress: (message: string) => void;
}): ReturnType<typeof setInterval> {
  const agentStartedAt = beat.now().getTime();

  return setInterval(() => {
    const elapsed = formatDuration(beat.now().getTime() - agentStartedAt);
    const label = beat.mode === "expunge" ? "expunge " : "";

    beat.onProgress(`wiki-ingest: ${label}agent still running (${elapsed})`);
  }, beat.intervalMs ?? HEARTBEAT_MS);
}

/** Write the digest of a guardrail-reverted run: no page counts, the
 *  tripped check named, the agent output kept for review. */
async function writeFailureDigest(
  digestPath: string,
  run: {
    startedAt: Date;
    mode: "full" | "incremental" | "expunge";
    promptFile: string;
    settings: AgentSettings;
    diff: ManifestDiff;
    agentOutput: string;
    failure: GuardrailFailure;
    explicitDiff: ManifestDiff | undefined;
  },
): Promise<void> {
  const { failure } = run;

  await writeFile(
    digestPath,
    formatDigest({
      startedAt: run.startedAt,
      mode: run.mode,
      promptFile: run.promptFile,
      settings: run.settings,
      diff: run.diff,
      pages: {
        created: [],
        updated: [],
        deleted: [],
        unavailable: `run reverted — guardrail check ${failure.check} (${failure.name}) tripped`,
      },
      directSet: undefined,
      agentOutput: run.agentOutput,
      unverifiedFrontier: [],
      guardrailFailure: failure,
      ...(run.explicitDiff !== undefined && { explicitSources: true }),
    }),
    "utf8",
  );
}

/** Advance the manifest snapshot — never for a scoped `--sources`
 *  run, whose manifest diff stays pending. */
async function writeSnapshotIfNeeded(
  explicitDiff: ManifestDiff | undefined,
  snapshotPath: string,
  current: Manifest,
  dataRoot: string,
): Promise<void> {
  if (explicitDiff !== undefined) {
    return;
  }

  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeManifest(snapshotPath, current, { snapshotFor: dataRoot });
}

/** Post-run hook (issue #73): refresh the static dashboard after the
 *  digest and snapshot — the dashboard reflects the last good state,
 *  so a failure path (revert, agent error) never regenerates it. A
 *  refresh failure must not fail the run: the dashboard is derived. */
async function refreshDashboard(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  onProgress: (message: string) => void,
): Promise<void> {
  try {
    const dashboardPath = await writeDashboard(dataRoot, {
      env,
      now,
      warn: (message) => onProgress(`wiki-ingest: WARNING — ${message}`),
    });

    onProgress(`wiki-ingest: dashboard refreshed at ${dashboardPath}`);
  } catch (error) {
    onProgress(
      `wiki-ingest: WARNING — dashboard refresh failed (${errorMessage(error)}); the previous dashboard stays`,
    );
  }
}

/**
 * One headless ingest run. The snapshot is written only after a
 * successful agent run without --sources, so a failure retries the
 * same sources next time instead of silently skipping them; a
 * scoped run never writes it, so pending manifest changes stay
 * pending. A manifest diff with removed
 * entries routes to the expunge flow (issue #65); removed entries that
 * pair with an addition by equal full-file hash or identical body
 * text are renames and never route there (issue #143).
 */
export async function runWikiIngest(
  options: IngestOptions,
): Promise<IngestResult> {
  const { env, now, onProgress } = runContext(options);
  const settings = await loadAgentSettings(options.settingsPath);

  onProgress(`wiki-ingest: raw dir ${options.rawDir}`);

  const { dataRoot, current } = await readRunManifest(options.rawDir);
  const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_FILENAME);
  const legacySnapshotPath = join(options.outputsDir, SNAPSHOT_FILENAME);

  await ensureSnapshotIgnored(dataRoot, onProgress);
  await ensureDashboardIgnored(dataRoot, onProgress);
  await adoptLegacySnapshot(legacySnapshotPath, snapshotPath, onProgress);
  await warnTrackedIgnored(dataRoot, env, onProgress);

  const previous = await readSnapshot(snapshotPath, dataRoot, onProgress);
  const { diff, explicitDiff } = await computeRunDiff(
    current,
    previous,
    options,
    dataRoot,
    env,
    snapshotPath,
  );

  if (diff.empty) {
    const reason = "no changed sources since the last ingest; nothing to do";

    onProgress(reason);

    return { status: "skipped", reason };
  }

  const { mode, removedCount } = resolveRunMode(previous, diff);
  const promptFile = promptFileFor(mode);
  const promptText = await readPrompt(join(options.promptsDir, promptFile));
  const { composed, directSet } = await composeRunPrompt({
    mode,
    removedCount,
    promptText,
    promptsDir: options.promptsDir,
    dataRoot,
    diff,
    env,
    onProgress,
  });

  const args = agentArgs(settings, composed);
  const runAgent = options.runAgent ?? spawnAgent;
  const pre = await capturePreRunState(dataRoot, env);

  onProgress(
    `wiki-ingest: mode ${mode}, invoking agent: ${formatAgentInvocation(settings)}`,
  );

  const heartbeat = startHeartbeat({
    mode,
    now,
    intervalMs: options.heartbeatMs,
    onProgress,
  });

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
    await writeFailureDigest(digestPath, {
      startedAt,
      mode,
      promptFile: `prompts/${promptFile}`,
      settings,
      diff,
      agentOutput: stdout,
      failure,
      explicitDiff,
    });

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
    ...(explicitDiff !== undefined && { explicitSources: true }),
  };
  const digest = formatDigest(run);

  await writeFile(digestPath, digest, "utf8");
  await writeSnapshotIfNeeded(explicitDiff, snapshotPath, current, dataRoot);
  await refreshDashboard(dataRoot, env, now, onProgress);

  return { status: "ran", mode, digestPath, digest, pages, diff };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [<raw-dir>]

Run the wiki agent headless over the sources that changed since the
last ingest, then write a per-run digest (guide §18, issue #11).

Flow: read the raw manifest, diff it against the snapshot from the
previous successful run (<dataRoot>/outputs/last-ingested-manifest.json
— the data repo's outputs/, not this repo's; a legacy snapshot in
this repo's outputs/ is adopted into the data repo on first run), pick
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

Before the agent runs, a pre-flight check lists tracked files that
also match an ignore rule — gitignore does not apply to tracked
files, so such a rule covers nothing and an external writer (an open
Obsidian) would trip guardrail 1 — as one yellow WARNING per file
with its fix (git rm --cached <path>); a signal, not a gate.

Switches and arguments:
  --settings <path>  Agent settings file. Default: the repo's
                     settings.yml — command, model, provider, and reasoning
                     level, passed to the agent as --model/--thinking;
                     provider is optional and passed as --provider when set.
                     isolate (true by default, false to opt out) adds the
                     pi isolation flags --no-context-files --no-extensions
                     --no-skills so global agent config cannot leak into
                     spawned runs (issue #118).
  --outputs <dir>    Where the run digest (runs/<timestamp>.md) goes.
                     Default: the repo's outputs/. The manifest snapshot
                     always lives in the data repo's outputs/ and is not
                     moved by this switch (issue #112).
  --timeout <secs>   Kill the agent run after this many seconds and
                     fail it; the snapshot stays untouched. Default:
                     1800 (30 minutes).
  --sources <vault/path>
                     Scoped re-ingest of explicit sources (issue #133):
                     re-open exactly these sources against the existing
                     wiki — the recovery affordance for a wiki that is
                     complete but under-filed. Repeatable; paths are
                     exact manifest paths (<vault name>/<vault-relative
                     path>), no globbing, no substring
                     matching — an unknown path is an error naming it.
                     Duplicates dedupe; the list sorts. The explicit
                     list replaces the manifest diff (every path a \`~\`
                     changed line), forces prompts/incremental.md, and
                     bypasses the no-change skip. Never advances the
                     snapshot: the manifest diff stays pending for the
                     next ordinary run, so the scoped run stays
                     repeatable. Requires a valid
                     manifest snapshot for this data root; a missing or
                     foreign-stamped snapshot is an error:
                     run a full ingest first. Never touches raw/ or
                     the vault.
  -h, --help         Print this help and exit; no side effects.
  <raw-dir>          raw/ directory holding manifest.json. Default:
                     <dataRoot>/raw from sync.json, otherwise the
                     repo's own raw/.

What it writes:
  - wiki pages, by the agent, in the data repo (never raw/);
  - <dataRoot>/outputs/last-ingested-manifest.json — the manifest
    snapshot the next run diffs against (only after a successful
    agent run without --sources), stamped with its data repo root: a snapshot stamped
    for another instance — or an unstamped legacy one — is ignored
    with a loud warning and the run falls back to full mode (issue
    #95). A pre-#112 snapshot in this repo's outputs/ is adopted
    (copied) into the data repo when the data repo has none (issue
    #112);
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
and exits 0 — unless --sources is present: the explicit list is the
change set even when the snapshot matches the manifest. A digest is labeled expunge when the run purged deleted
sources: it carries the direct-set preview, a deleted wiki-pages
category, and the agent's threshold decision. On a terminal (TTY, color enabled) the agent run shows
one animated status line - a braille spinner plus the elapsed time -
rewritten in place; piped, redirected, CI, or NO_COLOR runs get one
plain heartbeat line per 60 seconds instead. A run that fails or
exceeds the timeout still runs the guardrails, exits 1, and leaves
the snapshot untouched, so the next run retries the same sources. Live progress
goes to stderr; the digest goes to stdout. Scheduling is #14.`;

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-ingest", message);
}

/** A stderr progress surface: plain lines, or one animated line. */
export interface ProgressSink {
  render(message: string): void;
  end(): void;
}

export interface ProgressTones {
  /** Routine progress lines. */
  readonly dim: (text: string) => string;
  /** WARNING-severity lines. */
  readonly yellow: (text: string) => string;
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
  tones: ProgressTones,
  heartbeatPrefix: string | readonly string[] = AGENT_HEARTBEAT_PREFIX,
): ProgressSink {
  const prefixes =
    typeof heartbeatPrefix === "string" ? [heartbeatPrefix] : heartbeatPrefix;
  const styled = (message: string) =>
    isWarning(message) ? tones.yellow(message) : tones.dim(message);

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

/** The value-taking flags (`--settings`, `--outputs`, `--timeout`)
 *  with their consumed argument indexes. */
function readFlagValues(args: readonly string[]): {
  values: Map<string, string | undefined>;
  consumed: Set<number>;
} {
  return sharedReadFlagValues(["--settings", "--outputs", "--timeout"], args);
}

/** Every `--sources <path>` pair's value (a missing final value
 *  surfaces as undefined and fails validation); also marks the
 *  consumed indexes so the values are never read as positionals. */
function readSourcesArgs(
  args: readonly string[],
  consumed: Set<number>,
): (string | undefined)[] {
  const sourcesRaw: (string | undefined)[] = [];

  for (const [index, arg] of args.entries()) {
    if (arg !== "--sources" || consumed.has(index)) {
      continue;
    }

    consumed.add(index);
    consumed.add(index + 1);
    sourcesRaw.push(args[index + 1]);
  }

  return sourcesRaw;
}

/** Positional args after flag consumption, or the unknown-option
 *  usage error that stops the run. */
function collectPositional(
  args: readonly string[],
  consumed: ReadonlySet<number>,
): { positional: string[]; error: string | undefined } {
  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (consumed.has(index)) {
      continue;
    }

    if (arg.startsWith("-")) {
      return { positional, error: `unknown option ${JSON.stringify(arg)}` };
    }

    positional.push(arg);
  }

  return { positional, error: undefined };
}

/** Run the ingest with the parsed CLI state and print the outcome;
 *  errors print red and set the exit code. */
async function runCliIngest(parsed: {
  values: Map<string, string | undefined>;
  positional: readonly string[];
  sources: readonly string[];
  settingsPath: string;
  heartbeatMs: number | undefined;
  sink: ProgressSink;
}): Promise<void> {
  const timeoutArg = parsed.values.get("--timeout");

  try {
    const config = await loadSyncConfig(join(repoRoot, "sync.json"), homedir());
    const rawDir =
      parsed.positional[0] ?? resolveRawDir(config.dataRoot, repoRoot);
    const result = await runWikiIngest({
      settingsPath: parsed.settingsPath,
      rawDir,
      outputsDir: parsed.values.get("--outputs") ?? join(repoRoot, "outputs"),
      promptsDir: join(repoRoot, "prompts"),
      sources: parsed.sources,
      timeoutMs:
        timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
      heartbeatMs: parsed.heartbeatMs,
      onProgress: parsed.sink.render,
    });

    parsed.sink.end();

    if (result.status === "skipped") {
      console.log(`wiki-ingest: ${result.reason}`);

      return;
    }

    console.log(result.digest);
  } catch (error) {
    parsed.sink.end();
    console.error(colors().red(`wiki-ingest: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/** wiki-ingest entry point: `wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [<raw-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const { values, consumed } = readFlagValues(args);
  const sourcesRaw = readSourcesArgs(args, consumed);
  const { positional, error } = collectPositional(args, consumed);

  if (error !== undefined) {
    fail(error);

    return;
  }

  if (positional.length > 1) {
    fail(`expected at most one <raw-dir> argument, got ${positional.length}`);

    return;
  }

  const usageError = flagValueError(values, sourcesRaw);

  if (usageError !== undefined) {
    fail(usageError);

    return;
  }

  const settingsPath =
    values.get("--settings") ?? join(repoRoot, "settings.yml");

  const animated = canAnimate(process.stderr.isTTY === true, process.env);
  const sink = createAgentProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    colors(),
  );

  await runCliIngest({
    values,
    positional,
    sources: sourcesRaw as string[],
    settingsPath,
    heartbeatMs: animated ? 100 : undefined,
    sink,
  });
}

/* v8 ignore next: covered only under direct `node src/ingest/wiki-ingest.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-ingest");
