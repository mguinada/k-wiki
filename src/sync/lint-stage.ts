/**
 * The lint stage (issue #359): one headless quality-lint agent run
 * over the data repo's wiki, guardrailed and auto-reverted like the
 * ingest stage — extracted from wiki-sync.ts so the cycle file stays
 * orchestration-only. The stage's work is bounded by change, not by
 * clock: a successful run writes the lint-window snapshot (every
 * page's hash, `outputs/lint-window.json`, per-instance state beside
 * the ingest manifest snapshot), and the next run audits only the
 * pages that changed since plus their one-hop reverse-link neighbors
 * (prompts/lint-window.md). No snapshot (first run, foreign stamp) or
 * an explicit `--full` audits the whole wiki (prompts/lint.md). A
 * failed run leaves the snapshot untouched, so the next run retries
 * the same window; a timed-out run's guardrail-passed partial edits
 * stay in the tree and re-enter the next window through their hashes.
 * The deterministic worklists (src/wiki/worklists.ts) ride in the
 * composed prompt — the agent judges, never scans.
 */

import { join } from "node:path";
import { formatDuration } from "../cli/progress.ts";
import type { RunContext } from "../cli/run-context.ts";
import { pathExists } from "../cli/shared.ts";
import type { StatusEntry } from "../data/git.ts";
import {
  type AgentRunner,
  readPrompt,
  spawnAgent,
} from "../ingest/agent-run.ts";
import {
  type AgentSettings,
  agentArgs,
  agentCommandOverride,
  formatAgentInvocation,
  loadAgentSettings,
} from "../ingest/agent-settings.ts";
import {
  capturePreRunState,
  type GuardrailFailure,
  type PreRunState,
  revertToPreRun,
  runGuardrails,
} from "../ingest/guardrails.ts";
import { ensureLintWindowIgnored } from "../ingest/snapshot.ts";
import {
  computeWikiWorklists,
  filterWorklistsToWindow,
  renderWorklists,
} from "../wiki/worklists.ts";
import {
  deriveLintWindow,
  lintWindowPath,
  readLintWindowSnapshot,
  writeLintWindowSnapshot,
} from "./lint-window.ts";
import { toAbsolute } from "./projection.ts";

/** Liveness line while the lint agent runs (one animated line on a TTY). */
export const LINT_HEARTBEAT_PREFIX = "wiki-sync: lint agent still running";

/** The report-path placeholder each mode's prompt carries: the
 *  windowed audit's standing per-date path, and the full audit's own
 *  `-full` report. */
const WINDOW_REPORT_PLACEHOLDER = "outputs/lint-<YYYY-MM-DD>.md";
const FULL_REPORT_PLACEHOLDER = "outputs/lint-<YYYY-MM-DD>-full.md";

/** What the lint stage reports back to the cycle digest. */
export interface LintResult {
  /** Which audit ran: the windowed stage or the full sweep. */
  readonly mode: "window" | "full";
  /** Undefined after a completed audit; "empty-window" when the
   *  windowed audit had nothing to do (no existing page differs from
   *  the last successful lint) and the agent never ran. */
  readonly skipped: "empty-window" | undefined;
  /** The data-repo-relative path the prompt told the agent to write. */
  readonly reportPath: string;
  /** False when the agent finished without writing the report. */
  readonly reportWritten: boolean;
  /** The agent's final report (stdout). */
  readonly summary: string;
  /** The post-run status the stage's guardrails produced; the cycle's
   *  commit summary reuses it instead of spawning git again (B-10:
   *  no hidden child-process run inside the summary builder). */
  readonly entries: readonly StatusEntry[];
  /** The pages the windowed audit covered (the full sweep audits
   *  every page; undefined on a skip). */
  readonly windowPages: readonly string[] | undefined;
}

/** The data-repo-relative lint report path for a run's date and
 *  mode: the windowed audit keeps the standing per-date path, the
 *  full audit writes its own `-full` report so a same-day windowed
 *  audit never overwrites the sweep's record. */
export function lintReportPath(
  now: () => Date,
  mode: "window" | "full",
): string {
  const date = now().toISOString().slice(0, 10);

  return mode === "full"
    ? `outputs/lint-${date}-full.md`
    : `outputs/lint-${date}.md`;
}

export interface LintOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** Agent settings when the caller already loaded them — the cycle
   *  loads once and threads them (R-1, one settings.yml parse per
   *  run); loaded from `settingsPath` otherwise. */
  readonly settings?: AgentSettings | undefined;
  /** The run context: raw dir, data root, wiki dir, environment,
   *  clock, progress sink — built once at the CLI boundary (issue
   *  #257). The agent runs in the context's data root. */
  readonly run: RunContext;
  /** Directory holding lint.md and lint-window.md. */
  readonly promptsDir: string;
  /** Agent runner; defaults to the real non-interactive invocation. */
  readonly runAgent?: AgentRunner | undefined;
  /** Kill the agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while the agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Pre-run state captured by the caller (the wiki-sync cycle
   *  captures it once so its verification stage can revert to the
   *  same point); captured here when absent. */
  readonly pre?: PreRunState | undefined;
  /** Force the full audit (the `wiki-lint --full` door): every page,
   *  the full prompt, the snapshot still advanced on success. */
  readonly full?: boolean | undefined;
}

/** The lint agent run's outcome: its stdout, or the failure that
 *  must wait for the guardrail check before it escapes. */
interface LintAgentRun {
  readonly stdout: string;
  readonly error: unknown;
}

/** Invoke the lint agent under its heartbeat line. The run's failure
 *  is captured, not thrown: the guardrails must run first, and a
 *  guardrail failure names the agent error as its cause. */
async function invokeLintAgent(
  run: RunContext,
  options: LintOptions,
  command: string,
  args: readonly string[],
): Promise<LintAgentRun> {
  const startedAt = run.now().getTime();
  const heartbeat = setInterval(() => {
    const elapsed = formatDuration(run.now().getTime() - startedAt);

    run.onProgress(`${LINT_HEARTBEAT_PREFIX} (${elapsed})`);
  }, options.heartbeatMs ?? 60_000);

  let stdout = "";
  let error: unknown;

  try {
    ({ stdout } = await (options.runAgent ?? spawnAgent)(command, args, {
      cwd: run.dataRoot,
      env: run.env,
      timeoutMs: options.timeoutMs,
    }));
  } catch (caught) {
    error = caught;
  } finally {
    clearInterval(heartbeat);
  }

  if (error === undefined) {
    run.onProgress("wiki-sync: lint — agent finished");
  }

  return { stdout, error };
}

/** The window derivation the stage audits: the snapshot's changed
 *  pages plus their reverse-link neighbors, or the full-audit
 *  fallback when no valid snapshot exists. */
async function resolveWindow(
  run: RunContext,
  full: boolean,
): Promise<
  | { readonly mode: "full" }
  | {
      readonly mode: "window";
      readonly window: Awaited<ReturnType<typeof deriveLintWindow>>;
    }
> {
  const snapshotPath = lintWindowPath(run.dataRoot);

  await ensureLintWindowIgnored(run.dataRoot, run.onProgress);

  if (full) {
    return { mode: "full" };
  }

  const snapshot = await readLintWindowSnapshot(
    snapshotPath,
    run.dataRoot,
    run.onProgress,
  );

  if (snapshot === undefined) {
    return { mode: "full" };
  }

  return {
    mode: "window",
    window: await deriveLintWindow(run.wikiDir, snapshot),
  };
}

/** Compose the agent message: the mode's prompt with the report path
 *  substituted, the windowed page list, and the deterministic
 *  worklists (window-filtered for a windowed audit). */
async function composeLintPrompt(options: {
  readonly promptsDir: string;
  readonly mode: "window" | "full";
  readonly reportPath: string;
  readonly windowPages: readonly string[] | undefined;
  readonly wikiDir: string;
}): Promise<string> {
  const promptFile = options.mode === "window" ? "lint-window.md" : "lint.md";
  const placeholder =
    options.mode === "window"
      ? WINDOW_REPORT_PLACEHOLDER
      : FULL_REPORT_PLACEHOLDER;
  const promptText = (
    await readPrompt(join(options.promptsDir, promptFile))
  ).replaceAll(placeholder, options.reportPath);
  const worklists = await computeWikiWorklists(options.wikiDir);
  const scoped =
    options.windowPages === undefined
      ? worklists
      : filterWorklistsToWindow(worklists, options.windowPages);
  const lines = [promptText, "", renderWorklists(scoped)];

  if (options.windowPages !== undefined) {
    lines.push(
      "",
      "Pages in this audit window (changed since the last audit plus their reverse-link neighbors):",
      "",
      ...options.windowPages.map((page) => `- wiki/${page}`),
    );
  }

  return lines.join("\n");
}

/** The empty-window skip: no existing page differs from the last
 *  successful audit's record — a deletion-only change still reaches
 *  it (the deleted pages stay in the changed set but add nothing to
 *  the audited pages list) — so the agent never runs and the
 *  re-stamp write re-records the current state, pruning the deleted
 *  entries. */
async function skipEmptyWindow(
  run: RunContext,
  options: LintOptions,
  reportPath: string,
): Promise<LintResult> {
  run.onProgress(
    "wiki-sync: lint — window empty (nothing left to audit since the last audit); skipping the agent",
  );

  await writeLintWindowSnapshot(
    run.wikiDir,
    lintWindowPath(run.dataRoot),
    run.dataRoot,
  );

  const pre = options.pre ?? (await capturePreRunState(run.dataRoot, run.env));

  return {
    mode: "window",
    skipped: "empty-window",
    reportPath,
    reportWritten: false,
    summary: "",
    entries: pre.status,
    windowPages: [],
  };
}

/** The stage's mode-and-prompt announcement line. */
function modeAnnouncement(
  resolved: Awaited<ReturnType<typeof resolveWindow>>,
): string {
  if (resolved.mode === "full") {
    return "wiki-sync: lint — reading prompts/lint.md (full audit)";
  }

  return `wiki-sync: lint — reading prompts/lint-window.md (window (${resolved.window.pages.length} pages, ${resolved.window.changedCount} changed))`;
}

/** Revert to the pre-run state and reject with the guardrail
 *  failure, its cause the agent error. */
async function failGuardrailed(
  run: RunContext,
  pre: PreRunState,
  failure: GuardrailFailure,
  entries: readonly StatusEntry[],
  agentError: unknown,
): Promise<never> {
  run.onProgress(
    `wiki-sync: lint guardrail check ${failure.check} (${failure.name}) failed — reverting to ${pre.commit.slice(0, 8)}`,
  );

  await revertToPreRun(run.dataRoot, run.env, pre, entries);

  throw new Error(
    `lint guardrail check ${failure.check} (${failure.name}) failed; reverted to ${pre.commit.slice(0, 8)} — ${failure.problems.join("; ")}`,
    { cause: agentError },
  );
}

/** One headless lint run (guide §17): pick the audit window, compose
 *  the prompt with the deterministic worklists, invoke the agent in
 *  the data repo root, guardrail the result, auto-revert on a tripped
 *  check, and — only on a completed audit — advance the window
 *  snapshot. Same guardrail contract as the ingest stage. */
export async function runLintStage(options: LintOptions): Promise<LintResult> {
  const { run } = options;
  const { env, now, onProgress, dataRoot } = run;
  const settings =
    options.settings ??
    (await loadAgentSettings(options.settingsPath, { onProgress }));

  const resolved = await resolveWindow(run, options.full === true);
  const reportPath = lintReportPath(now, resolved.mode);

  if (resolved.mode === "window" && resolved.window.pages.length === 0) {
    return await skipEmptyWindow(run, options, reportPath);
  }

  const windowPages =
    resolved.mode === "window" ? resolved.window.pages : undefined;

  onProgress(modeAnnouncement(resolved));

  const promptText = await composeLintPrompt({
    promptsDir: options.promptsDir,
    mode: resolved.mode,
    reportPath,
    windowPages,
    wikiDir: run.wikiDir,
  });
  const args = agentArgs(settings, promptText);
  const pre = options.pre ?? (await capturePreRunState(dataRoot, env));

  // A launcher that already resolved the agent binary (issue #399)
  // hands it over through the environment; it wins over the
  // settings' bare command name the launchd PATH cannot resolve.
  const command = agentCommandOverride(env) ?? settings.command;

  onProgress(
    `wiki-sync: lint — invoking agent: ${formatAgentInvocation({
      ...settings,
      command,
    })}`,
  );

  const { stdout, error: agentError } = await invokeLintAgent(
    run,
    options,
    command,
    args,
  );

  const post = await runGuardrails(dataRoot, env, pre);

  if (post.failure !== undefined) {
    await failGuardrailed(run, pre, post.failure, post.entries, agentError);
  }

  onProgress("wiki-sync: lint — guardrails passed");

  if (agentError !== undefined) {
    throw agentError;
  }

  // The snapshot advances only after a completed audit: a failed or
  // timed-out run leaves it untouched, so the next run retries the
  // same pages (a timeout's guardrail-passed edits re-enter the
  // window through their changed hashes).
  await writeLintWindowSnapshot(
    run.wikiDir,
    lintWindowPath(dataRoot),
    dataRoot,
  );

  const reportWritten = await pathExists(toAbsolute(dataRoot, reportPath));

  return {
    mode: resolved.mode,
    skipped: undefined,
    reportPath,
    reportWritten,
    summary: stdout,
    entries: post.entries,
    windowPages,
  };
}
