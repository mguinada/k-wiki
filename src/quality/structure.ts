import { isPlainObject } from "../cli/shared.ts";
import {
  METRIC_LABELS,
  type OffenderSite,
  type StructureMetrics,
  type StructureOffenders,
  counterKeys,
} from "./refactor-metrics.ts";

/**
 * The structure budget gate: the durable successor of the campaign's
 * baseline freeze. `.structureguard.json` holds one budget per
 * refactor-metrics counter; a fresh scan that exceeds any budget
 * breaches, and the rendered breach lines are the agent-facing
 * report — counter, budget, fresh value, and the attributed sites
 * where the instrument names them. Lowering a budget is a one-line
 * reviewed diff; raising one, or adding a per-counter exclude,
 * demands a written justification in the PR body (the
 * `.complexityguard.json` precedent). No inline suppressions.
 */

/** The parsed `.structureguard.json` body. */
export interface StructureBudget {
  /** The maximum allowed value per counter key. */
  readonly budget: Record<keyof StructureMetrics, number>;
  /** Excluded paths per counter: each matching site leaves its
   *  counter (for max file lines, the file leaves the maximum). */
  readonly exclude: Readonly<
    Partial<Record<keyof StructureMetrics, readonly string[]>>
  >;
}

/** One counter whose effective value exceeds its budget. */
export interface StructureBreach {
  readonly key: keyof StructureMetrics;
  readonly budget: number;
  readonly fresh: number;
}

/** The human-readable label of a counter key. */
function counterLabel(key: keyof StructureMetrics): string {
  return METRIC_LABELS.find(([labelKey]) => labelKey === key)?.[1] ?? key;
}

/** The specific validation problems of a budget object, if any. */
function counterProblems(entry: Record<string, unknown>): string[] {
  const known = new Set<string>(counterKeys);
  const unknownKeys = Object.keys(entry).filter((key) => !known.has(key));
  const missing = counterKeys.filter((key) => !(key in entry));
  const problems: string[] = [];

  if (unknownKeys.length > 0) {
    problems.push(`unknown counters ${unknownKeys.join(", ")}`);
  }

  if (missing.length > 0) {
    problems.push(`missing counters ${missing.join(", ")}`);
  }

  for (const key of counterKeys) {
    const value: unknown = entry[key];

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      problems.push(`counter ${key} must be a finite non-negative number`);
    }
  }

  return problems;
}

/** The specific validation problems of an exclude object, if any. */
function excludeProblems(entry: Record<string, unknown>): string[] {
  const known = new Set<string>(counterKeys);
  const problems: string[] = [];

  for (const [key, paths] of Object.entries(entry)) {
    if (!known.has(key)) {
      problems.push(`exclude names a non-counter ${key}`);
    } else if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== "string")
    ) {
      problems.push(`exclude ${key} must be a list of paths`);
    }
  }

  return problems;
}

/** Parse and validate a `.structureguard.json` body; throws with the
 *  offending keys named when the body is not a budget. */
export function parseStructureBudget(json: string): StructureBudget {
  const parsed: { budget?: unknown; exclude?: unknown } = JSON.parse(json) as {
    budget?: unknown;
    exclude?: unknown;
  };
  const budgetEntry = isPlainObject(parsed.budget) ? parsed.budget : {};
  const excludeEntry = isPlainObject(parsed.exclude) ? parsed.exclude : {};
  const problems = [
    ...counterProblems(budgetEntry),
    ...excludeProblems(excludeEntry),
  ];

  if (problems.length > 0) {
    throw new Error(`structure budget: ${problems.join("; ")}`);
  }

  return {
    budget: budgetEntry as Record<keyof StructureMetrics, number>,
    exclude: excludeEntry as StructureBudget["exclude"],
  };
}

/** Offender sites with each counter's excluded paths removed. */
export function applyExcludes(
  offenders: StructureOffenders,
  exclude: Readonly<Partial<Record<keyof StructureMetrics, readonly string[]>>>,
): StructureOffenders {
  const filtered: Record<keyof StructureMetrics, readonly OffenderSite[]> = {
    ...offenders,
  };

  for (const key of counterKeys) {
    const excluded = new Set(exclude[key] ?? []);

    if (excluded.size > 0) {
      filtered[key] = offenders[key].filter((site) => !excluded.has(site.path));
    }
  }

  return filtered;
}

/** The counters whose effective value exceeds their budget. */
export function breachesOf(
  budget: Readonly<Record<keyof StructureMetrics, number>>,
  fresh: StructureMetrics,
): readonly StructureBreach[] {
  return counterKeys
    .filter((key) => fresh[key] > budget[key])
    .map((key) => ({ key, budget: budget[key], fresh: fresh[key] }));
}

/** Sites listed per breached counter — all offenders for site-count
 *  counters, only the files at the breached maximum for max file
 *  lines — capped, with an overflow count. */
const SITE_CAP = 10;

function breachSites(
  breach: StructureBreach,
  offenders: StructureOffenders,
): readonly OffenderSite[] {
  if (breach.key === "maxFileLines") {
    return offenders.maxFileLines.filter((site) => site.lines === breach.fresh);
  }

  return offenders[breach.key];
}

/** One site as a report line: file:line, or the file with its line
 *  count for the file-size counters. */
function renderSite(site: OffenderSite): string {
  if (site.lines === undefined) {
    return `${site.path}:${site.line}`;
  }

  return `${site.path} (${site.lines} lines)`;
}

/** The rendered breach report: one header line per breached counter
 *  (label, key, fresh value, budget) followed by its sites. */
export function renderBreaches(
  breaches: readonly StructureBreach[],
  offenders: StructureOffenders,
): string {
  return breaches
    .map((breach) => {
      const sites = breachSites(breach, offenders);
      const listed = sites.slice(0, SITE_CAP);
      const overflow = sites.length - listed.length;
      const lines = [
        `${counterLabel(breach.key)} (${breach.key}): fresh ${breach.fresh} > budget ${breach.budget}`,
        ...listed.map((site) => `  ${renderSite(site)}`),
      ];

      if (overflow > 0) {
        lines.push(`  … +${overflow} more`);
      }

      return lines.join("\n");
    })
    .join("\n");
}
