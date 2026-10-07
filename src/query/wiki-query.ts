/**
 * wiki-query: the terminal front-end for asking questions against
 * the built wiki (guide §16, issues #67 and #72). Filing is
 * two-stage; stage 2 is deterministic (file-last.ts).
 *
 *  Stage 1 (default) — `wiki-query <question>` is always answer-only.
 *  It composes prompts/query.md with the question, runs the agent CLI
 *  non-interactively in the data repo root, prints the answer, and
 *  persists the run to outputs/last-query.md. The guardrail is
 *  mechanical, not prompt-deep: any change under wiki/ during the
 *  run — a commit the agent makes included — reverts the data repo
 *  to its pre-run state and fails the run.
 *
 *  Stage 1 with `--web` runs two phases: a web-blind core run, then
 *  an opt-in, audited, partitioned enrichment run (web-enrich.ts).
 */

import { join } from "node:path";
import { withHeartbeat } from "../cli/progress.ts";
import type { RunContext } from "../cli/run-context.ts";
import { statusSince } from "../data/git.ts";
import {
  type AgentRunner,
  readPrompt,
  spawnAgent,
} from "../ingest/agent-run.ts";
import { runnerEnv } from "../ingest/agent-runner.ts";
import {
  type AgentSettings,
  formatInvocation,
  loadAgentSettings,
  runnerFor,
} from "../ingest/agent-settings.ts";
import {
  capturePreRunState,
  type PreRunState,
  revertToPreRun,
} from "../ingest/guardrails.ts";
import {
  citedPages,
  type QueryArtifact,
  writeQueryArtifact,
} from "./file-last.ts";
import {
  enrichmentArtifact,
  GAP_HINT_LINE,
  WEB_ENRICH_PROMPT_FILE,
  WEB_UNAVAILABLE_WARNING,
  withGapHint,
} from "./web-enrich.ts";

/**
 * Compose the agent message: the query prompt, the question, and the
 * answer-only mode — stage 1 only answers.
 */
export function composeQueryPrompt(
  promptText: string,
  question: string,
): string {
  return [
    promptText,
    "",
    `Question: ${question}`,
    "",
    "Mode: answer-only — write nothing: no query page, no index.md or log.md change, no edit anywhere under wiki/; the reply is the only output. The wrapper saves it; the human alone decides later whether to file it.",
  ].join("\n");
}

/** Liveness prefix; the animated sink keeps these on one line. */
export const QUERY_HEARTBEAT_PREFIX = "wiki-query: querying the wiki";

/** Where stage 1 persists the run in the outputs dir. */
export const LAST_QUERY_FILE = "last-query.md";

export interface QueryOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The run context: the ambient trio and canonical paths, built at
   *  the CLI boundary (issue #257); the agent runs in its data root. */
  readonly run: RunContext;
  /** Directory holding query.md. */
  readonly promptsDir: string;
  /** Directory the saved answer is written to. */
  readonly outputsDir: string;
  /** The question, passed to the agent inside the composed prompt. */
  readonly question: string;
  /** Agent runner; defaults to the real spawn. */
  readonly runAgent?: AgentRunner;
  /** Kill the agent run after this many milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while an agent phase runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Opt-in web enrichment (`--web`): a two-phase run whose core
   *  answer stays web-blind and whose enrichment is partitioned,
   *  audited, and machine-assembled after it. Default: off. */
  readonly web?: boolean;
  /** The rerun hint appended to a gap answer; the wiki-query CLI's
   *  own `--web` line by default. A surface that cannot serve the
   *  flag passes its own. */
  readonly gapHint?: string;
}

export interface QueryResult {
  /** The answer, trimmed; a `--web` run returns the full partitioned
   *  document — core answer, then the web sections. */
  readonly answer: string;
  /** Where the run was persisted (outputs/last-query.md). */
  readonly artifactPath: string;
  /** A degraded `--web` run's warning, for the caller to render in
   *  the warning color; undefined otherwise. */
  readonly warning?: string;
}

/** Fail the run when the answer-only contract was violated: revert, then throw. */
async function assertWikiUnchanged(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  onProgress: (message: string) => void,
): Promise<void> {
  const { entries, changed, headMoved } = await statusSince(
    dataRoot,
    env,
    pre,
    "wiki",
  );

  if (changed.length > 0 || headMoved) {
    const revertTo = pre.commit.slice(0, 8);
    const reason =
      changed.length > 0 ? "wiki changed" : "the data repo's HEAD moved";

    onProgress(
      `wiki-query: ${reason} during the answer-only run — reverting to ${revertTo}`,
    );
    await revertToPreRun(dataRoot, env, pre, entries);

    const violations = [
      ...(changed.length > 0 ? [`wrote to wiki/ (${changed.join(", ")})`] : []),
      ...(headMoved ? ["moved the data repo's HEAD"] : []),
    ];

    throw new Error(
      `answer-only run ${violations.join(" and ")}; reverted to ${revertTo} — the answer was saved nowhere; rerun the question`,
    );
  }
}

/** One agent spawn with the query heartbeat around it; returns the
 *  agent's stdout, the heartbeat always cleared. */
async function spawnWithHeartbeat(
  options: QueryOptions,
  settings: AgentSettings,
  args: readonly string[],
  prompt: string,
  runAgent: AgentRunner,
): Promise<string> {
  const { run } = options;
  const { env, temp } = runnerEnv(settings, run.env);
  const { stdout } = await withHeartbeat(
    {
      onProgress: run.onProgress,
      prefix: QUERY_HEARTBEAT_PREFIX,
      intervalMs: options.heartbeatMs,
    },
    () =>
      runAgent(settings.command, args, {
        cwd: run.dataRoot,
        env,
        managedTemp: temp,
        stdin: runnerFor(settings).stdin(prompt),
        reportPath: runnerFor(settings).reportPath(args),
        timeoutMs: options.timeoutMs,
      }),
  );

  return stdout;
}

/** The plain (or degraded) artifact: core answer plus warning. */
function coreArtifact(
  options: QueryOptions,
  timestamp: string,
  coreAnswer: string,
  warning?: string,
): QueryArtifact {
  return {
    question: options.question,
    timestamp,
    pages: citedPages(coreAnswer),
    answer: coreAnswer,
    ...(warning !== undefined && { webWarning: warning }),
  };
}

/** The web-blind phase-1 run: compose, announce, spawn, trim. */
async function corePhase(
  options: QueryOptions,
  settings: AgentSettings,
  runAgent: AgentRunner,
): Promise<string> {
  const { run } = options;
  const promptText = await readPrompt(join(options.promptsDir, "query.md"));
  const composed = composeQueryPrompt(promptText, options.question);
  const args = runnerFor(settings).answerArgs(settings, composed, {
    root: run.dataRoot,
  });
  run.onProgress(
    `wiki-query: invoking agent: ${formatInvocation(
      // The answer-only surface omits the isolation posture: a run
      // that cannot write needs no isolation signal (issue #434).
      runnerFor(settings).invocation(settings, { posture: false }),
    )}`,
  );

  const stdout = await spawnWithHeartbeat(
    options,
    settings,
    args,
    composed,
    runAgent,
  );

  run.onProgress("wiki-query: agent finished");

  const trimmed = stdout.trim();

  if (trimmed === "") {
    throw new Error("the agent produced no answer");
  }

  return trimmed;
}

/** Refuse `--web` up front on a lane whose capability manifest
 *  cannot serve the web grant: the failure lands before any spawn,
 *  so no model pass is ever paid. */
function assertWebSupported(settings: AgentSettings): void {
  const refusal = runnerFor(settings).capabilities.web.unsupportedReason;

  if (refusal !== undefined) {
    throw new Error(`--web refused — ${refusal}`);
  }
}

/**
 * One headless answer-only query run: capture the pre-run state,
 * compose, invoke, then verify mechanically that wiki/ did not move —
 * a wiki agent that writes despite the prompt is caught, reverted,
 * and failed — before persisting the run. With `--web` the run is
 * two-phase (see web-enrich.ts): the web-blind core, then the
 * partitioned, audited enrichment; every degradation keeps the core
 * and never errors out the query.
 */
export async function runWikiQuery(
  options: QueryOptions,
): Promise<QueryResult> {
  const { run } = options;
  const { env, now, onProgress, dataRoot } = run;
  const settings = await loadAgentSettings(options.settingsPath);

  onProgress(`wiki-query: data repo ${dataRoot}`);

  const webRequested = options.web === true;

  // A lane whose capability manifest refuses the web grant fails the
  // run here, before any spawn — no model pass is ever paid. Distinct
  // from the degradation path below: the web capability absent on a
  // lane that can serve the grant degrades; a lane that cannot serve
  // it at all refuses.
  if (webRequested) {
    assertWebSupported(settings);
  }

  const webAvailable =
    webRequested && (await runnerFor(settings).capabilities.web.installed(env));

  if (webRequested && webAvailable) {
    onProgress(
      "wiki-query: --web enabled — this run makes two agent passes and will be slower and may cost more",
    );
  }

  const runAgent = options.runAgent ?? spawnAgent;
  const pre = await capturePreRunState(dataRoot, env);
  const coreAnswer = withGapHint(
    await corePhase(options, settings, runAgent),
    options.gapHint ?? GAP_HINT_LINE,
  );

  await assertWikiUnchanged(dataRoot, env, pre, onProgress);

  const artifactPath = join(options.outputsDir, LAST_QUERY_FILE);
  const timestamp = now().toISOString();

  if (!webRequested) {
    const artifact = coreArtifact(options, timestamp, coreAnswer);

    await writeQueryArtifact(artifactPath, artifact);
    onProgress(`wiki-query: answer saved to ${artifactPath}`);

    return { answer: coreAnswer, artifactPath };
  }

  if (!webAvailable) {
    onProgress(WEB_UNAVAILABLE_WARNING);

    const artifact = coreArtifact(
      options,
      timestamp,
      coreAnswer,
      WEB_UNAVAILABLE_WARNING,
    );

    await writeQueryArtifact(artifactPath, artifact);
    onProgress(`wiki-query: answer saved to ${artifactPath}`);

    return {
      answer: coreAnswer,
      artifactPath,
      warning: WEB_UNAVAILABLE_WARNING,
    };
  }

  const enrichment = await enrichmentArtifact(
    {
      question: options.question,
      timestamp,
      pages: citedPages(coreAnswer),
      answer: coreAnswer,
    },
    {
      spawn: {
        command: settings.command,
        grantDisplay: runnerFor(settings).capabilities.web.grantArgs.join(" "),
        args: (composed: string) =>
          runnerFor(settings).webEnrichArgs(settings, composed, {
            root: dataRoot,
          }),
        stdin: (composed: string) => runnerFor(settings).stdin(composed),
        reportPath: runnerFor(settings).reportPath,
        env: () => runnerEnv(settings, env, { web: true }),
        outputContract: () => runnerFor(settings).webOutputContract(),
        parse: (stdout: string, now: () => Date) =>
          runnerFor(settings).parseWebReport(stdout, now),
      },
      question: options.question,
      promptText: await readPrompt(
        join(options.promptsDir, WEB_ENRICH_PROMPT_FILE),
      ).catch(() => undefined),
      run,
      runAgent,
      timeoutMs: options.timeoutMs,
      heartbeatMs: options.heartbeatMs,
    },
  );

  // The enrichment run is write-tool-less by grant, and the guard
  // is mechanical anyway: any wiki movement reverts and fails the
  // whole run.
  await assertWikiUnchanged(dataRoot, env, pre, onProgress);

  await writeQueryArtifact(artifactPath, enrichment.artifact);
  onProgress(`wiki-query: answer saved to ${artifactPath}`);

  return {
    answer: enrichment.answer,
    artifactPath,
    ...(enrichment.warning !== undefined && {
      warning: enrichment.warning,
    }),
  };
}
