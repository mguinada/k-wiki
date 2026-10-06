/**
 * The `--web` enrichment run (the query surface of the web access
 * design): the phase-2 spawn whose core answer stays web-blind. The
 * web grant is per-run argv injection on the query spawn path only —
 * the shared isolate.extensions list is never touched — and any
 * failure lands in the degradation path without touching the core.
 * The audit itself lives in web-audit.ts; this module composes the
 * prompt, runs the caller-wired spawn (the agent's grant and flag
 * language is the Runner adapter's, issue #434), and renders the
 * outcome.
 */

import { withHeartbeat } from "../cli/progress.ts";
import type { RunContext } from "../cli/run-context.ts";
import { artifactBody, type QueryArtifact } from "./file-last.ts";
import {
  renderWebAuditSection,
  renderWebEnrichmentSection,
  renderWebSourcesSection,
  sanitizeEnrichment,
  WEB_MODE,
  type WebArtifactSections,
} from "./web-artifact.ts";
import {
  parseAgentJsonStream,
  reconcileWebSources,
  type WebCall,
  type WebSource,
} from "./web-audit.ts";

/** Liveness prefix of the enrichment phase's heartbeat; the animated
 *  sink keeps these on one line, like the core phase's. */
export const WEB_ENRICH_HEARTBEAT_PREFIX = "wiki-query: web enrichment running";

/** Degradation warning, plugin state: verbatim design wording. */
export const WEB_UNAVAILABLE_WARNING =
  "WARNING — `--web` requested, but the pi-web-access plugin is not available — continuing in wiki-only mode.";

/** Degradation warning, run state: distinct wording, same severity. */
export const WEB_FAILED_WARNING =
  "WARNING — `--web` enrichment failed (web-call or tool failure) — continuing with the wiki-only core answer.";

/** The hint line appended to a gap answer: opting into enrichment
 *  stays one step; there is no automatic enrichment. */
export const GAP_HINT_LINE =
  "The wiki could not answer this question — rerunning with `--web` may enrich the topic from the web.";

/** The gap marker the query prompt already mandates ("If the wiki
 *  cannot answer the question, say so"): a gap answer says so. */
const GAP_MARKER = /cannot answer/i;

/** True when a core answer is a wiki gap: the hint may then point
 *  at the opt-in enrichment. Deterministic text scan. */
export function isGapAnswer(answer: string): boolean {
  return GAP_MARKER.test(answer);
}

/** The core answer with the gap hint appended when it is one. The
 *  hint is the caller surface's own: the wiki-query CLI names its
 *  own `--web` flag; a surface that cannot serve the flag names the
 *  CLI that can. */
export function withGapHint(
  answer: string,
  hint: string = GAP_HINT_LINE,
): string {
  return isGapAnswer(answer) ? `${answer}\n\n${hint}` : answer;
}

/** The enrichment spawn, wired by the caller's Runner adapter
 *  (issue #434): the agent command, the grant tail the progress line
 *  names, and the argv builder for a composed prompt — the adapter
 *  owns the grant's flag language (ambient isolation, the web
 *  extension grant, the JSON output mode, identity, prompt). */
export interface WebEnrichmentSpawn {
  readonly command: string;
  /** The grant's display tail, e.g. `-e npm:pi-web-access --tools
   *  web_search,source_check,fetch_content`. */
  readonly grantDisplay: string;
  args(composed: string): readonly string[];
  stdin?(composed: string): string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** The agent spawn the enrichment run goes through, structurally:
 *  the caller passes its AgentRunner. */
export type AgentSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number | undefined;
    stdin?: string | undefined;
  },
) => Promise<{ stdout: string; stderr: string }>;

/** The enrichment prompt file, beside query.md in the prompts dir. */
export const WEB_ENRICH_PROMPT_FILE = "web-enrich.md";

/** Compose the enrichment prompt: the prompt file's policy text,
 *  the question, and the finished core document as read-only input,
 *  plus the output contract. The egress policy ships verbatim in
 *  the prompt file; nothing here paraphrases it. */
export function composeEnrichmentPrompt(
  promptText: string,
  question: string,
  coreAnswer: string,
  todayUtc: string,
): string {
  return [
    promptText,
    "",
    `Question: ${question}`,
    "",
    "The finished core answer (read-only input — never rewrite, restate, or annotate it):",
    "",
    coreAnswer,
    "",
    `Output contract: reply with only the enrichment bullets — no headings of your own, no sources list, no audit table; the wrapper writes those sections and computes them from the recorded tool calls. Today's date is ${todayUtc} (UTC): tag every link you cite with it as the retrieval date. Write nothing to disk; the reply is your only output.`,
  ].join("\n");
}

/** The ok outcome of one enrichment run. */
export interface WebEnrichmentOk {
  readonly kind: "ok";
  /** The consolidated sources, for the artifact header's count. */
  readonly sources: readonly WebSource[];
  /** The recorded calls, in order. */
  readonly calls: readonly WebCall[];
  /** When the newest call ran, ISO 8601; the run clock when none. */
  readonly retrieved: string;
  /** The machine-owned sections, artifact-ready. */
  readonly web: WebArtifactSections;
}

/** The failed outcome: the concrete reason goes to the progress
 *  line and is persisted beside the fixed degradation warning as
 *  the artifact's `webFailureReason` header. */
export interface WebEnrichmentFailure {
  readonly kind: "failed";
  readonly reason: string;
}

export type WebEnrichmentOutcome = WebEnrichmentOk | WebEnrichmentFailure;

export interface WebEnrichmentOptions {
  /** The enrichment spawn, wired by the caller's Runner adapter
   *  (issue #434). */
  readonly spawn: WebEnrichmentSpawn;
  readonly question: string;
  /** The finished core document, read-only input. */
  readonly coreAnswer: string;
  /** The read enrichment prompt text (web-enrich.md). */
  readonly promptText: string;
  readonly run: RunContext;
  readonly runAgent: AgentSpawn;
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while the enrichment spawn runs; the same
   *  default and shape as the core spawn's. */
  readonly heartbeatMs?: number | undefined;
}

/** The ISO timestamp of the newest recorded call, or the run
 *  clock's when the enrichment made no calls. */
function newestCallIso(calls: readonly WebCall[], now: () => Date): string {
  if (calls.length === 0) {
    return now().toISOString();
  }

  return new Date(
    Math.max(...calls.map((call) => call.timestamp)),
  ).toISOString();
}

/** Run the enrichment phase: compose, spawn with the web grant,
 *  parse the audit from the event stream, reconcile the sources —
 *  pruning untraceable citations down to the traceable remainder —
 *  and render the three machine-owned sections. Any failure —
 *  spawn, timeout, empty output, a pruning that empties the
 *  enrichment — lands in the degradation path; it never touches the
 *  core answer. */
export async function runWebEnrichment(
  options: WebEnrichmentOptions,
): Promise<WebEnrichmentOutcome> {
  const { run, spawn } = options;

  const composed = composeEnrichmentPrompt(
    options.promptText,
    options.question,
    options.coreAnswer,
    run.now().toISOString().slice(0, 10),
  );

  run.onProgress(
    `wiki-query: web enrichment run: ${spawn.command} ${spawn.grantDisplay}`,
  );

  let stdout: string;

  try {
    ({ stdout } = await withHeartbeat(
      {
        onProgress: run.onProgress,
        prefix: WEB_ENRICH_HEARTBEAT_PREFIX,
        intervalMs: options.heartbeatMs,
      },
      () =>
        options.runAgent(spawn.command, spawn.args(composed), {
          cwd: run.dataRoot,
          env: spawn.env ?? run.env,
          stdin: spawn.stdin?.(composed),
          timeoutMs: options.timeoutMs,
        }),
    ));
  } catch (error) {
    return { kind: "failed", reason: (error as Error).message };
  }

  const parsed = parseAgentJsonStream(stdout);

  const enrichment = sanitizeEnrichment(parsed.enrichment);

  if (enrichment === "") {
    return {
      kind: "failed",
      reason: "the enrichment run produced no output",
    };
  }

  const reconciliation = reconcileWebSources(enrichment, parsed.calls);

  if (reconciliation.failure !== undefined) {
    return { kind: "failed", reason: reconciliation.failure };
  }

  const web: WebArtifactSections = {
    enrichment: renderWebEnrichmentSection(reconciliation.enrichment),
    sources: renderWebSourcesSection(reconciliation.sources),
    audit: renderWebAuditSection(parsed.calls, reconciliation.pruned),
  };

  return {
    kind: "ok",
    web,
    sources: reconciliation.sources,
    calls: parsed.calls,
    retrieved: newestCallIso(parsed.calls, run.now),
  };
}
/** The finished core artifact's header fields, as the caller built
 *  them from the web-blind phase-1 run. */
export interface CoreArtifactFields {
  readonly question: string;
  readonly timestamp: string;
  readonly pages: readonly string[];
  readonly answer: string;
}

/** The enrichment phase's outcome: the artifact to persist, the text
 *  to return and print, and the degradation warning (undefined on
 *  success — also on the progress sink as it happens). */
export async function enrichmentArtifact(
  core: CoreArtifactFields,
  options: {
    readonly spawn: WebEnrichmentSpawn;
    readonly question: string;
    /** The read enrichment prompt text; undefined degrades the run. */
    readonly promptText: string | undefined;
    readonly run: RunContext;
    readonly runAgent: AgentSpawn;
    readonly timeoutMs?: number | undefined;
    /** Heartbeat interval while the enrichment spawn runs. */
    readonly heartbeatMs?: number | undefined;
  },
): Promise<{ artifact: QueryArtifact; answer: string; warning?: string }> {
  const { run } = options;

  const outcome: WebEnrichmentOutcome =
    options.promptText === undefined
      ? {
          kind: "failed",
          reason: `${WEB_ENRICH_PROMPT_FILE} is unavailable`,
        }
      : await runWebEnrichment({
          spawn: options.spawn,
          question: options.question,
          coreAnswer: core.answer,
          promptText: options.promptText,
          run,
          runAgent: options.runAgent,
          timeoutMs: options.timeoutMs,
          heartbeatMs: options.heartbeatMs,
        });

  if (outcome.kind === "failed") {
    run.onProgress(`wiki-query: enrichment failed — ${outcome.reason}`);

    return {
      artifact: {
        ...core,
        webWarning: WEB_FAILED_WARNING,
        webFailureReason: outcome.reason,
      },
      answer: core.answer,
      warning: WEB_FAILED_WARNING,
    };
  }

  const artifact: QueryArtifact = {
    ...core,
    mode: WEB_MODE,
    webSources: outcome.sources.length,
    webRetrieved: outcome.retrieved,
    web: outcome.web,
  };

  return { artifact, answer: artifactBody(artifact) };
}
