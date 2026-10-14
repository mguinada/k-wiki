/**
 * The quota-axi pre-flight for unattended scheduled cycles and direct
 * manual wiki-sync runs (issue #463): a version-aware decision about
 * the first ingest target the existing router will attempt.
 *
 * The gate is fail-open by design: quota-axi is machine-local
 * optional tooling and every non-authoritative outcome — the probe
 * missing, unreadable, offline, or speaking an unsupported JSON
 * schema — logs one sanitized line and proceeds. Only fresh,
 * authenticated, authoritative evidence in a supported schema (v5)
 * may skip a cycle, and only when its effective-availability runway
 * cannot fund the 30-minute cycle estimate plus the configured
 * shared-account buffer.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSettings, AgentTarget } from "../ingest/agent-settings.ts";
import { agentTargets } from "../ingest/agent-settings.ts";
import {
  decideQuotaReport,
  parseQuotaPreflightBuffer,
  SUPPORTED_SCHEMA_VERSIONS,
} from "./quota-schema-v5.ts";

const execFileAsync = promisify(execFile);

/** The estimate one ingest cycle must fund (issues #406, #463). */
export const DEFAULT_CYCLE_ESTIMATE_SECONDS = 30 * 60;

/** The probe's named process bound (issue #463 §4): quota-axi's
 *  documented per-provider HTTP ceiling, its sequential Codex
 *  discovery pass, and process overhead together — observed runs
 *  sit well under one second, an unresponsive remote must not hold
 *  a cycle. */
export const QUOTA_PROBE_TIMEOUT_MS = 60_000;

/** The inherited cache-control variables the production probe
 *  removes from the child's environment (issue #463 §3): a
 *  launchd-style environment must not hand quota-axi a stale
 *  snapshot; the fresh response decides. */
export const QUOTA_SNAPSHOT_ENV_KEYS = [
  "QUOTA_AXI_MAX_AGE",
  "QUOTA_AXI_SNAPSHOT",
] as const;

/** How the cycle's quota pre-flight acted: `off` when settings
 *  disabled the probe, `unavailable` when the probe could not answer,
 *  `no-provider` when settings name no provider to check,
 *  `unsupported-schema` when quota-axi spoke a schema this version
 *  does not decide on (issue #463 §1); absent when the gate was
 *  active (it proceeded or skipped). */
export type PreflightState =
  | "unavailable"
  | "off"
  | "no-provider"
  | "unsupported-schema";

/** The scheduling-relevant quota decision (issue #463): `skip` only
 *  from fresh authoritative evidence; every other outcome proceeds,
 *  carrying its sanitized cause. */
export type QuotaDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "unavailable";
      readonly cause: PreflightState;
    };

export type QuotaPreflightResult =
  | {
      readonly status: "proceed";
      readonly preflight?: PreflightState;
    }
  | { readonly status: "skip"; readonly reason: string };

export interface QuotaPreflightOptions {
  readonly settings: AgentSettings;
  readonly log: (line: string) => void;
  /** The probe execution. Default: the production `execFile`. The
   *  second argument is the child's environment after the inherited
   *  cache/snapshot controls were removed — the injection seam
   *  fixtures drive (issue #463 §3). */
  readonly commandRunner?: (
    command: string,
    env: NodeJS.ProcessEnv | undefined,
  ) => Promise<string>;
  /** The probe command the launcher resolved to an absolute path
   *  (issue #406): the launchd PATH cannot find a user-local binary,
   *  so the launcher locates `quota-axi` the way it locates the agent
   *  binary and hands the absolute path here. When absent, the probe
   *  command comes from settings (an explicit `quotaPreflight` path,
   *  else the bare name). */
  readonly command?: string | undefined;
  /** The child's inheritable environment; default: this process's
   *  own. The inherited cache-control variables are removed before
   *  the child runs, in every runner including an injected one. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Every non-activating outcome speaks the same sanitized line
 *  shape, so a silent log can never mean the gate ran. */
function unavailableLine(): string {
  return "scheduled-run: quota pre-flight unavailable — proceeding";
}

/** The schema-mismatch line (issue #463 §1): distinguishable from
 *  exhaustion in the scheduled log, never quoting the payload. */
function unsupportedSchemaLine(): string {
  return `scheduled-run: quota pre-flight unsupported schema (quota-axi JSON schema is not one of the supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}) — proceeding`;
}

/** The quota-axi provider id the first attempted ingest target maps
 *  to (issue #463 §2): the codex runner's bare OpenAI model names
 *  are Codex quota; a configured `openai-codex` pi provider is the
 *  same `codex` provider — never a nonexistent `openai-codex` quota
 *  provider. Everything else maps by its own id. */
export function quotaProviderFor(
  target: AgentTarget | undefined,
  agent: string | undefined,
): string | undefined {
  if (agent === "codex") {
    return "codex";
  }

  if (target === undefined) {
    return undefined;
  }

  return target.provider === "openai-codex" ? "codex" : target.provider;
}

/** The command the probe runs: the launcher-resolved absolute path
 *  when the launcher handed one over, the settings' explicit path
 *  when one is configured, else the bare machine name. An explicit
 *  path is selected exactly — never silently replaced (issue #463
 *  §1b). */
function commandFor(
  settings: AgentSettings,
  resolved: string | undefined,
): string {
  if (resolved !== undefined) {
    return resolved;
  }

  return settings.quotaPreflight !== undefined &&
    settings.quotaPreflight !== "auto" &&
    settings.quotaPreflight !== "off"
    ? settings.quotaPreflight
    : "quota-axi";
}

/** The child's environment: the inherited snapshot/cache controls
 *  removed so the probe reads fresh (issue #463 §3). */
export function stripSnapshotEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean = { ...env };

  for (const key of QUOTA_SNAPSHOT_ENV_KEYS) {
    delete clean[key];
  }

  return clean;
}

async function productionRunner(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  const result = await execFileAsync(
    command,
    ["--json", "--no-credential-refresh"],
    {
      env,
      maxBuffer: 1024 * 1024,
      timeout: QUOTA_PROBE_TIMEOUT_MS,
    },
  );

  return result.stdout;
}

/** The probe-based decision plus the buffer warnings to render:
 *  the caller prefixes each through its own boundary (the scheduled
 *  log or the direct run's warning sink). Undefined warnings mean
 *  none. */
export interface QuotaDecisionResult {
  readonly decision: QuotaDecision;
  readonly warnings: readonly string[];
}

/** The shared decision core (issues #406, #463): reads the settings'
 *  quota mode, resolves the probe command and environment, and
 *  returns the scheduling-relevant decision plus the buffer warnings
 *  to render — the caller prefixes and renders them through its own
 *  boundary (the scheduled log or the direct run's warning sink).
 *  The probe's activity is validated first: a malformed buffer warns
 *  whenever the gate is active, even when the probe itself cannot
 *  answer. */
export async function decideQuota(
  options: QuotaPreflightOptions,
): Promise<QuotaDecisionResult> {
  if (options.settings.quotaPreflight === "off") {
    return {
      decision: { kind: "unavailable", cause: "off" },
      warnings: [],
    };
  }

  const firstTarget = agentTargets(options.settings)[0];
  const quotaProvider = quotaProviderFor(firstTarget, options.settings.agent);

  if (quotaProvider === undefined) {
    return {
      decision: { kind: "unavailable", cause: "no-provider" },
      warnings: [],
    };
  }

  const buffer = parseQuotaPreflightBuffer(
    options.settings.quotaPreflightBuffer,
  );

  const requiredRunway = DEFAULT_CYCLE_ESTIMATE_SECONDS + buffer.seconds;

  const runner = options.commandRunner ?? productionRunner;
  const childEnv = stripSnapshotEnvironment(options.env ?? process.env);

  let report: unknown;

  try {
    report = JSON.parse(
      await runner(commandFor(options.settings, options.command), childEnv),
    );
  } catch {
    return {
      decision: { kind: "unavailable", cause: "unavailable" },
      warnings: buffer.warnings,
    };
  }

  return {
    decision: decideQuotaReport(
      report,
      quotaProvider,
      firstTarget?.model ?? options.settings.model,
      requiredRunway,
    ),
    warnings: buffer.warnings,
  };
}

/** The scheduled-run shape of the gate (issue #406's long-standing
 *  contract): the same decision core, mapped to the wrapper's
 *  proceed/skip result with its preflight label. Every
 *  non-activating outcome speaks one logged line; `off` and
 *  `no-provider` stay silent, as they always have. */
export async function quotaPreflight(
  options: QuotaPreflightOptions,
): Promise<QuotaPreflightResult> {
  const { decision, warnings } = await decideQuota(options);

  for (const warning of warnings) {
    options.log(`scheduled-run: ${warning}`);
  }

  switch (decision.kind) {
    case "proceed":
      return { status: "proceed" };

    case "skip":
      options.log(
        `scheduled-run: quota pre-flight skipped — ${decision.reason}`,
      );

      return { status: "skip", reason: decision.reason };

    case "unavailable":
      if (decision.cause !== "off" && decision.cause !== "no-provider") {
        options.log(
          decision.cause === "unsupported-schema"
            ? unsupportedSchemaLine()
            : unavailableLine(),
        );
      }

      return {
        status: "proceed",
        preflight: decision.cause,
      };
  }
}

/** Every non-activating outcome speaks the same one dim line, so a
 *  silent log can never mean the gate ran. Kept for callers that
 *  short-circuit before the decision core (an unreadable settings
 *  file) and for tests anchoring the line. */
export function quotaPreflightUnavailable(
  log: (line: string) => void,
): QuotaPreflightResult {
  log(unavailableLine());

  return {
    status: "proceed",
    preflight: "unavailable",
  };
}
