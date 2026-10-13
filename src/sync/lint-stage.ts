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

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatDuration } from "../cli/progress.ts";
import type { RunContext } from "../cli/run-context.ts";
import { pluralized, readTextIfExists } from "../cli/shared.ts";
import type { StatusEntry } from "../data/git.ts";
import {
  type AgentRunner,
  isAffordabilityError,
  readPrompt,
  spawnAgent,
} from "../ingest/agent-run.ts";
import { type ManagedEnv, runnerEnv } from "../ingest/agent-runner.ts";
import {
  type AgentSettings,
  type AgentTarget,
  agentCommandOverride,
  agentTargets,
  formatInvocation,
  loadAgentSettings,
  runnerFor,
  settingsForTarget,
  targetLabel,
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
import { cycleBackReferenceLine, planLintAppend } from "./cycle-reports.ts";
import {
  deriveLintWindow,
  lintWindowPath,
  readLintWindowSnapshot,
  writeLintWindowSnapshot,
} from "./lint-window.ts";
import { STANDALONE_MARKER } from "./report-references.ts";
import type { WikiSyncOptions } from "./wiki-sync.ts";

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
  /** The exact section heading this run's report carries — the
   *  writer-stated `Lint run N — <timestamp> (<window>)` title the
   *  cycle digest cites (issue #459); undefined on a skip. */
  readonly sectionTitle: string | undefined;
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
export function lintReportPath(instant: Date, mode: "window" | "full"): string {
  const date = instant.toISOString().slice(0, 10);

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
  /** The citing cycle's context (issue #459): the cycle report path
   *  and the exact cycle section title the digest will carry, so the
   *  run's back-reference can name the section before the digest
   *  exists. Absent for a standalone run (the wiki-lint door, the
   *  weekly sweep) — the section carries the explicit standalone
   *  marker instead. */
  readonly cycle?:
    | { readonly path: string; readonly sectionTitle: string }
    | undefined;
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
  stdin: string | undefined,
  reportPath: string | undefined,
  managed: ManagedEnv,
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
      env: managed.env,
      managedTemp: managed.temp,
      stdin,
      reportPath,
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
 *  substituted, the windowed page list, the deterministic worklists
 *  (window-filtered for a windowed audit), and the append contract —
 *  the exact back-reference or standalone marker line the report's
 *  section body must open with (issue #459). */
async function composeLintPrompt(options: {
  readonly promptsDir: string;
  readonly mode: "window" | "full";
  readonly reportPath: string;
  readonly windowPages: readonly string[] | undefined;
  readonly wikiDir: string;
  readonly referenceLine: string;
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
  const lines = [
    promptText,
    "",
    "Report format (append contract):",
    "",
    "The report file accumulates one bounded section per run, and this",
    "run's section heading is already written at the end of the file.",
    "Write your report below that heading; change nothing above it.",
    `Start the section body with this exact line: ${options.referenceLine}`,
    "Every heading in your report stays at depth 3 (###) or deeper —",
    "the section heading is the level-2 heading and the day title the",
    "level-1 heading.",
    "",
    renderWorklists(scoped),
  ];

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
    sectionTitle: undefined,
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

/** The run's section contract: the planned day-file append (day
 *  title, heading, transition) plus the exact contract line the
 *  report's section body must open with (issue #459). */
interface LintSectionContract {
  readonly plan: ReturnType<typeof planLintAppend>;
  readonly referenceLine: string;
}

/** Plan the run's section from the day file's current state: window
 *  definition inline, the run's own execution instant in the heading,
 *  and the back-reference or standalone marker per the citing-cycle
 *  context. */
async function lintSectionContract(
  options: LintOptions,
  resolved: Awaited<ReturnType<typeof resolveWindow>>,
  reportPath: string,
  instant: Date,
): Promise<LintSectionContract> {
  const windowText =
    resolved.mode === "window"
      ? `window audit, ${pluralized(resolved.window.pages.length, "page")}`
      : "full audit";
  const existing = await readTextIfExists(
    join(options.run.dataRoot, reportPath),
  );

  return {
    plan: planLintAppend(existing, instant, resolved.mode, windowText),
    referenceLine:
      options.cycle === undefined
        ? STANDALONE_MARKER
        : cycleBackReferenceLine(
            options.cycle.path,
            options.cycle.sectionTitle,
          ),
  };
}

/** Write the day title and section heading the agent appends its
 *  report below (after the pre-run capture, so a guardrail revert
 *  removes the preamble with the run's edits). */
async function writeReportPreamble(
  dataRoot: string,
  reportPath: string,
  prefix: string,
): Promise<void> {
  await mkdir(join(dataRoot, dirname(reportPath)), { recursive: true });
  await writeFile(join(dataRoot, reportPath), prefix);
}

/** Restore the report day file to its pre-run state: absent means
 *  deleted, present means rewritten to its captured bytes — no
 *  stage-written section outlives a failed agent. */
async function restoreReportFile(
  dataRoot: string,
  reportPath: string,
  preRun: string | undefined,
): Promise<void> {
  const file = join(dataRoot, reportPath);

  if (preRun === undefined) {
    await rm(file, { force: true });

    return;
  }

  await writeFile(file, preRun);
}

/** A completed run that did not cleanly append its section — the
 *  report missing (the agent deleted it) or still exactly the
 *  preamble (the agent wrote nothing) — leaves the day file exactly
 *  as found: prior committed sections cannot vanish and no empty
 *  section is committed. */
async function restoreUnwrittenReport(
  dataRoot: string,
  reportPath: string,
  preReport: string | undefined,
  reportContent: string | undefined,
  planPrefix: string,
): Promise<void> {
  if (reportContent !== undefined && reportContent !== planPrefix) {
    return;
  }

  await restoreReportFile(dataRoot, reportPath, preReport);
}

/** The stage's result once the audit completed: the planned section
 *  title, and "written" only when the file exists and grew past the
 *  preamble. */
async function lintStageResult(
  resolved: Awaited<ReturnType<typeof resolveWindow>>,
  contract: LintSectionContract,
  reportPath: string,
  reportContent: string | undefined,
  stdout: string,
  entries: readonly StatusEntry[],
  windowPages: readonly string[] | undefined,
): Promise<LintResult> {
  return {
    mode: resolved.mode,
    skipped: undefined,
    reportPath,
    sectionTitle: contract.plan.sectionTitle,
    reportWritten:
      reportContent !== undefined && reportContent !== contract.plan.prefix,
    summary: stdout,
    entries,
    windowPages,
  };
}

/** One headless lint run (guide §17): pick the audit window, compose
 *  the prompt with the deterministic worklists, invoke the agent in
 *  the data repo root, guardrail the result, auto-revert on a tripped
 *  check, and — only on a completed audit — advance the window
 *  snapshot. Same guardrail contract as the ingest stage.
 *
 *  The report day file is append-only (issue #459): after the pre-run
 *  capture, the stage plans this run's bounded `Lint run N` section —
 *  numbering by section position, transitioning a legacy-shape file
 *  on first append — and writes the day title and section heading to
 *  the file before the agent runs, so the writer owns the heading
 *  contract and the agent owns only its section body. A guardrail
 *  revert removes the preamble with the rest of the run's edits; a
 *  failed agent's error restores the file's pre-run bytes first. */
export async function runLintStage(options: LintOptions): Promise<LintResult> {
  const { run } = options;
  const { env, now, onProgress, dataRoot } = run;
  const settings =
    options.settings ??
    (await loadAgentSettings(options.settingsPath, { onProgress }));

  const resolved = await resolveWindow(run, options.full === true);
  const instant = now();
  const reportPath = lintReportPath(instant, resolved.mode);

  if (resolved.mode === "window" && resolved.window.pages.length === 0) {
    return await skipEmptyWindow(run, options, reportPath);
  }

  const contract = await lintSectionContract(
    options,
    resolved,
    reportPath,
    instant,
  );
  const windowPages =
    resolved.mode === "window" ? resolved.window.pages : undefined;

  onProgress(modeAnnouncement(resolved));

  const promptText = await composeLintPrompt({
    promptsDir: options.promptsDir,
    mode: resolved.mode,
    reportPath,
    windowPages,
    wikiDir: run.wikiDir,
    referenceLine: contract.referenceLine,
  });
  const runner = runnerFor(settings);
  const args = runner.args(settings, promptText, { root: dataRoot });
  const pre = options.pre ?? (await capturePreRunState(dataRoot, env));
  const preReport = await readTextIfExists(join(dataRoot, reportPath));

  await writeReportPreamble(dataRoot, reportPath, contract.plan.prefix);

  // A launcher that already resolved the agent binary (issue #399)
  // hands it over through the environment; it wins over the
  // settings' bare command name the launchd PATH cannot resolve.
  const command = agentCommandOverride(env) ?? settings.command;

  onProgress(
    `wiki-sync: lint — invoking agent: ${formatInvocation(
      runnerFor(settings).invocation(settings, { command }),
    )}`,
  );

  const { stdout, error: agentError } = await invokeLintAgent(
    run,
    options,
    command,
    args,
    runner.stdin(promptText),
    runner.reportPath(args),
    runnerEnv(settings, env),
  );

  const post = await runGuardrails(dataRoot, env, pre);

  if (post.failure !== undefined) {
    await failGuardrailed(run, pre, post.failure, post.entries, agentError);
  }

  onProgress("wiki-sync: lint — guardrails passed");

  if (agentError !== undefined) {
    await restoreReportFile(dataRoot, reportPath, preReport);

    throw agentError;
  }

  const reportContent = await readTextIfExists(join(dataRoot, reportPath));

  await restoreUnwrittenReport(
    dataRoot,
    reportPath,
    preReport,
    reportContent,
    contract.plan.prefix,
  );

  // The snapshot advances only after a completed audit: a failed or
  // timed-out run leaves it untouched, so the next run retries the
  // same pages (a timeout's guardrail-passed edits re-enter the
  // window through their changed hashes).
  await writeLintWindowSnapshot(
    run.wikiDir,
    lintWindowPath(dataRoot),
    dataRoot,
  );

  return await lintStageResult(
    resolved,
    contract,
    reportPath,
    reportContent,
    stdout,
    post.entries,
    windowPages,
  );
}

/** The per-failure callback the ingest stage reports through (issue
 *  #408): records a failed attempt's index when its error is
 *  affordability/402-class — attempt-keyed, so a repeated target
 *  label is a distinct attempt; a crash or timeout says nothing
 *  about the target's balance a few minutes later. */
export function affordabilityExclusion(
  excluded: Set<number>,
): (target: AgentTarget, error: unknown, index: number) => void {
  return (_target, error, index) => {
    if (isAffordabilityError(error)) {
      excluded.add(index);
    }
  };
}

/** The settings the cycle's lint stage runs with (issue #408): the
 *  first attempt the memory still allows; emits the reassignment
 *  progress line. Ingest ran, and a succeeded attempt is never
 *  recorded, so an all-excluded set here is a broken-caller
 *  invariant — the throw, not a skip. */
function lintSettingsForCycle(
  settings: AgentSettings,
  excluded: ReadonlySet<number>,
  onProgress: (message: string) => void,
): AgentSettings {
  const targets = agentTargets(settings);
  const eligibleIndex = targets.findIndex((_, index) => !excluded.has(index));
  const eligible = targets[eligibleIndex];

  if (eligible === undefined) {
    throw new Error(
      "lint stage invariant broken: every agent target is excluded while ingest ran",
    );
  }

  if (eligibleIndex !== 0) {
    const unaffordable = targets
      .filter((_, index) => excluded.has(index))
      .map(targetLabel);

    onProgress(
      `wiki-sync: lint — target ${targetLabel(eligible)} (earlier target(s) unaffordable this cycle: ${unaffordable.join(", ")})`,
    );
  }

  return settingsForTarget(settings, eligible);
}

/** Stage 3 of the wiki-sync cycle: lint what the ingest agent
 *  produced, or skip with it when no ingest ran. Runs with the
 *  cycle's affordability memory (issue #408): an attempt that 402'd
 *  on ingest is skipped; the memory dies with the cycle. The citing
 *  cycle's context (report path plus the section title this cycle's
 *  digest will carry, issue #459) rides to the stage so the lint
 *  run's back-reference names the section before the digest exists. */
export async function runCycleLint(
  options: WikiSyncOptions,
  ingest: { readonly status: "ran" | "skipped" },
  stageLabel: string,
  preLint: PreRunState,
  settings: AgentSettings,
  excluded: ReadonlySet<number>,
  cycle: { readonly path: string; readonly sectionTitle: string },
): Promise<LintResult | undefined> {
  const { run } = options;

  if (ingest.status !== "ran") {
    run.onProgress(`${stageLabel} skipped (no ingest ran)`);

    return undefined;
  }

  const lintSettings = lintSettingsForCycle(settings, excluded, run.onProgress);

  run.onProgress(stageLabel);

  return runLintStage({
    settingsPath: options.settingsPath,
    settings: lintSettings,
    run,
    promptsDir: options.promptsDir,
    runAgent: options.runAgent,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    pre: preLint,
    cycle,
  });
}
