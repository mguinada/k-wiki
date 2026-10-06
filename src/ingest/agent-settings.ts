/**
 * The agent settings (settings.yml): the AgentSettings type, the
 * YAML-subset parser (loadAgentSettings/parseSettings) and the one
 * invocation-line rendering site (formatInvocation over the
 * AgentInvocation descriptor, issue #434). The per-agent argv/env
 * builders and the posture builder live with the Runner adapters
 * (agent-runner.ts), resolved through runnerFor. Shared by
 * wiki-ingest, wiki-sync, and wiki-query (extracted from
 * wiki-ingest.ts, issue #129).
 */

import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { AGENT_COMMAND_ENV } from "../cli/env.ts";
import { unquote } from "../wiki/pages.ts";
import {
  AGENT_IDS,
  type AgentRunner,
  type LoadAgentSettingsContext,
  preflightSettings,
  runnerForAgent,
} from "./agent-runner.ts";

/** The agent-neutral invocation descriptor (issue #434): the
 *  structured fields one rendering site (formatInvocation, below)
 *  formats into the operator-facing "invoking agent:" line. No spawn
 *  site interpolates argv fragments into progress lines; each
 *  resolves a descriptor through its Runner adapter and renders
 *  here. */
export interface AgentInvocation {
  /** The Runner adapter serving the run: the settings `agent:` key. */
  readonly agent: string;
  /** The spawned CLI command: the launcher-resolved absolute path
   *  when the environment overrides, else the settings command. */
  readonly command: string;
  readonly model: string;
  readonly reasoning: string;
  readonly provider?: string;
  /** The isolation posture, as the line renders it: `isolated`,
   *  `isolated +N skills +M extensions`, or `not isolated`.
   *  Undefined when the surface's line omits the posture — the
   *  answer-only query spawn, a run that cannot write and needs no
   *  isolation signal. */
  readonly posture?: string;
}

/** The descriptor builder's options: the launcher's command
 *  override and whether the surface renders the posture tail. */
export interface InvocationOptions {
  /** The spawned command when the launcher resolved an override
   *  (KWIKI_AGENT_COMMAND); default: the settings command. */
  readonly command?: string | undefined;
  /** Render the isolation posture tail; default: true. */
  readonly posture?: boolean | undefined;
}

export interface AgentTarget {
  readonly provider?: string;
  readonly model: string;
}

export interface AgentSettings {
  /** Agent CLI command; run non-interactively in the data repo root. */
  readonly command: string;
  /** The Runner adapter serving this file (issue #434): the id
   *  runnerFor resolves. Default: pi — the only adapter today; an
   *  unknown value is a named settings error. */
  readonly agent?: string;
  /** Passed to the agent as `--model`; the first target's model. */
  readonly model: string;
  /** Reasoning level; passed to the agent as `--thinking`. */
  readonly reasoning: string;
  /** Passed to the agent as `--provider` when set; the first target's provider. */
  readonly provider?: string;
  /** Ordered targets for ingest fallback: Pi uses provider/model;
   *  Codex uses OpenAI model names. The wiki-sync cycle's lint stage
   *  also serves from it via the per-cycle affordability memory. */
  readonly targets?: readonly AgentTarget[];
  /** Quota pre-flight mode for unattended scheduled runs. */
  readonly quotaPreflight?: "auto" | "off" | string;
  /** False opts out of the pi isolation flags (issue #118);
   *  unset means isolated — the safe default. The opt-out is
   *  pi-only: the codex lane's managed-home isolation is
   *  structural, and `isolate: false` there is a named settings
   *  error. */
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

const REQUIRED_KEYS = ["command", "reasoning"] as const;
const OPTIONAL_KEYS = [
  "agent",
  "provider",
  "model",
  "isolate",
  "quotaPreflight",
] as const;
const DOMAIN_KEY = "secondBrain.domains";
const TARGETS_KEY = "targets";
const SKILLS_KEY = "isolate.skills";
const EXTENSIONS_KEY = "isolate.extensions";
const LIST_KEYS = [
  DOMAIN_KEY,
  SKILLS_KEY,
  EXTENSIONS_KEY,
  TARGETS_KEY,
] as const;
const SETTING_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS] as const;

type SettingKey = (typeof SETTING_KEYS)[number];
type ListKey = (typeof LIST_KEYS)[number];

function parseTarget(
  value: string,
  origin: string,
  agent: string | undefined,
): AgentTarget {
  const separator = value.indexOf("/");

  if (agent === "codex") {
    if (separator >= 0) {
      throw new Error(
        `invalid agent settings at ${origin}: codex targets must be OpenAI model names, not provider/model`,
      );
    }

    return { model: value };
  }

  if (separator < 1 || separator === value.length - 1) {
    throw new Error(
      `invalid agent settings at ${origin}: target ${JSON.stringify(value)} must be provider/model`,
    );
  }

  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}

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

/** Whether the quote at `index` can open a quoted span: the
 *  nearest preceding non-space character is `:`, `[`, or `,` (a
 *  value or list-item start), or there is none (line start) — so a
 *  mid-word apostrophe (`it's`) never starts a quoted span. */
function opensQuotedSpan(line: string, index: number): boolean {
  for (let at = index - 1; at >= 0; at--) {
    const char = line.charAt(at);

    if (!/\s/.test(char)) {
      return char === ":" || char === "[" || char === ",";
    }
  }

  return true;
}

/** Strip a trailing ` #` comment, but only outside quoted spans —
 *  a quoted value like `"my #1 model"` keeps its hash (issue #243).
 *  A `#` at the line start (full-line comment) is left for the
 *  caller's own check. */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (quote === undefined) {
      if ((char === '"' || char === "'") && opensQuotedSpan(line, index)) {
        quote = char;
      } else if (
        char === "#" &&
        index > 0 &&
        /\s/.test(line.slice(index - 1, index))
      ) {
        return line.slice(0, index - 1);
      }
    } else if (char === quote) {
      quote = undefined;
    }
  }

  return line;
}

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

  const line = stripComment(rawLine).trim();

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

  if (key === TARGETS_KEY && items.length === 0) {
    throw new Error(
      `invalid agent settings at ${origin}: setting ${JSON.stringify(TARGETS_KEY)} needs at least one target`,
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

/** The model/targets contract: exactly one of the two forms, never
 *  both — a legacy scalar beside the list would be silently inert. */
function validateTargetSettings(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
  origin: string,
): void {
  if (values.get("model") === undefined && lists[TARGETS_KEY] === undefined) {
    throw new Error(
      `invalid agent settings at ${origin}: missing setting "model" or "targets"`,
    );
  }

  if (
    lists[TARGETS_KEY] !== undefined &&
    (values.has("model") || values.has("provider"))
  ) {
    throw new Error(
      `invalid agent settings at ${origin}: setting ${JSON.stringify(TARGETS_KEY)} cannot be combined with "model"/"provider"`,
    );
  }
}

/** The scalar settings whose values come from a closed domain:
 *  each entry names the key, the predicate its value must satisfy,
 *  and the domain wording for the error. A violated domain is a
 *  named error — a typo must never silently change the agent
 *  configuration. */
const SETTING_DOMAINS: readonly (readonly [
  SettingKey,
  (value: string) => boolean,
  string,
])[] = [
  [
    "isolate",
    (value) => value === "true" || value === "false",
    "true or false",
  ],
  [
    "quotaPreflight",
    (value) => value === "auto" || value === "off" || value.includes("/"),
    "auto, off, or a CLI path",
  ],
];

/** The closed-domain scalars: a value outside its domain is a named
 *  error. */
function validateScalarDomains(
  values: Map<SettingKey, string>,
  origin: string,
): void {
  for (const [key, holds, domain] of SETTING_DOMAINS) {
    const value = values.get(key);

    if (value !== undefined && !holds(value)) {
      throw new Error(
        `invalid agent settings at ${origin}: setting ${JSON.stringify(key)} must be ${domain}, got ${JSON.stringify(value)}`,
      );
    }
  }
}

/** The agent key names a Runner adapter (issue #434): an unknown
 *  agent is a named error, not a silent fallback. */
function validateAgentSetting(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
  origin: string,
): void {
  const agent = values.get("agent");

  if (agent !== undefined && !AGENT_IDS.includes(agent)) {
    throw new Error(
      `invalid agent settings at ${origin}: unknown agent ${JSON.stringify(agent)} — known agents: ${AGENT_IDS.join(", ")}`,
    );
  }

  if (agent === "codex") {
    validateCodexSettings(values, lists, origin);
  }
}

/** The Codex lane's settings contradictions, each a named error:
 *  OpenAI models only, structural managed-home isolation, and a
 *  skill whitelist representable as managed `.agents/skills` links. */
function validateCodexSettings(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
  origin: string,
): void {
  if (values.has("provider")) {
    throw new Error(
      `invalid agent settings at ${origin}: codex runner accepts OpenAI models only; provider is unsupported`,
    );
  }

  if ((values.get("model") ?? "").includes("/")) {
    throw new Error(
      `invalid agent settings at ${origin}: codex targets must be OpenAI model names, not provider/model`,
    );
  }

  if (values.get("isolate") === "false") {
    throw new Error(
      `invalid agent settings at ${origin}: codex runner is always managed-home isolated; isolate: false is unsupported`,
    );
  }

  if ((lists[EXTENSIONS_KEY]?.length ?? 0) > 0) {
    throw new Error(
      `invalid agent settings at ${origin}: codex runner does not support extensions`,
    );
  }

  const names = new Set<string>();

  for (const skill of lists[SKILLS_KEY] ?? []) {
    const name = basename(skill);

    if (names.has(name)) {
      throw new Error(
        `invalid agent settings at ${origin}: codex isolate.skills entries must have distinct names; duplicate ${JSON.stringify(name)}`,
      );
    }

    names.add(name);
  }
}

/** After the loop: every required key present, isolate a boolean. */
function validateSettings(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
  origin: string,
): void {
  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) {
      throw new Error(
        `invalid agent settings at ${origin}: missing setting ${JSON.stringify(key)}`,
      );
    }
  }

  validateTargetSettings(values, lists, origin);
  validateScalarDomains(values, origin);
  validateAgentSetting(values, lists, origin);
}

function targetList(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
  origin: string,
): AgentTarget[] {
  const configured = lists[TARGETS_KEY];

  if (configured !== undefined) {
    return configured.map((target) =>
      parseTarget(target, origin, values.get("agent")),
    );
  }

  const provider = values.get("provider");
  const model = values.get("model") ?? "";

  return provider === undefined ? [{ model }] : [{ provider, model }];
}

function optionalListSettings(
  lists: Partial<Record<ListKey, readonly string[]>>,
): Pick<
  AgentSettings,
  "secondBrainDomains" | "isolateSkills" | "isolateExtensions"
> {
  return {
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

/** The AgentSettings the parsed map and lists describe. */
function finalizeSettings(
  values: Map<SettingKey, string>,
  lists: Partial<Record<ListKey, readonly string[]>>,
  origin: string,
): AgentSettings {
  const configuredTargets = lists[TARGETS_KEY];
  const targets = targetList(values, lists, origin);
  const primary = targets[0];

  if (primary === undefined) {
    throw new Error("agent settings need at least one target");
  }

  const isolate = values.get("isolate");
  const quotaPreflight = values.get("quotaPreflight");
  const agent = values.get("agent");

  return {
    command: values.get("command") ?? "",
    model: primary.model,
    reasoning: values.get("reasoning") ?? "",
    ...(primary.provider !== undefined && { provider: primary.provider }),
    ...(configuredTargets !== undefined && { targets }),
    ...(quotaPreflight !== undefined && { quotaPreflight }),
    ...(isolate !== undefined && { isolate: isolate === "true" }),
    ...(agent !== undefined && { agent }),
    ...optionalListSettings(lists),
  };
}

/**
 * Parse the settings file: a YAML subset of top-level `key: value`
 * scalars, `#` comments on their own line or trailing the value
 * (outside quotes), and optionally quoted values — plus the
 * list-valued keys
 * `secondBrain.domains`, `isolate.skills`, and `isolate.extensions`, plus
 * `targets` as comma-separated provider/model pairs for ingest fallback.
 * The `agent:` key names the Runner adapter (issue #434); an unknown
 * value is rejected so a typo cannot silently change the agent.
 * Anything else (nesting, other lists, legacy `model`/`provider` beside
 * `targets`) is rejected so a typo cannot silently change the agent
 * configuration.
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

  validateSettings(values, lists, origin);

  return finalizeSettings(values, lists, origin);
}

export function settingsForTarget(
  settings: AgentSettings,
  target: AgentTarget,
): AgentSettings {
  const { provider: _baseProvider, ...rest } = settings;

  return {
    ...rest,
    model: target.model,
    ...(target.provider !== undefined && { provider: target.provider }),
  };
}

export function targetLabel(target: AgentTarget): string {
  return target.provider === undefined
    ? target.model
    : `${target.provider}/${target.model}`;
}

export function agentTargets(settings: AgentSettings): readonly AgentTarget[] {
  return (
    settings.targets ?? [
      {
        ...(settings.provider !== undefined && { provider: settings.provider }),
        model: settings.model,
      },
    ]
  );
}

/** The spawn command the environment asks for (issue #399): the
 *  launcher-set absolute path when present, else undefined — the
 *  settings' own command stands. */
export function agentCommandOverride(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = environment[AGENT_COMMAND_ENV];

  return value === undefined || value === "" ? undefined : value;
}

/** The one rendering site for the operator-facing invocation line
 *  (issue #434): `<command> [--provider P] --model M --thinking T`,
 *  plus the ` (posture)` tail when the descriptor carries one. Every
 *  spawn site resolves a descriptor through its Runner adapter and
 *  renders here — no site interpolates argv fragments into progress
 *  lines itself. */
export function formatInvocation(invocation: AgentInvocation): string {
  const providerFlag = invocation.provider
    ? ` --provider ${invocation.provider}`
    : "";
  const posture =
    invocation.posture === undefined ? "" : ` (${invocation.posture})`;

  return `${invocation.command}${providerFlag} --model ${invocation.model} --thinking ${invocation.reasoning}${posture}`;
}

/** The `command [--provider P] --model M --thinking T (state)` tail
 *  the spawn sites print when invoking the agent (issue #118) — the
 *  descriptor resolved through the settings' Runner adapter, rendered
 *  by the one site. */
export function formatAgentInvocation(settings: AgentSettings): string {
  return formatInvocation(runnerFor(settings).invocation(settings));
}

/** Read and parse the agent settings file; missing values are errors.
 *  Whitelist skill paths resolve against the settings file's
 *  directory and every whitelist entry is pre-flighted (absent
 *  entries warn and drop, issue #144) — the pi Runner adapter's
 *  pre-flight (agent-runner.ts), applied to every parse. */
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

  return preflightSettings(parseSettings(text, path), context, dirname(path));
}

/** The Runner adapter the settings select (issue #434): the `agent:`
 *  key's adapter, pi by default. A named error for an unknown agent —
 *  belt and suspenders beside the parser's validation, for settings
 *  objects built programmatically. */
export function runnerFor(settings: AgentSettings): AgentRunner {
  return runnerForAgent(settings.agent ?? "pi");
}
