/**
 * The `--web` enrichment run (the query surface of the web access
 * design): the phase-2 spawn whose core answer stays web-blind. The
 * web grant is per-run argv injection on the query spawn path only —
 * the shared isolate.extensions list is never touched — and any
 * failure lands in the degradation path without touching the core.
 * The audit itself lives in web-audit.ts; this module composes the
 * run and renders its outcome.
 */

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

/** The web extension source, as the pi grant names it. */
export const WEB_EXTENSION_SOURCE = "npm:pi-web-access";

/** The grant width: search + fetch, pi `--tools` allowlist. */
export const WEB_TOOL_ALLOWLIST = "web_search,source_check,fetch_content";

/** The machine-readable output mode of the enrichment run. */
export const WEB_OUTPUT_MODE = "json";

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

/** The core answer with the gap hint appended when it is one. */
export function withGapHint(answer: string): string {
  return isGapAnswer(answer) ? `${answer}\n\n${GAP_HINT_LINE}` : answer;
}

/** The agent identity the enrichment run spawns with, structurally:
 *  the caller passes its loaded agent settings. */
export interface WebAgentIdentity {
  readonly command: string;
  readonly model: string;
  readonly reasoning: string;
  readonly provider?: string;
  readonly isolate?: boolean;
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
  },
) => Promise<{ stdout: string; stderr: string }>;

/** The enrichment run's argv: ambient isolation first (the caller's
 *  isolation flags, the same ones every closed-world spawn site
 *  uses), then this run's deliberate web grant — extension plus tool
 *  allowlist — then the JSON output mode the audit parses, then the
 *  agent identity and prompt. Never the shared isolate.extensions
 *  list. */
export function webEnrichAgentArgs(
  identity: WebAgentIdentity,
  isolationFlags: readonly string[],
  composed: string,
): string[] {
  return [
    ...(identity.isolate === false ? [] : [...isolationFlags]),
    "-e",
    WEB_EXTENSION_SOURCE,
    "--tools",
    WEB_TOOL_ALLOWLIST,
    ...(identity.provider ? ["--provider", identity.provider] : []),
    "--model",
    identity.model,
    "--thinking",
    identity.reasoning,
    "--mode",
    WEB_OUTPUT_MODE,
    "--print",
    composed,
  ];
}

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
  /** The `## Web enrichment` section text, machine-headed. */
  readonly enrichmentSection: string;
  /** The `## Web sources` section text, machine-computed. */
  readonly sourcesSection: string;
  /** The `## Web calls audit` section text, machine-recorded. */
  readonly auditSection: string;
  /** The consolidated sources, for the artifact header's count. */
  readonly sources: readonly WebSource[];
  /** The recorded calls, in order. */
  readonly calls: readonly WebCall[];
  /** When the newest call ran, ISO 8601; the run clock when none. */
  readonly retrieved: string;
  /** The machine-owned sections, artifact-ready. */
  readonly web: WebArtifactSections;
}

/** The failed outcome: the reason stays a progress-line detail; the
 *  artifact carries the fixed degradation warning. */
export interface WebEnrichmentFailure {
  readonly kind: "failed";
  readonly reason: string;
}

export type WebEnrichmentOutcome = WebEnrichmentOk | WebEnrichmentFailure;

export interface WebEnrichmentOptions {
  /** The agent identity to spawn (the loaded agent settings). */
  readonly identity: WebAgentIdentity;
  /** The caller's ambient isolation flags for the phase-2 argv. */
  readonly isolationFlags: readonly string[];
  readonly question: string;
  /** The finished core document, read-only input. */
  readonly coreAnswer: string;
  /** The read enrichment prompt text (web-enrich.md). */
  readonly promptText: string;
  readonly run: RunContext;
  readonly runAgent: AgentSpawn;
  readonly timeoutMs?: number | undefined;
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
 *  parse the audit from the event stream, reconcile the sources,
 *  and render the three machine-owned sections. Any failure —
 *  spawn, timeout, empty output, audit violation — lands in the
 *  degradation path; it never touches the core answer. */
export async function runWebEnrichment(
  options: WebEnrichmentOptions,
): Promise<WebEnrichmentOutcome> {
  const { run, identity } = options;

  const composed = composeEnrichmentPrompt(
    options.promptText,
    options.question,
    options.coreAnswer,
    run.now().toISOString().slice(0, 10),
  );

  run.onProgress(
    `wiki-query: web enrichment run: ${identity.command} -e ${WEB_EXTENSION_SOURCE} --tools ${WEB_TOOL_ALLOWLIST}`,
  );

  let stdout: string;

  try {
    ({ stdout } = await options.runAgent(
      identity.command,
      webEnrichAgentArgs(identity, options.isolationFlags, composed),
      {
        cwd: run.dataRoot,
        env: run.env,
        timeoutMs: options.timeoutMs,
      },
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
    enrichment: renderWebEnrichmentSection(enrichment),
    sources: renderWebSourcesSection(reconciliation.sources),
    audit: renderWebAuditSection(parsed.calls),
  };

  return {
    kind: "ok",
    web,
    enrichmentSection: web.enrichment,
    sourcesSection: web.sources,
    auditSection: web.audit,
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
    readonly identity: WebAgentIdentity;
    readonly isolationFlags: readonly string[];
    readonly question: string;
    /** The read enrichment prompt text; undefined degrades the run. */
    readonly promptText: string | undefined;
    readonly run: RunContext;
    readonly runAgent: AgentSpawn;
    readonly timeoutMs?: number | undefined;
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
          identity: options.identity,
          isolationFlags: options.isolationFlags,
          question: options.question,
          coreAnswer: core.answer,
          promptText: options.promptText,
          run,
          runAgent: options.runAgent,
          timeoutMs: options.timeoutMs,
        });

  if (outcome.kind === "failed") {
    run.onProgress(`wiki-query: enrichment failed — ${outcome.reason}`);

    return {
      artifact: { ...core, webWarning: WEB_FAILED_WARNING },
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
