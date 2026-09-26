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

export type QuotaPreflightResult =
  | { readonly status: "proceed"; readonly reason?: string }
  | { readonly status: "skip"; readonly reason: string };

export interface QuotaPreflightOptions {
  readonly settings: AgentSettings;
  readonly log: (line: string) => void;
  readonly commandRunner?: (command: string) => Promise<string>;
  readonly estimateSeconds?: number;
}

function commandFor(settings: AgentSettings): string {
  return settings.quotaPreflight === undefined ||
    settings.quotaPreflight === "auto"
    ? "quota-axi"
    : settings.quotaPreflight;
}

function unavailable(log: (line: string) => void): QuotaPreflightResult {
  log("scheduled-run: quota pre-flight unavailable — proceeding");
  return { status: "proceed", reason: "unavailable" };
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

function resetLabel(report: QuotaReport, provider: string): string {
  const exhaustion = exhaustionForProvider(report, provider)[0];
  const projected = exhaustion?.projectedExhaustedAt;

  return typeof projected === "string" ? projected : "unknown reset";
}

function skipReason(
  report: QuotaReport,
  provider: string,
  model: string,
  estimate: number,
): string | undefined {
  const rows = rowsForProvider(report, provider);
  const exhausted = rows.some((row) => row.runway === "exhausted_now");
  const finite = exhaustionForProvider(report, provider).find(
    (row) =>
      typeof row.usableRunwaySeconds === "number" &&
      row.usableRunwaySeconds < estimate,
  );

  if (!exhausted && finite === undefined) {
    return undefined;
  }

  const runway = exhausted
    ? "exhausted_now"
    : `${String(finite?.usableRunwaySeconds)}s remaining`;

  return `ingest provider ${provider} (model ${model}) ${runway}, reset ${resetLabel(report, provider)}`;
}

/** Read quota-axi without making it a runtime dependency or a gate. */
export async function quotaPreflight(
  options: QuotaPreflightOptions,
): Promise<QuotaPreflightResult> {
  if (options.settings.quotaPreflight === "off") {
    return { status: "proceed" };
  }

  const provider = options.settings.provider;

  if (provider === undefined || provider === "") {
    return unavailable(options.log);
  }

  const run =
    options.commandRunner ??
    (async (command: string): Promise<string> => {
      const result = await execFileAsync(
        command,
        ["--json", "--no-credential-refresh"],
        { maxBuffer: 1024 * 1024, timeout: 5_000 },
      );
      return result.stdout;
    });

  let report: QuotaReport | undefined;

  try {
    report = parseReport(await run(commandFor(options.settings)));
  } catch {
    return unavailable(options.log);
  }

  if (report === undefined) {
    return unavailable(options.log);
  }

  const estimate = options.estimateSeconds ?? DEFAULT_CYCLE_ESTIMATE_SECONDS;
  const reason = skipReason(report, provider, options.settings.model, estimate);

  if (reason === undefined) {
    return rowsForProvider(report, provider).length === 0
      ? unavailable(options.log)
      : { status: "proceed" };
  }

  options.log(`scheduled-run: quota pre-flight skipped — ${reason}`);
  return { status: "skip", reason };
}
