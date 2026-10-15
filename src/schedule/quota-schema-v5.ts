/**
 * The quota-axi JSON schema normalizer (issue #463 §1): the
 * version-aware decision core over one already-parsed report,
 * plus the shared-account buffer's parser. Supports exactly the
 * named schema versions through `decideQuotaReport` — v5 today —
 * parsing only validated nested records; an unrecognized field
 * never infers an actionable result. Supported-schema tests anchor
 * the contract; any unknown or malformed shape is
 * `unsupported-schema`/unavailable and fails open.
 */

import type { QuotaDecision } from "./quota-preflight.ts";

/** The shared-account buffer's default reserve (issue #463): five
 *  whole minutes above the cycle estimate. */
export const DEFAULT_BUFFER_MINUTES = 5;

/** The JSON schema versions this normalizer decides on (issue #463
 *  §1): exactly v5 today. Any other version — higher, lower, absent —
 *  is unsupported and fails open. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [5];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type V5AvailabilityEntry = {
  readonly scope?: unknown;
  readonly status?: unknown;
  readonly boundConflict?: unknown;
  readonly runway?: unknown;
};

type V5Window = {
  readonly id?: unknown;
  readonly resetsAt?: unknown;
};

type V5Provider = {
  readonly provider?: unknown;
  readonly state?: unknown;
  readonly windows?: unknown;
  readonly quotaSemantics?: unknown;
};

type V5Runway = {
  readonly status?: unknown;
  readonly usableRunwaySeconds?: unknown;
  readonly limitingWindowId?: unknown;
};

/** A character in the control range: the display-safety class the
 *  bounded rendering replaces. */
function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;

  return code < 0x20 || code === 0x7f;
}

export function safeRender(raw: string): string {
  const cleaned = Array.from(raw)
    .map((character) => (isControlCharacter(character) ? "?" : character))
    .join("");

  return JSON.stringify(
    cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned,
  );
}

/** The warning `quotaPreflightBuffer` gate callers emit for a
 *  rejected value (issue #463 §3): the bounded rejected input, the
 *  minutes-only rule, and the fallback actually in use. */
export function quotaPreflightBufferWarning(rejected: string): string {
  return `WARNING — quotaPreflightBuffer ${safeRender(rejected)}: only non-negative whole-minute values are supported; using the ${DEFAULT_BUFFER_MINUTES}m fallback`;
}

/** Parse the `quotaPreflightBuffer` settings value into seconds
 *  (issue #463 §3): whole non-negative minutes only, `5m` when
 *  absent; any other value reports its warning (the caller renders
 *  or logs it) and uses the default. Numeric overflow and the bare
 *  numbers, and unsupported units, all fall back — nothing is
 *  silently reinterpreted. */
export function parseQuotaPreflightBuffer(raw: string | undefined): {
  readonly seconds: number;
  readonly warnings: readonly string[];
} {
  if (raw === undefined) {
    return { seconds: DEFAULT_BUFFER_MINUTES * 60, warnings: [] };
  }

  const match = /^(\d+)m$/.exec(raw);
  const minutes = match === null ? undefined : Number(match[1]);

  if (minutes === undefined || !Number.isSafeInteger(minutes)) {
    return {
      seconds: DEFAULT_BUFFER_MINUTES * 60,
      warnings: [quotaPreflightBufferWarning(raw)],
    };
  }

  return { seconds: minutes * 60, warnings: [] };
}

function providerRecord(
  report: unknown,
  quotaProvider: string,
): V5Provider | undefined {
  if (!isRecord(report) || !Array.isArray(report.providers)) {
    return undefined;
  }

  return report.providers.find(
    (candidate): candidate is V5Provider =>
      isRecord(candidate) && candidate.provider === quotaProvider,
  );
}

/** The provider-state gates of the v5 authority contract (issue
 *  #463 §1a): status fresh, not stale, authentication usable or
 *  unnamed. Any other state is non-authoritative. */
function providerUsable(state: unknown): boolean {
  if (!isRecord(state)) {
    return false;
  }

  if (state.status !== "fresh" || state.stale !== false) {
    return false;
  }

  return state.authStatus === undefined || state.authStatus === "usable";
}

/** The target's effective-availability record: its exact
 *  `model:<model>` scope exclusively when present, else `all_models`
 *  exclusively (issue #463 §1a — never aggregated). Unsupported
 *  scopes match nothing. */
function pickAvailability(
  semantics: Record<string, unknown>,
  model: string,
): { readonly scope: string; readonly entry: V5AvailabilityEntry } | undefined {
  const availability = semantics.effectiveAvailability;

  if (!Array.isArray(availability)) {
    return undefined;
  }

  const entries = availability.filter((entry): entry is V5AvailabilityEntry =>
    isRecord(entry),
  );
  const exact = entries.find((entry) => entry.scope === `model:${model}`);

  if (exact !== undefined) {
    return { scope: `model:${model}`, entry: exact };
  }

  const aggregate = entries.find((entry) => entry.scope === "all_models");

  return aggregate === undefined
    ? undefined
    : { scope: "all_models", entry: aggregate };
}

/** The deciding scope record, under the full v5 authority contract
 *  (issue #463 §1a); undefined when any gate fails. Pace and
 *  percentages are read nowhere — they never decide a skip. */
function authoritativeAvailability(
  providerRec: V5Provider,
  model: string,
): { readonly scope: string; readonly entry: V5AvailabilityEntry } | undefined {
  const state = providerRec.state;
  const semantics = providerRec.quotaSemantics;

  if (!providerUsable(state) || !isRecord(semantics)) {
    return undefined;
  }

  if (semantics.status !== "known") {
    return undefined;
  }

  const picked = pickAvailability(semantics, model);

  if (picked === undefined) {
    return undefined;
  }

  if (picked.entry.status !== "known" || picked.entry.boundConflict === true) {
    return undefined;
  }

  return picked;
}

/** The deciding scope record's reset time: the limiting window's
 *  actual `resetsAt` through the bounded renderer (issue #463 §1a —
 *  payload text never reaches a log, stamp, or alert verbatim),
 *  `unknown` when the window or its timestamp is absent or unusable
 *  — projected exhaustion times are never skip labels. */
function runwayResetLabel(windows: unknown, runway: V5Runway): string {
  const windowId = runway.limitingWindowId;

  if (typeof windowId !== "string" || !Array.isArray(windows)) {
    return "unknown";
  }

  const match = windows.find(
    (candidate) => isRecord(candidate) && candidate.id === windowId,
  ) as V5Window | undefined;
  const resetsAt = match?.resetsAt;

  return typeof resetsAt === "string" ? safeRender(resetsAt) : "unknown";
}

/** The runway decision (issue #463 §3): exhausted-now or a finite
 *  projected runway strictly below the required seconds skips;
 *  exactly the required runway, `through_reset`, an unknown runway,
 *  or any unusable record proceeds. */
function runwayDecision(
  runway: unknown,
  requiredRunwaySeconds: number,
):
  | { readonly kind: "proceed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "skipping"; readonly label: string } {
  if (!isRecord(runway)) {
    return { kind: "unavailable" };
  }

  const status = runway.status;
  const v5Runway = runway as V5Runway;

  if (status === "exhausted_now") {
    return { kind: "skipping", label: "exhausted_now" };
  }

  if (status === "projected_exhaustion") {
    const seconds = v5Runway.usableRunwaySeconds;

    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return { kind: "unavailable" };
    }

    return seconds < requiredRunwaySeconds
      ? { kind: "skipping", label: `${seconds}s of runway remaining` }
      : { kind: "proceed" };
  }

  if (status === "through_reset") {
    return { kind: "proceed" };
  }

  return { kind: "unavailable" };
}

/** The version-aware normalizer's decision over one already-parsed
 *  quota-axi report (issue #463 §1, §1a): parse only validated
 *  nested records; never infer an actionable result from an
 *  unrecognized field. Unsupported schema, malformed records, and
 *  non-authoritative evidence do not decide a skip. */
export function decideQuotaReport(
  report: unknown,
  quotaProvider: string,
  model: string,
  requiredRunwaySeconds: number,
  schemaVersion: readonly number[] = SUPPORTED_SCHEMA_VERSIONS,
): QuotaDecision {
  if (!isRecord(report)) {
    return { kind: "unavailable", cause: "unavailable" };
  }

  if (!schemaVersion.includes(report.schemaVersion as number)) {
    return { kind: "unavailable", cause: "unsupported-schema" };
  }

  const providerRec = providerRecord(report, quotaProvider);

  if (providerRec === undefined) {
    return { kind: "unavailable", cause: "unavailable" };
  }

  const picked = authoritativeAvailability(providerRec, model);

  if (picked === undefined) {
    return { kind: "unavailable", cause: "unavailable" };
  }

  const runwayVerdict = runwayDecision(
    picked.entry.runway,
    requiredRunwaySeconds,
  );

  if (runwayVerdict.kind === "proceed") {
    return { kind: "proceed" };
  }

  if (runwayVerdict.kind === "unavailable") {
    return { kind: "unavailable", cause: "unavailable" };
  }

  const reset = runwayResetLabel(
    providerRec.windows,
    picked.entry.runway as V5Runway,
  );

  return {
    kind: "skip",
    reason: `quota — ingest provider ${quotaProvider} scope ${picked.scope} (model ${model}) ${runwayVerdict.label}, reset ${reset}`,
  };
}
