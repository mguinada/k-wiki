/**
 * The `--web` run's machine audit: every web tool call parsed from
 * the enrichment run's `--mode json` event stream, the cited-URL
 * extraction, and the reconciliation that fails a citation the audit
 * cannot account for. Pure query-domain code — text in, data out; the
 * artifact shape it feeds lives in web-artifact.ts.
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

/** What the sources reconciliation decided for one enrichment. */
export interface WebReconciliation {
  readonly sources: readonly WebSource[];
  /** The audit failure, undefined when the enrichment reconciles. */
  readonly failure: string | undefined;
}

/** Reconcile the enrichment against the audit, both directions: a
 *  cited URL the audit cannot account for is a build failure, and a
 *  call whose exposed URLs were never cited is an uncited call (the
 *  query-targeted search and failed calls are exempt). */
export function reconcileWebSources(
  enrichment: string,
  calls: readonly WebCall[],
): WebReconciliation {
  const cited = extractUrls(enrichment);

  for (const url of cited) {
    if (!calls.some((call) => call.urls.includes(url))) {
      return {
        sources: [],
        failure: `cited URL absent from the audit table: ${url}`,
      };
    }
  }

  for (const call of calls) {
    const uncited =
      call.tool !== "web_search" &&
      !call.failed &&
      call.urls.length > 0 &&
      !call.urls.some((url) => cited.includes(url));

    if (uncited) {
      return {
        sources: [],
        failure: `uncited web call: ${call.tool} ${call.urls.join(", ")}`,
      };
    }
  }

  return { sources: consolidatedSources(cited, calls), failure: undefined };
}
