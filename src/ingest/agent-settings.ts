import { readFile } from "node:fs/promises";
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
export function isolationLabel(settings: AgentSettings): string {
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
