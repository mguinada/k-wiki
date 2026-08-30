import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "../sync/config.ts";
import { unquote } from "../wiki/pages.ts";

/**
 * The agent settings (settings.yml): the AgentSettings type, the
 * YAML-subset parser (loadAgentSettings/parseSettings), and the
 * non-interactive agent argv builders (agentArgs,
 * formatAgentInvocation). Shared by wiki-ingest, wiki-sync, and
 * wiki-query (extracted from wiki-ingest.ts, issue #129).
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
  /** Whitelisted skill dirs for isolated runs (issue #144),
   *  loaded additively via `--skill` even under `--no-skills`.
   *  Entries are resolved against the settings file's directory
   *  (with `~` expansion) by loadAgentSettings; ignored when
   *  `isolate: false`. */
  readonly isolateSkills?: readonly string[];
  /** Whitelisted extension sources for isolated runs (issue #144),
   *  loaded additively via `-e` even under `--no-extensions` — a
   *  path, `npm:<package>`, or `git:<repo>`; each entry is a
   *  deliberate trust grant. Ignored when `isolate: false`. */
  readonly isolateExtensions?: readonly string[];
  /** Domain wiki dirs for the cycle's crosslink audit (wiki-sync,
   *  issue #96); undefined leaves the stage out entirely. Paths are
   *  as written — `~` expands at use, like every settings value. */
  readonly secondBrainDomains?: readonly string[];
}

const REQUIRED_KEYS = ["command", "model", "reasoning"] as const;
const OPTIONAL_KEYS = ["provider", "isolate"] as const;
const DOMAIN_KEY = "secondBrain.domains";
const SKILLS_KEY = "isolate.skills";
const EXTENSIONS_KEY = "isolate.extensions";
const LIST_KEYS = [DOMAIN_KEY, SKILLS_KEY, EXTENSIONS_KEY] as const;
const SETTING_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS] as const;

type SettingKey = (typeof SETTING_KEYS)[number];
type ListKey = (typeof LIST_KEYS)[number];

/** The items of a list-valued setting: an optional `[...]` wrapper,
 *  then comma-separated values (each optionally quoted). Empty
 *  items are dropped in any position (issue #144). */
function parseListItems(value: string): string[] {
  const list = value.replace(/^\[/, "").replace(/\]$/, "");

  return list
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== "");
}

/** One parsed settings line: skipped, one list-valued key,
 *  or one scalar setting. */
type ParsedSettingLine =
  | { readonly kind: "skip" }
  | { readonly kind: "list"; readonly key: ListKey; readonly value: string }
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

  if ((LIST_KEYS as readonly string[]).includes(key)) {
    return { kind: "list", key: key as ListKey, value };
  }

  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `invalid agent settings at ${origin}: unknown setting ${JSON.stringify(key)}`,
    );
  }

  return { kind: "setting", key: key as SettingKey, value };
}

/** Record one list-valued setting; a second one is an error.
 *  `secondBrain.domains` needs at least one dir; the isolate
 *  whitelist keys allow an empty explicit list (issue #144). */
function recordList(
  lists: Partial<Record<ListKey, readonly string[]>>,
  key: ListKey,
  value: string,
  origin: string,
): readonly string[] {
  if (lists[key] !== undefined) {
    throw new Error(
      `invalid agent settings at ${origin}: duplicate setting ${JSON.stringify(key)}`,
    );
  }

  const items = parseListItems(value);

  if (key === DOMAIN_KEY && items.length === 0) {
    throw new Error(
      `invalid agent settings at ${origin}: setting ${JSON.stringify(DOMAIN_KEY)} needs at least one wiki dir`,
    );
  }

  return items;
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

/** The AgentSettings the parsed map and lists describe. */
function finalizeSettings(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
): AgentSettings {
  const provider = values.get("provider");
  const isolate = values.get("isolate");

  return {
    command: values.get("command") ?? "",
    model: values.get("model") ?? "",
    reasoning: values.get("reasoning") ?? "",
    ...(provider !== undefined && { provider }),
    ...(isolate !== undefined && { isolate: isolate === "true" }),
    ...(lists[DOMAIN_KEY] !== undefined && {
      secondBrainDomains: lists[DOMAIN_KEY],
    }),
    ...(lists[SKILLS_KEY] !== undefined && {
      isolateSkills: lists[SKILLS_KEY],
    }),
    ...(lists[EXTENSIONS_KEY] !== undefined && {
      isolateExtensions: lists[EXTENSIONS_KEY],
    }),
  };
}

/**
 * Parse the settings file: a YAML subset of top-level `key: value`
 * scalars, `#` comments on their own line or trailing the value, and
 * optionally quoted values — plus the list-valued keys
 * `secondBrain.domains`, `isolate.skills`, and `isolate.extensions`.
 * Anything else (nesting, other lists) is rejected so a typo cannot
 * silently change the agent configuration.
 */
export function parseSettings(text: string, origin: string): AgentSettings {
  const values = new Map<SettingKey, string>();
  const lists: Partial<Record<ListKey, readonly string[]>> = {};

  for (const rawLine of text.split("\n")) {
    const parsed = parseSettingLine(rawLine, origin);

    if (parsed.kind === "skip") {
      continue;
    }

    if (parsed.kind === "list") {
      lists[parsed.key] = recordList(lists, parsed.key, parsed.value, origin);
    } else {
      recordSetting(values, parsed.key, parsed.value, origin);
    }
  }

  validateSettings(values, origin);

  return finalizeSettings(values, lists);
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

/** The whitelisted `--skill`/`-e` flags of an isolated run
 *  (issue #144): additive even under the `--no-*` flags, so exactly
 *  the named entries load. Empty with `isolate: false`. */
function whitelistFlags(settings: AgentSettings): string[] {
  if (settings.isolate === false) {
    return [];
  }

  return [
    ...(settings.isolateSkills ?? []).flatMap((skill) => ["--skill", skill]),
    ...(settings.isolateExtensions ?? []).flatMap((source) => ["-e", source]),
  ];
}

/** The non-interactive agent argv (issue #118): the isolation flags
 *  (unless the operator opted out with `isolate: false`), then the
 *  whitelisted `--skill`/`-e` entries (issue #144), then the
 *  settings' provider, model, and reasoning, with the prompt as the
 *  `--print` payload. With `isolate: false` the argv is
 *  byte-identical to the pre-isolation one — whitelist keys
 *  ignored. */
export function agentArgs(settings: AgentSettings, prompt: string): string[] {
  return [
    ...(settings.isolate === false
      ? []
      : [...ISOLATION_FLAGS, ...whitelistFlags(settings)]),
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
 *  lines (issues #118, #144): `isolated` (plus the whitelist
 *  counts) unless the operator opted out. */
export function isolationLabel(settings: AgentSettings): string {
  if (settings.isolate === false) {
    return "not isolated";
  }

  const skills = settings.isolateSkills?.length ?? 0;
  const extensions = settings.isolateExtensions?.length ?? 0;
  const parts = [
    ...(skills > 0 ? [`+${skills} skill${skills === 1 ? "" : "s"}`] : []),
    ...(extensions > 0
      ? [`+${extensions} extension${extensions === 1 ? "" : "s"}`]
      : []),
  ];

  return parts.length > 0 ? `isolated ${parts.join(" ")}` : "isolated";
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

/** Context for loadAgentSettings: where warnings go and where
 *  `npm:` extension sources must already be installed (pi's install
 *  root). Defaults: no warnings, ~/.pi/agent. */
export interface LoadAgentSettingsContext {
  /** Receives one WARNING line per absent whitelist entry. */
  readonly onProgress?: ((message: string) => void) | undefined;
  /** pi's install root for `npm:` extension pre-flights; default
   *  ~/.pi/agent (issue #144). */
  readonly piInstallRoot?: string | undefined;
}

/** Whether a filesystem path exists (stat succeeds on anything:
 *  file, dir, symlink). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

/** The `npm:<package>` dir under pi's install root. */
function npmExtensionDir(source: string, piInstallRoot: string): string {
  return join(piInstallRoot, "npm", "node_modules", source.slice(4));
}

/** Resolve skill entries against the settings file's directory,
 *  with `~` expansion (issue #144): the agent spawns with
 *  cwd = the data repo, so cwd-relative paths would silently miss. */
function resolveSkillPaths(
  settings: AgentSettings,
  settingsDir: string,
): AgentSettings {
  if (settings.isolateSkills === undefined) {
    return settings;
  }

  return {
    ...settings,
    isolateSkills: settings.isolateSkills.map((entry) =>
      resolve(settingsDir, expandHome(entry)),
    ),
  };
}

/** What one isolate.extensions entry is and how it pre-flights:
 *  `check` is the path to stat (undefined = trusted passthrough,
 *  used for `git:` sources), `value` the argv entry, `missingName`
 *  and `reason` the WARNING wording. */
interface ExtensionEntry {
  readonly check: string | undefined;
  readonly value: string;
  readonly missingName: string;
  readonly reason: string;
}

/** Classify one extension source (issue #144): `npm:<package>`
 *  installs under pi's root, `git:<repo>` cannot be verified offline
 *  and passes through (pi fails loudly when the clone fails),
 *  anything else is a path resolved against the settings dir
 *  (with `~` expansion, like skill entries). */
function extensionEntry(
  source: string,
  settingsDir: string,
  piInstallRoot: string,
): ExtensionEntry {
  if (source.startsWith("npm:")) {
    return {
      check: npmExtensionDir(source, piInstallRoot),
      value: source,
      missingName: source,
      reason: "not installed under the pi install root",
    };
  }

  if (source.startsWith("git:")) {
    return {
      check: undefined,
      value: source,
      missingName: source,
      reason: "not found",
    };
  }

  const resolved = resolve(settingsDir, expandHome(source));

  return {
    check: resolved,
    value: resolved,
    missingName: resolved,
    reason: "not found",
  };
}

/** Pre-flight the whitelisted skills: keep the present entries, one
 *  WARNING per absent one (issue #144). */
async function preflightSkills(
  skills: readonly string[],
  warn: (message: string) => void,
): Promise<string[]> {
  const kept: string[] = [];

  for (const entry of skills) {
    if (await pathExists(entry)) {
      kept.push(entry);
    } else {
      warn(
        `WARNING — isolate.skills entry ${JSON.stringify(entry)} not found; omitted`,
      );
    }
  }

  return kept;
}

/** Pre-flight the whitelisted extensions: keep the present entries,
 *  one WARNING per absent one (issue #144). */
async function preflightExtensions(
  sources: readonly string[],
  settingsDir: string,
  piInstallRoot: string,
  warn: (message: string) => void,
): Promise<string[]> {
  const kept: string[] = [];

  for (const source of sources) {
    const entry = extensionEntry(source, settingsDir, piInstallRoot);

    if (entry.check === undefined || (await pathExists(entry.check))) {
      kept.push(entry.value);
    } else {
      warn(
        `WARNING — isolate.extensions entry ${JSON.stringify(entry.missingName)} ${entry.reason}; omitted`,
      );
    }
  }

  return kept;
}

/** Pre-flight the isolation whitelist (issue #144): a missing entry
 *  warns and is omitted — the run proceeds without it. pi hard-errors
 *  on an unresolvable `-e npm:…` source (verified against pi
 *  0.84.4: it tries an on-demand npm install into a temp prefix and
 *  crashes when that fails), so `npm:` sources are checked against
 *  pi's install root; path entries are stat'ed. `git:` sources pass
 *  through — they cannot be verified offline, and pi fails loudly
 *  when the clone fails. Ignored entirely with `isolate: false`. */
async function preflightWhitelist(
  settings: AgentSettings,
  context: LoadAgentSettingsContext,
  settingsDir: string,
): Promise<AgentSettings> {
  if (settings.isolate === false) {
    return settings;
  }

  const warn = context.onProgress ?? (() => {});
  const piInstallRoot =
    context.piInstallRoot ?? join(homedir(), ".pi", "agent");
  const skills = await preflightSkills(settings.isolateSkills ?? [], warn);
  const extensions = await preflightExtensions(
    settings.isolateExtensions ?? [],
    settingsDir,
    piInstallRoot,
    warn,
  );

  return {
    ...settings,
    ...(settings.isolateSkills !== undefined && { isolateSkills: skills }),
    ...(settings.isolateExtensions !== undefined && {
      isolateExtensions: extensions,
    }),
  };
}

/** Read and parse the agent settings file; missing values are errors.
 *  Whitelist skill paths resolve against the settings file's
 *  directory and every whitelist entry is pre-flighted (absent
 *  entries warn and drop, issue #144). */
export async function loadAgentSettings(
  path: string,
  context: LoadAgentSettingsContext = {},
): Promise<AgentSettings> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read agent settings at ${path}`, { cause });
  }

  const settingsDir = dirname(path);
  const settings = resolveSkillPaths(parseSettings(text, path), settingsDir);

  return preflightWhitelist(settings, context, settingsDir);
}
