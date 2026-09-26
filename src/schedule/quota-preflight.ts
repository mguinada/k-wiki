/** Optional quota-axi pre-flight for unattended scheduled cycles. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSettings } from "../ingest/agent-settings.ts";

const execFileAsync = promisify(execFile);
export const DEFAULT_CYCLE_ESTIMATE_SECONDS = 30 * 60;

type QuotaRow = {
  readonly provider?: unknown;
  readonly scope?: unknown;
  readonly runway?: unknown;
};

type Exhaustion = {
  readonly provider?: unknown;
  readonly scope?: unknown;
  readonly usableRunwaySeconds?: unknown;
  readonly projectedExhaustedAt?: unknown;
};

type QuotaReport = {
  readonly quota?: unknown;
  readonly exhaustion?: unknown;
};

/** How the cycle's quota pre-flight acted: `off` when settings
 *  disabled the probe, `unavailable` when the probe could not answer;
 *  absent when the gate was active (it proceeded or skipped). */
export type PreflightState = "unavailable" | "off";

export type QuotaPreflightResult =
  | {
      readonly status: "proceed";
      readonly preflight?: PreflightState;
    }
  | { readonly status: "skip"; readonly reason: string };

export interface QuotaPreflightOptions {
  readonly settings: AgentSettings;
  readonly log: (line: string) => void;
  readonly commandRunner?: (command: string) => Promise<string>;
  /** The probe child's environment; default: this process's own. The
   *  scheduled wrapper passes its extended PATH so a launchd job
   *  resolves machine-local CLIs the way its child scripts do. */
  readonly env?: NodeJS.ProcessEnv;
}

function commandFor(settings: AgentSettings): string {
  return settings.quotaPreflight === undefined ||
    settings.quotaPreflight === "auto"
    ? "quota-axi"
    : settings.quotaPreflight;
}

/** Every non-activating outcome speaks the same one dim line, so a
 *  silent log can never mean the gate ran. */
export function quotaPreflightUnavailable(
  log: (line: string) => void,
): QuotaPreflightResult {
  log("scheduled-run: quota pre-flight unavailable — proceeding");

  return {
    status: "proceed",
    preflight: "unavailable",
  };
}

function parseReport(text: string): QuotaReport | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    return parsed as QuotaReport;
  } catch {
    return undefined;
  }
}

function rowsForProvider(report: QuotaReport, provider: string): QuotaRow[] {
  if (!Array.isArray(report.quota)) {
    return [];
  }

  return report.quota.filter(
    (row): row is QuotaRow =>
      typeof row === "object" &&
      row !== null &&
      (row as QuotaRow).provider === provider,
  );
}

function exhaustionForProvider(
  report: QuotaReport,
  provider: string,
): Exhaustion[] {
  if (!Array.isArray(report.exhaustion)) {
    return [];
  }

  return report.exhaustion.filter(
    (row): row is Exhaustion =>
      typeof row === "object" &&
      row !== null &&
      (row as Exhaustion).provider === provider,
  );
}

/** A row's scope, when the probe named a usable one. */
function asScope(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The deciding record's reset time: the row that grounded the skip
 *  when it carries one, else the provider's exhaustion row for the
 *  deciding scope, else the provider's only exhaustion row, else
 *  unknown. */
function resetLabel(
  report: QuotaReport,
  provider: string,
  scope: string | undefined,
  deciding: Exhaustion | undefined,
): string {
  if (
    deciding !== undefined &&
    typeof deciding.projectedExhaustedAt === "string"
  ) {
    return deciding.projectedExhaustedAt;
  }

  const exhaustion = exhaustionForProvider(report, provider);
  const matched =
    (scope === undefined
      ? undefined
      : exhaustion.find((row) => asScope(row.scope) === scope)) ??
    (exhaustion.length === 1 ? exhaustion[0] : undefined);
  const projected = matched?.projectedExhaustedAt;

  return typeof projected === "string" ? projected : "unknown reset";
}

function skipReason(
  report: QuotaReport,
  provider: string,
  model: string,
  estimate: number,
): string | undefined {
  const exhaustedRow = rowsForProvider(report, provider).find(
    (row) => row.runway === "exhausted_now",
  );
  const finite = exhaustionForProvider(report, provider).find(
    (row) =>
      typeof row.usableRunwaySeconds === "number" &&
      row.usableRunwaySeconds < estimate,
  );

  if (exhaustedRow === undefined && finite === undefined) {
    return undefined;
  }

  const scope = asScope(
    exhaustedRow !== undefined ? exhaustedRow.scope : finite?.scope,
  );
  const runway =
    exhaustedRow === undefined
      ? `${String(finite?.usableRunwaySeconds)}s remaining`
      : "exhausted_now";
  const reset = resetLabel(
    report,
    provider,
    scope,
    exhaustedRow === undefined ? finite : undefined,
  );

  return `ingest provider ${provider}${scope === undefined ? "" : ` scope ${scope}`} (model ${model}) ${runway}, reset ${reset}`;
}

/** Read quota-axi without making it a runtime dependency or a gate. */
export async function quotaPreflight(
  options: QuotaPreflightOptions,
): Promise<QuotaPreflightResult> {
  if (options.settings.quotaPreflight === "off") {
    return { status: "proceed", preflight: "off" };
  }

  const provider = options.settings.provider;

  if (provider === undefined || provider === "") {
    return quotaPreflightUnavailable(options.log);
  }

  const run =
    options.commandRunner ??
    (async (command: string): Promise<string> => {
      const result = await execFileAsync(
        command,
        ["--json", "--no-credential-refresh"],
        { env: options.env, maxBuffer: 1024 * 1024, timeout: 5_000 },
      );
      return result.stdout;
    });

  let report: QuotaReport | undefined;

  try {
    report = parseReport(await run(commandFor(options.settings)));
  } catch {
    return quotaPreflightUnavailable(options.log);
  }

  if (report === undefined) {
    return quotaPreflightUnavailable(options.log);
  }

  const estimate = DEFAULT_CYCLE_ESTIMATE_SECONDS;
  const reason = skipReason(report, provider, options.settings.model, estimate);

  if (reason === undefined) {
    return rowsForProvider(report, provider).length === 0
      ? quotaPreflightUnavailable(options.log)
      : { status: "proceed" };
  }

  options.log(`scheduled-run: quota pre-flight skipped — ${reason}`);
  return { status: "skip", reason };
}
