/**
 * The partitioned `--web` artifact body: the machine-owned section
 * renderers and the partitioned body codec. The audit's raw data
 * lives in web-audit.ts; this module owns the artifact shape —
 * heading and label wording, the partition separator, and the
 * render/parse pair that keeps the file's body byte-stable.
 */

import type { WebCall, WebSource } from "./web-audit.ts";

/** The artifact's header `mode` value for a `--web` run. */
export const WEB_MODE = "query (--web)";

/** The visual rule marking the partition the web sections may not
 *  cross upward: everything below is enrichment, never core. */
export const WEB_PARTITION_SEPARATOR =
  "──────────────────── web enrichment boundary ────────────────────";

/** The three machine-owned section headings of a `--web` artifact,
 *  in artifact order. */
export const WEB_ENRICHMENT_HEADING = "## Web enrichment";
export const WEB_SOURCES_HEADING = "## Web sources";
export const WEB_AUDIT_HEADING = "## Web calls audit";

/** The partition label under the enrichment heading (the artifact
 *  structure of record). */
export const WEB_ENRICHMENT_LABEL =
  "_Independent of the answer above; not part of wiki provenance._";

/** The three web sections of a partitioned `--web` artifact, each
 *  including its heading. */
export interface WebArtifactSections {
  /** `## Web enrichment` — the enrichment bullets, machine-headed. */
  readonly enrichment: string;
  /** `## Web sources` — computed from the audit, not model output. */
  readonly sources: string;
  /** `## Web calls audit` — every recorded web tool call. */
  readonly audit: string;
}

/** Strip everything the machinery owns from model output: at the
 *  first machine-owned line — a section heading, the partition
 *  separator, or the label — the model's text ends; whatever
 *  followed is section imitation the machinery recomputes anyway.
 *  The enrichment's one text boundary: both the rendered section
 *  and the sources reconciliation consume its result. */
export function sanitizeEnrichment(text: string): string {
  const owned = [
    WEB_ENRICHMENT_HEADING,
    WEB_SOURCES_HEADING,
    WEB_AUDIT_HEADING,
    WEB_PARTITION_SEPARATOR,
    WEB_ENRICHMENT_LABEL,
  ];
  const kept: string[] = [];

  for (const line of text.split("\n")) {
    if (owned.includes(line.trim())) {
      break;
    }

    kept.push(line);
  }

  return kept.join("\n").trim();
}

/** The `## Web sources` section: machine-computed list, retrieval
 *  dates from the audit. */
export function renderWebSourcesSection(sources: readonly WebSource[]): string {
  const entries =
    sources.length === 0
      ? ["_No web resources were used._"]
      : sources.map(
          (source) => `- ${source.url} — retrieved ${source.retrieved}`,
        );

  return [WEB_SOURCES_HEADING, "", ...entries].join("\n");
}

/** One audit table row. */
function auditRow(index: number, call: WebCall): string {
  return `| ${index} | ${call.tool} | ${call.target} | ${call.results} | ${new Date(call.timestamp).toISOString()} |`;
}

/** The `## Web calls audit` section: every recorded call, in order. */
export function renderWebAuditSection(calls: readonly WebCall[]): string {
  const header = [
    WEB_AUDIT_HEADING,
    "",
    "| # | tool | target | results | timestamp |",
    "|---|------|--------|---------|-----------|",
  ];

  const rows = calls.map((call, index) => auditRow(index + 1, call));

  return [
    ...header,
    ...(rows.length === 0 ? ["| - | none | - | 0 | - |"] : rows),
  ].join("\n");
}

/** The `## Web enrichment` section: the machine heading and label,
 *  then the model bullets as given — the caller passes them through
 *  sanitizeEnrichment, so what is rendered and what is reconciled
 *  is the same text. */
export function renderWebEnrichmentSection(enrichment: string): string {
  return [
    WEB_ENRICHMENT_HEADING,
    "",
    WEB_ENRICHMENT_LABEL,
    "",
    enrichment,
  ].join("\n");
}

/** The partitioned `--web` body, from the core answer and the three
 *  machine-owned sections. */
export function renderWebArtifactBody(
  answer: string,
  web: WebArtifactSections,
): string {
  return [
    "## Answer",
    "",
    answer,
    "",
    WEB_PARTITION_SEPARATOR,
    "",
    web.enrichment,
    "",
    web.sources,
    "",
    web.audit,
  ].join("\n");
}

/** The body lines from one heading up to (not including) the next,
 *  the start heading included — the stored sections carry their own
 *  heading — trailing blanks trimmed. Undefined when the start
 *  heading is missing. */
function sectionBetween(
  lines: readonly string[],
  start: string,
  end: string,
): string | undefined {
  const from = lines.indexOf(start);

  if (from === -1) {
    return undefined;
  }

  const to = lines.indexOf(end, from + 1);

  if (to === -1) {
    return undefined;
  }

  return lines.slice(from, to).join("\n").replace(/\n$/, "");
}

/** The body lines from one heading to the end, the heading
 *  included, trailing blanks trimmed. Undefined when the heading is
 *  missing. */
function sectionAfter(
  lines: readonly string[],
  start: string,
): string | undefined {
  const from = lines.indexOf(start);

  if (from === -1) {
    return undefined;
  }

  return lines.slice(from).join("\n").replace(/\n$/, "");
}

/** The partitioned `--web` body: core answer plus the three web
 *  sections, split on the machine-owned headings. Undefined when the
 *  body is not the partitioned shape. */
export function parseWebArtifactBody(
  lines: readonly string[],
): { answer: string; web: WebArtifactSections } | undefined {
  const separator = lines.indexOf(WEB_PARTITION_SEPARATOR);

  if (separator === -1 || lines[0] !== "## Answer") {
    return undefined;
  }

  const answer = lines
    .slice(1, separator)
    .join("\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  const enrichment = sectionBetween(
    lines,
    WEB_ENRICHMENT_HEADING,
    WEB_SOURCES_HEADING,
  );
  const sources = sectionBetween(lines, WEB_SOURCES_HEADING, WEB_AUDIT_HEADING);
  const audit = sectionAfter(lines, WEB_AUDIT_HEADING);

  if (
    enrichment === undefined ||
    sources === undefined ||
    audit === undefined
  ) {
    return undefined;
  }

  return { answer, web: { enrichment, sources, audit } };
}
