/**
 * The enrichment run's report parses, one per lane's output
 * language: pi's `--mode json` event stream and the codex report
 * contract — the enrichment bullets, then one fenced
 * `k-wiki-web-audit` block with one `tool | target | urls` line per
 * web tool call. Both return the same ParsedWebReport; the codex
 * parse is strict, because the audit's honesty is the citation
 * gate's input.
 */

import { extractUrls, type WebCall } from "./web-audit.ts";

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

/** What one enrichment run's output recorded: every web tool call,
 *  in order, plus the run's final text. The lane-neutral shape both
 *  report parses return (pi's event stream, codex's report
 *  contract). */
export interface ParsedWebReport {
  readonly calls: readonly WebCall[];
  readonly enrichment: string;
}

/** Parse the enrichment run's JSONL event stream. Non-JSON lines are
 *  skipped; the final text is the last assistant message that
 *  carried text blocks. */
export function parseAgentJsonStream(stdout: string): ParsedWebReport {
  const state: StreamState = { calls: [], results: new Map(), lastText: "" };

  for (const line of stdout.split("\n")) {
    const event = parseEvent(line.trim());

    if (event?.type === "message_end") {
      foldMessageEnd(state, event);
    }
  }

  return { calls: finishCalls(state), enrichment: state.lastText.trim() };
}

/** The fence line that opens a codex report's web-audit block: the
 *  one machine-readable section the contract asks the agent to
 *  close its reply with. */
export const CODEX_AUDIT_FENCE = "```k-wiki-web-audit";

/** The closing fence of a fenced code block. */
const CODE_FENCE = "```";

/** Where the report splits: the opening fence's line index, as far
 *  as the contract cares — the block must exist at all. */
function auditFenceIndex(lines: readonly string[]): number {
  const index = lines.indexOf(CODEX_AUDIT_FENCE);

  if (index < 0) {
    throw new Error(`the codex report carried no ${CODEX_AUDIT_FENCE} block`);
  }

  return index;
}

/** One audit-block line as a call: `tool | target | urls`, the urls
 *  space-separated; a malformed line is a named failure, not a
 *  silent gap in the audit. */
function auditCall(line: string, at: number): WebCall {
  const fields = line.split("|").map((field) => field.trim());

  if (fields.length !== 3) {
    throw new Error(
      `the codex ${CODEX_AUDIT_FENCE} block carried a malformed call line: ${line}`,
    );
  }

  const [tool, target, urlsField] = fields as [string, string, string];
  const urls = [...new Set(urlsField.split(/\s+/).filter((url) => url !== ""))];

  return {
    tool,
    target,
    results: urls.length,
    timestamp: at,
    urls,
    failed: false,
  };
}

/** Parse a codex enrichment report: the enrichment text before the
 *  fenced web-audit block, and every call the block records — one
 *  `tool | target | urls` line per web tool call — with timestamps
 *  stamped from the wrapper's clock. The contract is strict: a
 *  report without the block, with an unclosed block, with a
 *  malformed call line, or with content after the block fails named
 *  — the audit's honesty is the gate's input. */
export function parseCodexReport(
  report: string,
  now: () => Date,
): ParsedWebReport {
  const lines = report.split("\n");
  const open = auditFenceIndex(lines);
  const close = lines.indexOf(CODE_FENCE, open + 1);

  if (close < 0) {
    throw new Error(`the codex ${CODEX_AUDIT_FENCE} block never closed`);
  }

  const trailing = lines.slice(close + 1).find((line) => line.trim() !== "");

  if (trailing !== undefined) {
    throw new Error(
      `the codex report carried content after the ${CODEX_AUDIT_FENCE} block`,
    );
  }

  const at = now().getTime();

  return {
    calls: lines
      .slice(open + 1, close)
      .filter((line) => line.trim() !== "")
      .map((line) => auditCall(line, at)),
    enrichment: lines.slice(0, open).join("\n").trim(),
  };
}
