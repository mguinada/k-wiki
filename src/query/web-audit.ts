/**
 * The `--web` run's machine audit: every web tool call parsed from
 * the enrichment run's `--mode json` event stream, the cited-URL
 * extraction, and the reconciliation that prunes a citation the
 * audit cannot account for down to the traceable remainder. Pure
 * query-domain code — text in, data out; the artifact shape it
 * feeds lives in web-artifact.ts.
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

/** The call arguments' URL targets, if any. */
function argumentUrls(args: Record<string, unknown>): string[] {
  const single = args.url;
  const many = args.urls;

  if (typeof single === "string" && single !== "") {
    return [single];
  }

  return Array.isArray(many)
    ? many.filter((url): url is string => typeof url === "string" && url !== "")
    : [];
}

/** The call arguments' target text: query text or URL(s). */
function callTarget(args: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const key of ["query", "claim", "queries", "url", "urls"]) {
    const value = args[key];

    if (typeof value === "string" && value !== "") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      parts.push(
        ...value.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  }

  return parts.join(" | ");
}

/** A message content array's object blocks: the shared narrowing
 *  the text and toolCall readers both consume. */
function contentBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null,
      )
    : [];
}

/** The text of a message's content blocks, concatenated. */
function contentText(content: unknown): string {
  return contentBlocks(content)
    .filter(
      (block): block is { type: string; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** The toolCall blocks of one message, as parsed call seeds. */
function messageToolCalls(
  content: unknown,
): { id: string; name: string; args: Record<string, unknown> }[] {
  const calls: { id: string; name: string; args: Record<string, unknown> }[] =
    [];

  for (const block of contentBlocks(content)) {
    if (block.type !== "toolCall" || typeof block.name !== "string") {
      continue;
    }

    const record = block as { id?: unknown; name: string; arguments?: unknown };

    calls.push({
      id: typeof record.id === "string" ? record.id : "",
      name: record.name,
      args:
        typeof record.arguments === "object" && record.arguments !== null
          ? (record.arguments as Record<string, unknown>)
          : {},
    });
  }

  return calls;
}

/** One JSONL line as an event object, undefined for non-JSON lines. */
function parseEvent(line: string): Record<string, unknown> | undefined {
  try {
    const event: unknown = JSON.parse(line);

    return typeof event === "object" && event !== null
      ? (event as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Mutable accumulation state of one stream parse. */
interface StreamState {
  readonly calls: { id: string; call: WebCall }[];
  readonly results: Map<
    string,
    { text: string; failed: boolean; total: number | undefined }
  >;
  lastText: string;
}

/** One message_end event's message, as far as the parser reads it. */
interface AgentRecord {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  details?: unknown;
}

/** Fold one assistant message into the parse state: its text, and
 *  one call seed per toolCall block. */
function foldAssistantMessage(state: StreamState, record: AgentRecord) {
  const text = contentText(record.content);

  if (text !== "") {
    state.lastText = text;
  }

  const timestamp = typeof record.timestamp === "number" ? record.timestamp : 0;

  for (const seed of messageToolCalls(record.content)) {
    state.calls.push({
      id: seed.id,
      call: {
        tool: seed.name,
        target: callTarget(seed.args),
        results: 0,
        timestamp,
        urls: argumentUrls(seed.args),
        failed: false,
      },
    });
  }
}

/** Fold one toolResult message into the parse state, keyed by its
 *  call id: result text, error flag, reported result count. */
function foldToolResultMessage(state: StreamState, record: AgentRecord) {
  if (typeof record.toolCallId !== "string") {
    return;
  }

  const details =
    typeof record.details === "object" && record.details !== null
      ? (record.details as Record<string, unknown>)
      : undefined;
  const total = details?.totalResults;

  state.results.set(record.toolCallId, {
    text: contentText(record.content),
    failed: record.isError === true,
    total: typeof total === "number" ? total : undefined,
  });
}

/** Fold one `message_end` event into the parse state. */
function foldMessageEnd(state: StreamState, event: Record<string, unknown>) {
  const message = event.message;

  if (typeof message !== "object" || message === null) {
    return;
  }

  const record = message as AgentRecord;

  if (record.role === "assistant") {
    foldAssistantMessage(state, record);

    return;
  }

  if (record.role === "toolResult") {
    foldToolResultMessage(state, record);
  }
}

/** Finish each call with its tool result: URLs from the result text,
 *  the reported result count, and the failure flag. */
function finishCalls(state: StreamState): WebCall[] {
  return state.calls.map(({ id, call }) => {
    const result = state.results.get(id);

    if (result === undefined) {
      return call;
    }

    return {
      ...call,
      urls: [...new Set([...call.urls, ...extractUrls(result.text)])],
      results: result.total ?? (call.urls.length > 0 ? call.urls.length : 0),
      failed: result.failed,
    };
  });
}

/** What one enrichment run's `--mode json` stream recorded: every
 *  web tool call, in order, plus the run's final text. */
export interface ParsedAgentStream {
  readonly calls: readonly WebCall[];
  readonly enrichment: string;
}

/** Parse the enrichment run's JSONL event stream. Non-JSON lines are
 *  skipped; the final text is the last assistant message that
 *  carried text blocks. */
export function parseAgentJsonStream(stdout: string): ParsedAgentStream {
  const state: StreamState = { calls: [], results: new Map(), lastText: "" };

  for (const line of stdout.split("\n")) {
    const event = parseEvent(line.trim());

    if (event?.type === "message_end") {
      foldMessageEnd(state, event);
    }
  }

  return { calls: finishCalls(state), enrichment: state.lastText.trim() };
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
