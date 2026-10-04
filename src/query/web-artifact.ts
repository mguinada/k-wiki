/**
 * The partitioned `--web` artifact body: the machine-owned section
 * renderers and the partitioned body codec. The audit's raw data
 * lives in web-audit.ts; this module owns the artifact shape —
 * heading and label wording, the reader's thematic break, and the
 * render/parse pair that keeps the file's body byte-stable. The
 * partition is heading-anchored and tail-verified: the body parses
 * from the document end, so a core answer that echoes a section
 * heading or carries a stray thematic break cannot move the
 * boundary. Structure is markdown-native only: a `---` thematic
 * break decorates the boundary for the reader, and no logic depends
 * on it.
 */

import type { WebCall, WebSource } from "./web-audit.ts";

/** The artifact's header `mode` value for a `--web` run. */
export const WEB_MODE = "query (--web)";

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
 *  first machine-owned line — a section heading or the label — the
 *  model's text ends; whatever followed is section imitation the
 *  machinery recomputes anyway. The enrichment's one text boundary:
 *  both the rendered section and the sources reconciliation consume
 *  its result. */
export function sanitizeEnrichment(text: string): string {
  const owned = [
    WEB_ENRICHMENT_HEADING,
    WEB_SOURCES_HEADING,
    WEB_AUDIT_HEADING,
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
 *  machine-owned sections: the answer, a blank-line-delimited
 *  `---` thematic break (decoration for the reader), then the
 *  sections. Markdown-native only. */
export function renderWebArtifactBody(
  answer: string,
  web: WebArtifactSections,
): string {
  return [
    "## Answer",
    "",
    answer,
    "",
    "---",
    "",
    web.enrichment,
    "",
    web.sources,
    "",
    web.audit,
  ].join("\n");
}

/** The last line index of `heading` in `lines` before `before`
 *  (exclusive), -1 when absent — the tail search that keeps a core
 *  answer's echoed headings from moving the partition. */
function lastHeadingBefore(
  lines: readonly string[],
  heading: string,
  before: number,
): number {
  return lines.slice(0, Math.max(0, before)).lastIndexOf(heading);
}

/** The body lines from one heading index up to (not including) the
 *  next, the start heading included, trailing blanks trimmed. */
function sectionAt(lines: readonly string[], from: number, to: number): string {
  return lines.slice(from, to).join("\n").replace(/\n$/, "");
}

/** The core text between the `## Answer` heading and the enrichment
 *  heading: leading and trailing blanks are removed, and the
 *  writer's trailing thematic-break decoration goes with them when
 *  present — the answer text itself never depends on the
 *  decoration. */
function coreText(coreLines: readonly string[]): string {
  let start = 0;
  let end = coreLines.length;

  while (start < end && coreLines[start] === "") {
    start += 1;
  }

  while (end > start && coreLines[end - 1] === "") {
    end -= 1;
  }

  if (end > start && coreLines[end - 1] === "---") {
    end -= 1;

    while (end > start && coreLines[end - 1] === "") {
      end -= 1;
    }
  }

  return coreLines.slice(start, end).join("\n");
}

/** The partitioned `--web` body, resolved from the document end:
 *  `## Web calls audit`, then `## Web sources`, then `## Web
 *  enrichment`, each the last heading before the previous one, and
 *  the core answer everything above the enrichment heading.
 *  Undefined when the body is not the partitioned shape. */
export function parseWebArtifactBody(
  lines: readonly string[],
): { answer: string; web: WebArtifactSections } | undefined {
  if (lines[0] !== "## Answer") {
    return undefined;
  }

  const audit = lastHeadingBefore(lines, WEB_AUDIT_HEADING, lines.length);

  if (audit === -1) {
    return undefined;
  }

  const sources = lastHeadingBefore(lines, WEB_SOURCES_HEADING, audit);

  if (sources === -1) {
    return undefined;
  }

  const enrichment = lastHeadingBefore(lines, WEB_ENRICHMENT_HEADING, sources);

  if (enrichment === -1) {
    return undefined;
  }

  return {
    answer: coreText(lines.slice(1, enrichment)),
    web: {
      enrichment: sectionAt(lines, enrichment, sources),
      sources: sectionAt(lines, sources, audit),
      audit: sectionAt(lines, audit, lines.length),
    },
  };
}

/** Whether the body looks like a partitioned `--web` body: it opens
 *  with the machine's `## Answer` heading and carries a machine-owned
 *  section heading. Detection is heading-anchored — never a text
 *  line — and resolution stays tail-verified: a body that looks
 *  partitioned but fails resolution is malformed, never plain. */
export function looksPartitionedWeb(lines: readonly string[]): boolean {
  return (
    lines[0] === "## Answer" &&
    (lines.includes(WEB_ENRICHMENT_HEADING) ||
      lines.includes(WEB_SOURCES_HEADING) ||
      lines.includes(WEB_AUDIT_HEADING))
  );
}
