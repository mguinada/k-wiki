/**
 * The `--web` run's machine audit: the audit vocabulary (calls,
 * sources), the cited-URL extraction, and the reconciliation that
 * prunes a citation the audit cannot account for down to the
 * traceable remainder. Pure query-domain code — text in, data out;
 * the lane output parses it consumes live in web-report.ts, the
 * artifact shape it feeds in web-artifact.ts.
 */

/** One recorded web tool call: the audit row's machine data. */
export interface WebCall {
  /** The tool name, as the event stream recorded it. */
  readonly tool: string;
  /** The call's target: the query text, or the URL(s) fetched. */
  readonly target: string;
  /** The tool's reported result count. */
  readonly results: number;
  /** When the call ran, epoch milliseconds. */
  readonly timestamp: number;
  /** Every URL the call exposed: fetch targets plus result-text URLs. */
  readonly urls: readonly string[];
  /** True when the tool result was an error. */
  readonly failed: boolean;
}

/** One consolidated web source: a URL the audit can account for,
 *  with its retrieval date. */
export interface WebSource {
  readonly url: string;
  /** Date-only retrieval date (UTC), from the audit timestamp. */
  readonly retrieved: string;
}

/** One matched URL as the text cites it: closing parentheses the
 *  URL did not open (a sentence's wrapping closer, GFM-autolink
 *  style) and trailing sentence punctuation never join it. */
function citedUrl(url: string): string {
  let end = url.length;
  let excess = url.split(")").length - url.split("(").length;

  while (end > 0) {
    const ch = url.charAt(end - 1);

    if (/[.,;:!?'"]/.test(ch) || (ch === ")" && excess > 0)) {
      end -= 1;
      excess -= ch === ")" ? 1 : 0;
    } else {
      break;
    }
  }

  return url.slice(0, end);
}

/** URLs mentioned in free text, in first-appearance order: markdown
 *  link targets and bare URLs alike. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>[\]{}"'`]+/g) ?? [];

  return [...new Set(matches.map(citedUrl))];
}

/** The date-only (UTC) form of an epoch-milliseconds timestamp. */
function dateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** The consolidated Web sources list: exactly the enrichment's
 *  cited URLs the audit can account for, each with the retrieval
 *  date of its earliest recording call. */
function consolidatedSources(
  cited: readonly string[],
  calls: readonly WebCall[],
): WebSource[] {
  return cited.flatMap((url) => {
    const call = calls.find((entry) => entry.urls.includes(url));

    return call === undefined
      ? []
      : [{ url, retrieved: dateOnly(call.timestamp) }];
  });
}

/** What the reconciliation pruned from one enrichment: the pruned
 *  citations' count (every untraceable citation in a dropped
 *  bullet) and the offending URLs, deduplicated in first-appearance
 *  order. */
export interface WebPrunedCitations {
  readonly count: number;
  readonly urls: readonly string[];
}

/** The traceability gate's name, singular with one offending URL —
 *  the failure reason and the artifact's prune line both carry it. */
export function citationGate(count: number): string {
  return count === 1
    ? "cited URL absent from the audit table"
    : "cited URLs absent from the audit table";
}

/** The enrichment's bullets: each `- ` marker line starts one, and
 *  any following non-marker lines are its wrapped continuations; a
 *  run of lines before the first marker is a block of its own.
 *  Joined with newlines, the blocks reassemble the text exactly. */
function bulletBlocks(enrichment: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of enrichment.split("\n")) {
    const startsBullet = line.startsWith("- ") && current.length > 0;

    if (startsBullet) {
      blocks.push(current.join("\n"));

      current = [];
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks;
}

/** The enrichment pruned to its traceable remainder: every bullet
 *  citing a URL the audit cannot account for is dropped whole — a
 *  wrapped continuation never survives without its marker — and
 *  what was pruned is recorded. Text without violations passes
 *  through byte-exact (already trimmed by the caller). */
function pruneUntraceableBullets(
  enrichment: string,
  audited: ReadonlySet<string>,
): { text: string; pruned: WebPrunedCitations | undefined } {
  const kept: string[] = [];
  const urls: string[] = [];
  let count = 0;

  for (const bullet of bulletBlocks(enrichment)) {
    const untraceable = extractUrls(bullet).filter((url) => !audited.has(url));

    if (untraceable.length === 0) {
      kept.push(bullet);

      continue;
    }

    count += untraceable.length;
    urls.push(...untraceable);
  }

  return {
    text: kept.join("\n").trim(),
    pruned: count === 0 ? undefined : { count, urls: [...new Set(urls)] },
  };
}

/** What the sources reconciliation decided for one enrichment: the
 *  traceable remainder, its consolidated sources, what was pruned,
 *  and the typed failure — set only when pruning emptied the
 *  enrichment entirely. An uncited call is not a violation: every
 *  recorded call stays an audit row whether the enrichment cited
 *  it or not. */
export interface WebReconciliation {
  /** The enrichment's traceable remainder. */
  readonly enrichment: string;
  readonly sources: readonly WebSource[];
  /** What was pruned; undefined when every citation traced. */
  readonly pruned: WebPrunedCitations | undefined;
  /** The typed failure, undefined unless pruning left nothing. */
  readonly failure: string | undefined;
}

/** Reconcile the enrichment against the audit: every surviving
 *  citation must trace to a recorded call. A bullet citing a URL
 *  the audit cannot account for is pruned whole with its citations
 *  recorded; the strict case survives in exactly one place — a
 *  pruning that empties the enrichment is the typed failure. */
export function reconcileWebSources(
  enrichment: string,
  calls: readonly WebCall[],
): WebReconciliation {
  const audited = new Set(calls.flatMap((call) => call.urls));
  const { text, pruned } = pruneUntraceableBullets(enrichment, audited);

  if (pruned !== undefined && text === "") {
    return {
      enrichment: text,
      sources: [],
      pruned,
      failure: `enrichment empty after pruning ${pruned.count} untraceable ${pruned.count === 1 ? "citation" : "citations"}: ${pruned.urls.join(", ")} (${citationGate(pruned.urls.length)})`,
    };
  }

  const cited = extractUrls(text);

  return {
    enrichment: text,
    sources: consolidatedSources(cited, calls),
    pruned,
    failure: undefined,
  };
}
