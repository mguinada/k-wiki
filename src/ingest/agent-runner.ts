/**
 * The per-agent Runner adapter (issue #434): the seam between the
 * wiki pipeline and the coding-agent CLI. One implementation per
 * supported agent owns that agent's flag language — argv and env
 * building from settings, a capability manifest (isolation
 * mechanism, whitelist categories, web policy, credential probe),
 * and the normalization of the agent's stdout into the report the
 * guardrails consume. The pipeline resolves the adapter through
 * runnerFor(settings) (agent-settings.ts, beside the `agent:` key
 * it dispatches on) and never spells agent flags itself.
 *
 * The pi adapter is byte-identical to the pre-refactor wiring: the
 * golden snapshots in tests/ingest/agent-runner.test.ts, captured
 * from the pre-refactor code, pin flags, order, and values. The
 * module also carries pi's whitelist pre-flight and install-root
 * resolution — the whitelist is a pi capability (skill dirs, `-e`
 * extension sources under pi's install root), applied by the
 * settings loader in agent-settings.ts.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathExists, pluralized } from "../cli/shared.ts";
import { expandHome } from "../sync/config.ts";
import type {
  AgentInvocation,
  AgentSettings,
  InvocationOptions,
} from "./agent-settings.ts";

/** The agent identity the enrichment argv builds from: the
 *  settings' own fields, the whole loaded settings object in the
 *  caller's hand. */
export type RunnerIdentity = Pick<
  AgentSettings,
  "command" | "model" | "reasoning" | "provider" | "isolate"
>;

/** The per-agent Runner adapter (issue #434): everything the
 *  pipeline may assume about a coding-agent CLI, named here. */
export interface AgentRunner {
  /** The settings `agent:` key the adapter serves. */
  readonly id: string;

  /** The spawn argv for one non-interactive run — ambient isolation,
   *  whitelist, provider identity, prompt payload (the ingest, lint,
   *  and propose shape). */
  args(settings: AgentSettings, prompt: string): readonly string[];

  /** The query core phase's argv: ambient isolation, identity,
   *  prompt — never the whitelist (the query spawn grants nothing
   *  beyond its own phase-2 argv). */
  answerArgs(settings: AgentSettings, prompt: string): readonly string[];

  /** The query enrichment phase's argv: ambient isolation, the web
   *  grant, the JSON output mode, identity, prompt. */
  webEnrichArgs(identity: RunnerIdentity, composed: string): readonly string[];

  /** The environment a spawned run inherits: pi passes the caller's
   *  environment through untouched. */
  env(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /** The invocation descriptor for one run: the structured fields
   *  the rendering site formats (issue #434). */
  invocation(
    settings: AgentSettings,
    options?: InvocationOptions,
  ): AgentInvocation;

  /** (2) The capability manifest: what this agent can do, as data
   *  and probes the pipeline routes through instead of hardcoding. */
  readonly capabilities: {
    /** The web policy: the query-only grant, as the argv segment the
     *  progress line names, and whether the grant's extension is
     *  installed in the judged environment. */
    readonly web: {
      readonly grantArgs: readonly string[];
      installed(environment: NodeJS.ProcessEnv): Promise<boolean>;
    };
    /** The credential probe: the on-disk auth store the agent reads
     *  by default, resolved against a home (os.homedir() when
     *  omitted — the launchd plist HOME under the scheduler). */
    readonly credentials: {
      defaultAuthStorePath(home?: string): string;
    };
  };

  /** (3) The agent's stdout into the final report the guardrails
   *  consume. Identity for pi — the reply is the report. */
  report(stdout: string): string;
}

/** The pi isolation flags (issue #118): mechanically disable every
 *  ambient configuration source — context files (AGENTS.md/CLAUDE.md
 *  discovery), extensions, skills — so a spawned run cannot inherit
 *  globally installed persona, tools, or prompts. Available since
 *  pi 0.67.4. Shared by every spawn site that must close the ambient
 *  hole, wiki-query's included. */
export const ISOLATION_FLAGS = [
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
] as const;

/** The web extension's grant is a query-only, per-run argv injection
 *  (`--web`): the shared whitelist never carries it into ingest,
 *  lint, or scoped re-ingest argv — an operator settings entry for
 *  it is dropped here, whatever its spelling. */
export const WEB_GRANT_SOURCE = "pi-web-access";

/** The web extension source, as the pi grant names it. */
export const WEB_EXTENSION_SOURCE = "npm:pi-web-access";

/** The grant width: search + fetch, pi `--tools` allowlist. */
export const WEB_TOOL_ALLOWLIST = "web_search,source_check,fetch_content";

/** The machine-readable output mode of the enrichment run: pi's
 *  `--mode json` stream, which the audit parses. */
export const WEB_OUTPUT_MODE = "json";

/** The isolation state of a spawned run, for progress and digest
 *  lines (issues #118, #144): `isolated` (plus the whitelist
 *  counts) unless the operator opted out. */
export function isolationLabel(settings: AgentSettings): string {
  if (settings.isolate === false) {
    return "not isolated";
  }

  const skills = settings.isolateSkills?.length ?? 0;
  const extensions =
    settings.isolateExtensions?.filter(
      (source) => !source.includes(WEB_GRANT_SOURCE),
    ).length ?? 0;
  const parts = [
    ...(skills > 0 ? [`+${pluralized(skills, "skill")}`] : []),
    ...(extensions > 0 ? [`+${pluralized(extensions, "extension")}`] : []),
  ];

  return parts.length > 0 ? `isolated ${parts.join(" ")}` : "isolated";
}

/** The whitelisted `--skill`/`-e` flags of an isolated run
 *  (issue #144): additive even under the `--no-*` flags, so exactly
 *  the named entries load — minus the query-only web grant, which
 *  never reaches these argv (the `--web` design). Empty with
 *  `isolate: false`. */
function whitelistFlags(settings: AgentSettings): string[] {
  if (settings.isolate === false) {
    return [];
  }

  return [
    ...(settings.isolateSkills ?? []).flatMap((skill) => ["--skill", skill]),
    ...(settings.isolateExtensions ?? [])
      .filter((source) => !source.includes(WEB_GRANT_SOURCE))
      .flatMap((source) => ["-e", source]),
  ];
}

/** pi's install root for `npm:` extension resolution: the
 *  `PI_CODING_AGENT_DIR` override when set (pi's own override),
 *  else ~/.pi/agent (issue #144). Shared with spawn sites that must
 *  pre-flight an `npm:` extension source themselves. */
export function piInstallRootFromEnv(environment: NodeJS.ProcessEnv): string {
  return expandHome(
    environment.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  );
}

/** The `npm:<package>` dir under pi's install root; pi installs
 *  under the bare package name, so any `@version` suffix in the
 *  spec is stripped (parseNpmSpec). */
export function npmExtensionDir(source: string, piInstallRoot: string): string {
  const spec = source.slice(4);
  const name = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec)?.[1] ?? spec;

  return join(piInstallRoot, "npm", "node_modules", name);
}

/** pi's on-disk auth store, resolved the way pi resolves it by
 *  default: against the cycle's HOME (os.homedir() honors the plist
 *  HOME under launchd). The scheduled plist never sets pi's
 *  PI_CODING_AGENT_DIR override, so the default location is the
 *  store the spawned agent reads; relocated installs inject the
 *  path through the probe's options. */
export function defaultAuthStorePath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "auth.json");
}

/** Whether pi-web-access is installed under the pi install root of
 *  the judged environment. */
async function webExtensionInstalled(
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return pathExists(
    npmExtensionDir(WEB_EXTENSION_SOURCE, piInstallRootFromEnv(environment)),
  );
}

/** The pi adapter: exactly today's argv, env, and spawn semantics —
 *  the golden snapshots in tests/ingest/agent-runner.test.ts pin it
 *  byte-identically. */
export const piRunner: AgentRunner = {
  id: "pi",

  args: (settings, prompt) => [
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
  ],

  answerArgs: (settings, prompt) => [
    ...(settings.isolate === false ? [] : [...ISOLATION_FLAGS]),
    ...(settings.provider ? ["--provider", settings.provider] : []),
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--print",
    prompt,
  ],

  webEnrichArgs: (identity, composed) => [
    ...(identity.isolate === false ? [] : [...ISOLATION_FLAGS]),
    "-e",
    WEB_EXTENSION_SOURCE,
    "--tools",
    WEB_TOOL_ALLOWLIST,
    ...(identity.provider ? ["--provider", identity.provider] : []),
    "--model",
    identity.model,
    "--thinking",
    identity.reasoning,
    "--mode",
    WEB_OUTPUT_MODE,
    "--print",
    composed,
  ],

  env: (environment) => environment,

  invocation: (settings, options) => ({
    agent: "pi",
    command: options?.command ?? settings.command,
    model: settings.model,
    reasoning: settings.reasoning,
    ...(settings.provider ? { provider: settings.provider } : {}),
    ...(options?.posture === false
      ? {}
      : { posture: isolationLabel(settings) }),
  }),

  capabilities: {
    web: {
      grantArgs: ["-e", WEB_EXTENSION_SOURCE, "--tools", WEB_TOOL_ALLOWLIST],
      installed: webExtensionInstalled,
    },
    credentials: {
      defaultAuthStorePath,
    },
  },

  report: (stdout) => stdout,
};

/** The known agent ids, for the settings validator's named errors. */
export const AGENT_IDS: readonly string[] = [piRunner.id];

/** The adapter for one `agent:` settings value: a named error for
 *  anything unknown — a typo must never silently change the agent. */
export function runnerForAgent(id: string): AgentRunner {
  if (id === piRunner.id) {
    return piRunner;
  }

  throw new Error(`unknown agent ${JSON.stringify(id)} — known agents: pi`);
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
    context.piInstallRoot ?? piInstallRootFromEnv(process.env);
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

/** Context for the settings load's pi whitelist pre-flight: where
 *  warnings go and where `npm:` extension sources must already be
 *  installed (pi's install root). Defaults: no warnings,
 *  ~/.pi/agent. */
export interface LoadAgentSettingsContext {
  /** Receives one WARNING line per absent whitelist entry. */
  readonly onProgress?: ((message: string) => void) | undefined;
  /** pi's install root for `npm:` extension pre-flights; defaults
   *  to `PI_CODING_AGENT_DIR` when set (pi's own override), else
   *  ~/.pi/agent (issue #144). */
  readonly piInstallRoot?: string | undefined;
}

/** The pi whitelist pre-flight the settings loader applies to every
 *  parse: skill entries resolve against the settings file's
 *  directory, then every whitelist entry is pre-flighted (absent
 *  entries warn and drop, issue #144). */
export async function preflightSettings(
  settings: AgentSettings,
  context: LoadAgentSettingsContext,
  settingsDir: string,
): Promise<AgentSettings> {
  return preflightWhitelist(
    resolveSkillPaths(settings, settingsDir),
    context,
    settingsDir,
  );
}
