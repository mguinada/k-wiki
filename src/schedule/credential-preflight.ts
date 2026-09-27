/**
 * The agent-credential pre-flight for unattended scheduled cycles
 * (issue #409). The quota pre-flight (#401) verifies quota, not
 * credential availability in the environment the agent inherits —
 * under launchd that environment is the plist's {HOME,
 * PATH-minimal}, and a provider authenticated only by an env var
 * that exists solely in the interactive shell (or only in a later
 * auth-store write) is unauthenticatable there. The failure used to
 * land after the sync stage had already mutated the data repo,
 * feeding the dirty-repo refusal loop; this gate names the problem
 * instead: before any stage (the shared-writer lease included),
 * every configured target must be plausibly authenticatable in the
 * cycle's own environment — an entry for the provider in pi's
 * on-disk auth store, or, only where the caller's env provably
 * reaches the cycle (shared-writer mode spreads it into the
 * coordinator's), the provider's credential env var — or the tick
 * skips with a named reason on the quota-skip's heartbeat surface.
 *
 * A deliberately local, fail-open heuristic: the env-var name is
 * the canonical upper-snake `_API_KEY` rendering of the provider
 * id, the auth-store read is shape-checked loosely, and anything
 * the probe cannot judge (an unreadable store, unreadable settings,
 * a target without a provider) proceeds — a named skip must never
 * be produced by a blind guess. The result type mirrors the quota
 * pre-flight's so a semantically stronger probe (an upstream pi
 * auth check, a quota-axi credential report) can replace the
 * heuristic behind the same interface.
 *
 * The module also carries the scheduled cycle's pre-gate input
 * resolution (`resolveCycleInputsOrOutcome`): the folded
 * agent-and-mode lookup whose shared-writer result scopes this
 * gate's env-var clause.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { readTextIfExists } from "../cli/shared.ts";
import {
  type AgentSettings,
  type AgentTarget,
  agentTargets,
  loadAgentSettings,
  targetLabel,
} from "../ingest/agent-settings.ts";
import {
  type CycleOutcome,
  resolveCycleAgentCommand,
  type ScheduledRunOptions,
} from "./scheduled-run.ts";
import { scheduledSharedMode } from "./shared-cycle.ts";

/** How the credential pre-flight acted: a skip names every
 *  unauthenticatable target; proceed means at least one target is
 *  plausibly authenticatable, or the gate could not judge. */
export type CredentialPreflightResult =
  | { readonly status: "proceed" }
  | { readonly status: "skip"; readonly reason: string };

export interface CredentialPreflightOptions {
  readonly settings: AgentSettings;
  readonly log: (line: string) => void;
  /** The environment the env-var clause judges; the caller asserts
   *  it is the cycle's own; default: this process's own. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Whether `env` provably reaches the spawned agent chain —
   *  shared-writer mode spreads this process's env into the
   *  coordinator's; local mode's children run with the scratch
   *  scheduled env (HOME, PATH, the lock marker, the agent path)
   *  and never see this process's other vars, so there the clause
   *  would green-light a target pi cannot authenticate. Default:
   *  false — an env-var-only target then counts as
   *  unauthenticatable. */
  readonly envReachesCycle?: boolean | undefined;
  /** pi's auth store; default: the default resolution against this
   *  process's HOME (<home>/.pi/agent/auth.json). */
  readonly authStorePath?: string | undefined;
  /** The store reader; injected in tests. Default: read and
   *  shape-check the file. */
  readonly readAuthStore?: (path: string) => Promise<AuthStoreRead>;
}

/** What reading pi's auth store yields: the providers it holds
 *  entries for, none (the file is absent — pi has no stored
 *  credential for anyone), or unknown (the file exists but cannot
 *  be judged — fail-open). */
export type AuthStoreRead =
  | { readonly kind: "entries"; readonly providers: readonly string[] }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/** The provider's canonical credential env var: the upper-snake
 *  provider id plus `_API_KEY` — `zai` → `ZAI_API_KEY`,
 *  `zai-coding-cn` → `ZAI_CODING_CN_API_KEY`. A heuristic: a
 *  handful of providers use idiosyncratic names upstream (pi maps
 *  `google` to `GEMINI_API_KEY`), and for those the env clause
 *  fails while the auth-store clause still applies. */
export function providerEnvVar(provider: string): string {
  const snake = provider.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return `${snake.toUpperCase()}_API_KEY`;
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

/** The default store reader: absent when the file is missing (a
 *  judgeable state — no provider has a stored credential), the
 *  providers keyed at the top level when it parses to an object,
 *  unknown for anything else (a non-object payload, torn JSON, a
 *  read error). The gate never crashes a cycle over its own
 *  probe. */
async function readAuthStoreFile(path: string): Promise<AuthStoreRead> {
  let text: string | undefined;

  try {
    text = await readTextIfExists(path);
  } catch {
    return { kind: "unreadable" };
  }

  if (text === undefined) {
    return { kind: "absent" };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable" };
  }

  return { kind: "entries", providers: Object.keys(parsed) };
}

/** Whether an env-var lookup fails to carry a credential — an
 *  absent or empty value reads as unset, the way pi's own env
 *  resolution treats it. */
function envCredentialAbsent(value: string | undefined): boolean {
  return value === undefined || value === "";
}

/** Whether the auth store holds an entry for the provider — key
 *  presence, exact: OAuth and api-key entries both authenticate,
 *  and a prefix match would false-positive related providers. */
function hasStoreCredential(
  storeProviders: readonly string[],
  provider: string,
): boolean {
  return storeProviders.includes(provider);
}

/** Whether the target is unauthenticatable in the judged
 *  environment: the auth store lacks the provider, and the env-var
 *  clause cannot rescue it — either the env does not reach the
 *  cycle (local mode's scratch scheduled env never carries
 *  credential vars) or the var reads absent there. */
function targetUnauthenticatable(
  target: AgentTarget,
  storeProviders: readonly string[],
  cycleEnv: NodeJS.ProcessEnv,
  envReachesCycle: boolean,
): boolean {
  if (hasStoreCredential(storeProviders, target.provider ?? "")) {
    return false;
  }

  return (
    !envReachesCycle ||
    envCredentialAbsent(cycleEnv[providerEnvVar(target.provider ?? "")])
  );
}

/** The probe (issue #409): skip with a named reason when every
 *  configured target is implausibly authenticatable in the cycle's
 *  own environment; proceed when one target passes, when no target
 *  names a provider (nothing to judge — pi's default-provider
 *  credential is invisible here), or when the auth store cannot be
 *  judged. */
export async function credentialPreflight(
  options: CredentialPreflightOptions,
): Promise<CredentialPreflightResult> {
  const targets = agentTargets(options.settings).filter(
    (target) => target.provider !== undefined && target.provider !== "",
  );

  if (targets.length === 0) {
    return { status: "proceed" };
  }

  const read = options.readAuthStore ?? readAuthStoreFile;
  const store = await read(options.authStorePath ?? defaultAuthStorePath());

  if (store.kind === "unreadable") {
    options.log(
      "scheduled-run: credential pre-flight could not read the pi auth store — proceeding",
    );

    return { status: "proceed" };
  }

  const cycleEnv = options.env ?? process.env;
  const storeProviders = store.kind === "entries" ? store.providers : [];
  const misses = targets
    .filter((target) =>
      targetUnauthenticatable(
        target,
        storeProviders,
        cycleEnv,
        options.envReachesCycle === true,
      ),
    )
    .map(
      (target) =>
        `${targetLabel(target)}: no ${providerEnvVar(target.provider ?? "")} in cycle env, no auth.json entry`,
    );

  if (misses.length < targets.length) {
    return { status: "proceed" };
  }

  const reason = `no authenticatable agent target — ${misses.join("; ")}`;

  options.log(`scheduled-run: credential pre-flight skipped — ${reason}`);

  return { status: "skip", reason };
}

/** The gate's injectables: the env the env-var clause judges (only
 *  meaningful together with `envReachesCycle`), the auth-store
 *  path, and whether the judged env reaches the spawned agent
 *  chain — true exactly where the cycle provably inherits or
 *  spreads this env (shared-writer mode), false in local mode. */
export interface CredentialGateOptions {
  readonly cycleEnv?: NodeJS.ProcessEnv | undefined;
  readonly authStorePath?: string | undefined;
  readonly envReachesCycle?: boolean | undefined;
}

/** The gate as the scheduled cycle consumes it: load the settings
 *  (the same resolution the quota pre-flight uses), then probe.
 *  Unreadable settings proceed — the stage surfaces the settings
 *  error, as before — and an unexpected probe failure proceeds too:
 *  the gate is fail-open by construction, like its quota sibling.
 *  The env-var clause is scoped by `envReachesCycle` — the cycle
 *  mode resolves it, because the launchd process env alone proves
 *  nothing in local mode; cycleEnv defaults to this process's own
 *  and all three stay injectable for tests. */
export async function credentialGate(
  settingsPath: string,
  log: (line: string) => void,
  gate: CredentialGateOptions = {},
): Promise<CredentialPreflightResult> {
  try {
    return await credentialPreflight({
      settings: await loadAgentSettings(settingsPath),
      log,
      env: gate.cycleEnv,
      authStorePath: gate.authStorePath,
      envReachesCycle: gate.envReachesCycle,
    });
  } catch {
    log(
      "scheduled-run: agent settings unreadable — credential pre-flight unavailable — proceeding",
    );

    return { status: "proceed" };
  }
}

/** The cycle's agent-resolution outcome (issue #399): resolved to an
 *  absolute path, skipped (settings unreadable — the stage surfaces
 *  the precise settings error), or unresolved (the cycle fails
 *  before any stage, the shared-writer lease included). */
export type AgentResolution =
  | { readonly kind: "resolved"; readonly command: string }
  | { readonly kind: "skipped" }
  | { readonly kind: "unresolved"; readonly error: string };

/** The cycle's inputs (issues #399, #409), folded to one decision:
 *  a failed outcome when the agent binary cannot be resolved (the
 *  ALERT before any stage, lease included) or the shared-writer
 *  marker is invalid (fail closed before any gate) — else the
 *  absolute command to hand the children (undefined when unreadable
 *  settings defer the failure to the stage's settings error) and
 *  the resolved mode, one marker read that also scopes the
 *  credential gate's env-var clause. */
export async function resolveCycleInputsOrOutcome(
  options: ScheduledRunOptions,
  fail: (error: string) => Promise<CycleOutcome>,
  log: (line: string) => void,
): Promise<
  | CycleOutcome
  | {
      readonly agentCommand: string | undefined;
      readonly sharedMode: boolean;
    }
> {
  const agent = await resolveCycleAgentCommand(options, log);

  if (agent.kind === "unresolved") {
    return await fail(agent.error);
  }

  try {
    return {
      agentCommand: agent.kind === "resolved" ? agent.command : undefined,
      sharedMode: await scheduledSharedMode(options),
    };
  } catch (error) {
    return await fail(errorMessage(error));
  }
}
