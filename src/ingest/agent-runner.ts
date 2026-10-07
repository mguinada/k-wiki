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
 * module also carries the shared whitelist pre-flight and pi's
 * install-root resolution — skill whitelists are a capability of
 * both lanes (pi `--skill` dirs, codex managed-home symlinks),
 * `-e` extension sources are pi-only, and the settings loader in
 * agent-settings.ts applies the pre-flight to every parse.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathExists, pluralized } from "../cli/shared.ts";
import {
  type ParsedWebReport,
  parseAgentJsonStream,
  parseCodexReport,
} from "../query/web-report.ts";
import { expandHome } from "../sync/config.ts";
import type {
  AgentInvocation,
  AgentSettings,
  InvocationOptions,
} from "./agent-settings.ts";

/** The data-repository context a runner needs for a concrete CLI invocation. */
export interface RunnerContext {
  readonly root: string;
}

/** The per-agent Runner adapter (issue #434): everything the
 *  pipeline may assume about a coding-agent CLI, named here. */
export interface AgentRunner {
  /** The settings `agent:` key the adapter serves. */
  readonly id: string;

  /** The spawn argv for one non-interactive run (the ingest, lint,
   *  and propose shape) — ambient isolation, whitelist, provider
   *  identity; pi carries the prompt payload here, codex on stdin. */
  args(
    settings: AgentSettings,
    prompt: string,
    context?: RunnerContext,
  ): readonly string[];

  /** The query core phase's argv: ambient isolation, identity —
   *  never the whitelist (the query spawn grants nothing beyond its
   *  own phase-2 argv); the prompt rides argv (pi) or stdin (codex). */
  answerArgs(
    settings: AgentSettings,
    prompt: string,
    context?: RunnerContext,
  ): readonly string[];

  /** The query enrichment phase's argv: the lane's ambient isolation,
   *  web posture, and identity — pi's extension grant and JSON
   *  output mode; codex's exec shape (the live web search rides the
   *  managed home runnerEnv builds for this spawn). The prompt rides
   *  argv (pi) or stdin (codex). */
  webEnrichArgs(
    settings: AgentSettings,
    composed: string,
    context?: RunnerContext,
  ): readonly string[];

  /** The enrichment run's output contract: the reply shape the
   *  lane's report parse reads, as the sentence the enrichment
   *  prompt's `Output contract:` line carries. */
  webOutputContract(): string;

  /** The enrichment run's output, parsed: the final text plus the
   *  recorded web calls. The adapter reads its own output language —
   *  pi's `--mode json` event stream, codex's report contract. A
   *  run output that cannot yield a contract-shaped report throws
   *  the named failure. */
  parseWebReport(stdout: string, now: () => Date): ParsedWebReport;

  /** Prompt bytes for stdin. pi carries its prompt in argv; Codex reads stdin. */
  stdin(prompt: string): string | undefined;

  /** The invocation descriptor for one run: the structured fields
   *  the rendering site formats (issue #434). */
  invocation(
    settings: AgentSettings,
    options?: InvocationOptions,
  ): AgentInvocation;

  /** (2) The capability manifest: what this agent can do, as data
   *  and probes the pipeline routes through instead of hardcoding. */
  readonly capabilities: {
    /** The web policy: the query-only grant, as the display segment
     *  the progress line names (pi's argv grant; codex's
     *  managed-home posture), and whether the environment can serve
     *  the grant. `unsupportedReason` carries a lane's named
     *  refusal when it cannot serve the web grant at all — the
     *  query surface refuses `--web` before any spawn. */
    readonly web: {
      readonly grantArgs: readonly string[];
      installed(environment: NodeJS.ProcessEnv): Promise<boolean>;
      /** The named refusal reason when the lane cannot serve the
       *  web grant; undefined when it can. */
      readonly unsupportedReason?: string;
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

  /** The output file this argv captures the final report into, when
   *  the agent writes its report to a file; undefined when the run
   *  reports on stdout. The spawner reads the file after the child
   *  settles and serves it as stdout. */
  reportPath(args: readonly string[]): string | undefined;
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
 *  `--mode json` stream, which pi's report parse reads. */
export const WEB_OUTPUT_MODE = "json";

/** pi's enrichment output contract: bullets only — the audit comes
 *  from the `--mode json` event stream the wrapper parses. The
 *  sentence rides the enrichment prompt's `Output contract:` line. */
export const PI_WEB_OUTPUT_CONTRACT =
  "reply with only the enrichment bullets — no headings of your own, no sources list, no audit table; the wrapper writes those sections and computes them from the recorded tool calls.";

/** codex's enrichment output contract: bullets first, then the
 *  fenced web-audit block the wrapper parses — codex has no event
 *  stream to audit, so the report itself carries the recorded
 *  calls. The sentence rides the enrichment prompt's `Output
 *  contract:` line. */
export const CODEX_WEB_OUTPUT_CONTRACT =
  "reply with the enrichment bullets first — no headings of your own, no sources list — then close with one fenced ```k-wiki-web-audit block recording every web tool call you made, one line per call in the form `tool | target | urls`: the tool name, the query or URL the call targeted, then every URL the call surfaced, space-separated (empty when it surfaced none); the wrapper writes the artifact sections and computes them from these recorded calls.";

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

  webEnrichArgs: (settings, composed) => [
    ...(settings.isolate === false ? [] : [...ISOLATION_FLAGS]),
    "-e",
    WEB_EXTENSION_SOURCE,
    "--tools",
    WEB_TOOL_ALLOWLIST,
    ...(settings.provider ? ["--provider", settings.provider] : []),
    "--model",
    settings.model,
    "--thinking",
    settings.reasoning,
    "--mode",
    WEB_OUTPUT_MODE,
    "--print",
    composed,
  ],

  webOutputContract: () => PI_WEB_OUTPUT_CONTRACT,

  parseWebReport: (stdout) => parseAgentJsonStream(stdout),

  stdin: () => undefined,

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

  reportPath: () => undefined,
};

/** A temporary output file outside the data repo: Codex's -o report must
 * not appear as an untracked wiki change for the deterministic guardrails. */
function codexReportPath(): string {
  const path = join(tmpdir(), `k-wiki-codex-${process.pid}-${Date.now()}.txt`);

  trackManagedTemp(path);

  return path;
}

/** Per-spawn managed temp state (the Codex home, the report file):
 *  each artifact is removed when its own run settles — the shared
 *  spawner disposes exactly that run's paths — and, for an artifact
 *  whose spawn never happens, at process exit. */
const managedTempPaths = new Set<string>();

let exitSweepArmed = false;

function trackManagedTemp(path: string): void {
  managedTempPaths.add(path);

  if (!exitSweepArmed) {
    exitSweepArmed = true;
    process.once("exit", sweepManagedTempAtExit);
  }
}

/** Remove the given managed temp artifacts — one settled spawn's
 *  own managed home and report file — and drop them from the exit
 *  sweep's registry. */
export function disposeManagedTemp(
  temp: readonly string[],
  reportPath?: string | undefined,
): void {
  const paths = reportPath === undefined ? temp : [...temp, reportPath];

  for (const path of paths) {
    rmSync(path, { force: true, recursive: true });
    managedTempPaths.delete(path);
  }
}

/** Remove every managed temp artifact still registered: the
 *  process-exit backstop for artifacts whose spawn never settles. */
function sweepManagedTempAtExit(): void {
  for (const path of managedTempPaths) {
    rmSync(path, { force: true, recursive: true });
  }

  managedTempPaths.clear();
}

function codexContext(context: RunnerContext | undefined): RunnerContext {
  if (context === undefined) {
    throw new Error("codex runner needs a data-repository context");
  }

  return context;
}

/** The host auth store a managed home seeds from: the caller's
 * CODEX_HOME, else ~/.codex. The seed and the posture label share it. */
function codexSourceAuthPath(environment: NodeJS.ProcessEnv): string {
  return join(environment.CODEX_HOME ?? homedir(), "auth.json");
}

/** Codex's managed home is built per spawn. Redirecting HOME as well as
 * CODEX_HOME closes the user-scope skill-discovery path. The only linked
 * skills are the configured whitelist; auth is copied, never linked. The
 * home's `web_search` config mode is the web posture source: disabled
 * for every spawn except the query enrichment's, where the `--web`
 * opt-in runs live web search. */
function codexManagedHome(
  environment: NodeJS.ProcessEnv,
  settings: AgentSettings,
  web: boolean,
): string {
  const home = mkdtempSync(join(tmpdir(), "k-wiki-codex-home-"));

  trackManagedTemp(home);

  const skills = join(home, ".agents", "skills");

  mkdirSync(skills, { recursive: true });
  for (const skill of settings.isolateSkills ?? []) {
    const link = join(skills, basename(skill));
    symlinkSync(skill, link, "dir");
  }

  writeFileSync(
    join(home, "config.toml"),
    `web_search = "${web ? "live" : "disabled"}"\napproval_policy = "never"\n`,
  );
  const sourceAuth = codexSourceAuthPath(environment);

  if (existsSync(sourceAuth)) {
    cpSync(sourceAuth, join(home, "auth.json"));
  }

  return home;
}

/** Codex is OpenAI-native only. Its prompt is deliberately absent from argv:
 * the shared spawner feeds it on stdin and reads -o after exit. */
export const codexRunner: AgentRunner = {
  id: "codex",

  args: (settings, _prompt, context) => {
    const { root } = codexContext(context);
    return [
      "exec",
      "-C",
      root,
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "-m",
      settings.model,
      "-c",
      `model_reasoning_effort=${settings.reasoning}`,
      "-o",
      codexReportPath(),
    ];
  },

  answerArgs: (settings, prompt, context) =>
    codexRunner.args(settings, prompt, context),

  // The web grant is the managed home's `web_search = "live"`
  // posture (runnerEnv's web option), not argv: the enrichment
  // spawn's exec shape matches every codex run — prompt on stdin,
  // report captured with -o.
  webEnrichArgs: (settings, prompt, context) =>
    codexRunner.args(settings, prompt, context),

  webOutputContract: () => CODEX_WEB_OUTPUT_CONTRACT,

  parseWebReport: (stdout, now) => parseCodexReport(stdout, now),

  stdin: (prompt) => prompt,

  invocation: (settings, options) => ({
    agent: "codex",
    command: options?.command ?? settings.command,
    model: settings.model,
    reasoning: settings.reasoning,
    ...(options?.posture === false
      ? {}
      : {
          posture: `managed-home isolated${
            (settings.isolateSkills?.length ?? 0) > 0
              ? ` +${pluralized(settings.isolateSkills?.length ?? 0, "skill")}`
              : ""
          }; sandbox workspace-write; web disabled; auth ${
            existsSync(codexSourceAuthPath(process.env))
              ? "seeded"
              : "not seeded"
          }`,
        }),
  }),

  capabilities: {
    web: {
      grantArgs: ['web_search="live"'],
      installed: async () => true,
    },
    credentials: {
      defaultAuthStorePath: (home = homedir()) =>
        join(home, ".codex", "auth.json"),
    },
  },

  report: (stdout) => stdout,

  reportPath: (args) => {
    const index = args.findIndex(
      (arg) => arg === "-o" || arg === "--output-last-message",
    );

    return index < 0 ? undefined : args[index + 1];
  },
};

/** One spawned run's managed environment: the env the child
 *  inherits and the managed temp paths the run owns — the shared
 *  spawner removes exactly these, with the report file, when the
 *  run settles. */
export interface ManagedEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly temp: readonly string[];
}

/** Build Codex's managed environment after settings parsing. The web
 * option switches the managed home's `web_search` posture to live —
 * the query enrichment's `--web` opt-in; every other spawn stays
 * disabled. */
function codexEnv(
  environment: NodeJS.ProcessEnv,
  settings: AgentSettings,
  web: boolean,
): ManagedEnv {
  const home = codexManagedHome(environment, settings, web);

  return {
    env: { ...environment, CODEX_HOME: home, HOME: home },
    temp: [home],
  };
}

/** The environment one spawned run inherits (issue #434): pi passes
 * the caller's environment through untouched; Codex spawns inside a
 * fresh managed home, returned with the env as the run's temp for
 * the spawner's settle disposal. The one resolver every spawn site
 * goes through — the pipeline never spells agent specifics itself.
 * The web option is the query enrichment's opt-in: a codex lane
 * serves it with the managed home's live web search posture. */
export function runnerEnv(
  settings: AgentSettings,
  environment: NodeJS.ProcessEnv,
  options?: { readonly web?: boolean },
): ManagedEnv {
  if ((settings.agent ?? piRunner.id) !== codexRunner.id) {
    return { env: environment, temp: [] };
  }

  return codexEnv(environment, settings, options?.web === true);
}

/** The known agent ids, for the settings validator's named errors. */
export const AGENT_IDS: readonly string[] = [piRunner.id, codexRunner.id];

/** The adapter for one `agent:` settings value: a named error for
 *  anything unknown — a typo must never silently change the agent. */
export function runnerForAgent(id: string): AgentRunner {
  if (id === piRunner.id) {
    return piRunner;
  }

  if (id === codexRunner.id) {
    return codexRunner;
  }

  throw new Error(
    `unknown agent ${JSON.stringify(id)} — known agents: ${AGENT_IDS.join(", ")}`,
  );
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
