import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { startHeartbeat } from "../cli/progress.ts";
import type { RunContext } from "../cli/run-context.ts";
import { readTextIfExists } from "../cli/shared.ts";
import { writeDashboard } from "../dashboard/generate.ts";
import {
  emptyManifest,
  type Manifest,
  parseManifest,
} from "../sync/manifest.ts";
import { type AgentRunner, readPrompt, spawnAgent } from "./agent-run.ts";
import {
  type AgentSettings,
  agentArgs,
  formatAgentInvocation,
  loadAgentSettings,
} from "./agent-settings.ts";
import { formatDigest, writeFailureDigest } from "./digest.ts";
import {
  capturePreRunState,
  type PostRunState,
  type PreRunState,
  revertToPreRun,
  runGuardrails,
} from "./guardrails.ts";
import {
  diffManifests,
  explicitSourceDiff,
  type ManifestDiff,
  pairBodyIdenticalRenames,
  readUnverifiedFrontier,
  sourceCount,
  type WikiPages,
  wikiPages,
} from "./manifest-diff.ts";
import {
  type ComposeRunPromptInput,
  composeRunPrompt,
  DEFAULT_OPERATOR_NOTE,
  removedContentReader,
} from "./prompts.ts";
import {
  adoptLegacySnapshot,
  ensureDashboardIgnored,
  ensureSnapshotIgnored,
  readSnapshot,
  SNAPSHOT_FILENAME,
  warnTrackedIgnored,
  writeSnapshotIfNeeded,
} from "./snapshot.ts";

/**
 * wiki-ingest: the headless wiki agent run (guide §18, issue #11). It
 * diffs `raw/manifest.json` against the snapshot from the previous
 * successful run, picks `prompts/ingest.md` (first run),
 * `prompts/incremental.md` (changed sources appended), or
 * `prompts/expunge.md` (a synced note was deleted — issue #65: the
 * removed note's last content from git history and the deterministic
 * direct set are appended, and a mixed run also gets incremental.md
 * appended so its non-removed sources are ingested), invokes the agent
 * CLI non-interactively in
 * the data repo root, runs the post-run guardrails (issue #12:
 * immutability, frontmatter, wikilinks — auto-reverting to the
 * pre-run commit on failure, expunge runs included), and writes a
 * digest the human can review in under a minute. Scheduling the
 * cycle unattended is `setup-schedule` (issue #14).
 */

export interface IngestOptions {
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** Agent settings when the caller already loaded them — the
   *  wiki-sync cycle loads once and threads them (R-1, one
   *  settings.yml parse per run); loaded from `settingsPath`
   *  otherwise. */
  readonly settings?: AgentSettings | undefined;
  /** The run context: raw dir, data root, wiki dir, environment,
   *  clock, progress sink — built once at the CLI boundary (issue
   *  #257). */
  readonly run: RunContext;
  /** Digest destination (the repo's outputs/); a legacy snapshot
   *  found here is adopted into the data repo (issue #112). */
  readonly outputsDir: string;
  /** Directory holding ingest.md and incremental.md. */
  readonly promptsDir: string;
  /** Agent runner; defaults to the real non-interactive invocation. */
  readonly runAgent?: AgentRunner | undefined;
  /** Kill the agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
  /** Heartbeat interval while the agent runs; default 60 s. */
  readonly heartbeatMs?: number | undefined;
  /** Explicit `--sources` paths (issue #133): scoped re-ingest. The
   *  deduped list replaces the manifest diff as the run's
   *  changed-source set (every path a sorted `~` line) and bypasses
   *  the no-change skip; mode resolves to incremental (the snapshot
   *  precondition below guarantees a previous manifest, and the
   *  synthetic diff carries no removals). An empty list behaves as
   *  an absent flag. On success the run records its processing in
   *  a merged snapshot (the previous snapshot plus the explicit
   *  paths' current entries, issue #150): pending manifest changes
   *  outside the list survive for the next ordinary run. */
  readonly sources?: readonly string[] | undefined;
  /** Operator intent for a scoped run (issue #149): appended verbatim
   *  below the changed-source list under an `Operator note:` heading —
   *  scoped runs only; never on ordinary incremental, expunge, or
   *  full runs. Undefined with `--sources` present means the default
   *  line (DEFAULT_OPERATOR_NOTE). */
  readonly note?: string | undefined;
}

export type IngestResult =
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "ran";
      readonly mode: "full" | "incremental" | "expunge";
      readonly digestPath: string;
      readonly digest: string;
      readonly pages: WikiPages;
      /** The manifest diff the run ingested; feeds the cycle's commit
       *  message (issue #13). */
      readonly diff: ManifestDiff;
    };

/** Prompt file per mode: first run, later changes, deletions. */
function promptFileFor(mode: "full" | "incremental" | "expunge"): string {
  if (mode === "full") {
    return "ingest.md";
  }

  return mode === "expunge" ? "expunge.md" : "incremental.md";
}

/** The run's manifest; a missing manifest means sync-vault has not
 *  run. The data root comes from the run context, not the manifest
 *  read. */
async function readRunManifest(rawDir: string): Promise<Manifest> {
  const manifestPath = join(rawDir, "manifest.json");
  const manifestText = await readTextIfExists(manifestPath);

  if (manifestText === undefined) {
    throw new Error(`no manifest at ${manifestPath}: run sync-vault first`);
  }

  return parseManifest(manifestText, manifestPath);
}

/** Whether the run carries explicit `--sources` paths: a scoped run. */
function hasExplicitSources(options: IngestOptions): boolean {
  return (options.sources?.length ?? 0) > 0;
}

/** The operator note a scoped run carries (issue #149): the explicit
 *  `--note` text, or the default line when `--sources` runs without
 *  one — never on an unscoped run. */
function scopedNote(options: IngestOptions): string | undefined {
  return hasExplicitSources(options)
    ? (options.note ?? DEFAULT_OPERATOR_NOTE)
    : undefined;
}

/** The manifest diff this run ingests: the explicit `--sources` set
 *  when given (which requires a valid snapshot), else snapshot vs
 *  current — with body-identical remove+add pairs paired as renames. */
async function computeRunDiff(
  run: RunContext,
  current: Manifest,
  previous: Manifest | undefined,
  options: IngestOptions,
  snapshotPath: string,
): Promise<{ diff: ManifestDiff; explicitDiff: ManifestDiff | undefined }> {
  const explicitSources = hasExplicitSources(options)
    ? [...new Set(options.sources)]
    : undefined;
  const explicitDiff =
    explicitSources === undefined
      ? undefined
      : explicitSourceDiff(current, explicitSources);

  if (explicitDiff !== undefined && previous === undefined) {
    throw new Error(
      `--sources needs a valid snapshot for this data root (${snapshotPath}): run a full ingest first`,
    );
  }

  const diff = await pairBodyIdenticalRenames(
    explicitDiff ?? diffManifests(previous ?? emptyManifest(), current),
    removedContentReader(run.dataRoot, run.env, previous),
    (vault, path) =>
      readFile(join(run.rawDir, "notes", vault, path), "utf8").catch(
        () => undefined,
      ),
  );

  return { diff, explicitDiff };
}

/** The run's mode and removed-source count: first run full, removals
 *  expunge, everything else incremental. */
function resolveRunMode(
  previous: Manifest | undefined,
  diff: ManifestDiff,
): { mode: "full" | "incremental" | "expunge"; removedCount: number } {
  const removedCount = sourceCount(diff, "removed");
  const mode =
    previous === undefined
      ? "full"
      : removedCount > 0
        ? "expunge"
        : "incremental";

  return { mode, removedCount };
}

/** The run's immutable inputs, loaded once before any step. */
interface RunInputs {
  readonly options: IngestOptions;
  readonly run: RunContext;
  readonly settings: AgentSettings;
  readonly current: Manifest;
  readonly snapshotPath: string;
}

/** Load the run's inputs: settings (caller-threaded or read), the
 *  current manifest, and the snapshot path. */
async function prepareRun(options: IngestOptions): Promise<RunInputs> {
  const { run } = options;
  const settings =
    options.settings ??
    (await loadAgentSettings(options.settingsPath, {
      onProgress: run.onProgress,
    }));

  run.onProgress(`wiki-ingest: raw dir ${run.rawDir}`);

  return {
    options,
    run,
    settings,
    current: await readRunManifest(run.rawDir),
    snapshotPath: join(run.dataRoot, "outputs", SNAPSHOT_FILENAME),
  };
}

/** The housekeeping step: keep the snapshot and dashboard out of the
 *  data repo's history, adopt a legacy snapshot, warn about
 *  tracked-but-ignored files, and read the last-ingested snapshot. */
async function housekeepingStep(
  inputs: RunInputs,
): Promise<Manifest | undefined> {
  const { dataRoot, env, onProgress } = inputs.run;

  await ensureSnapshotIgnored(dataRoot, onProgress);
  await ensureDashboardIgnored(dataRoot, onProgress);
  await adoptLegacySnapshot(
    join(inputs.options.outputsDir, SNAPSHOT_FILENAME),
    inputs.snapshotPath,
    onProgress,
  );
  await warnTrackedIgnored(dataRoot, env, onProgress);

  return await readSnapshot(
    inputs.snapshotPath,
    dataRoot,
    onProgress,
    hasExplicitSources(inputs.options),
  );
}

/** What the diff step produced: the change set this run ingests. */
interface RunChange {
  readonly diff: ManifestDiff;
  readonly explicitDiff: ManifestDiff | undefined;
  readonly previous: Manifest | undefined;
}

/** The diff step: snapshot vs current (or the explicit `--sources`
 *  set), with body-identical pairs paired as renames. Undefined when
 *  nothing changed — the run then skips. */
async function diffStep(
  inputs: RunInputs,
  previous: Manifest | undefined,
): Promise<RunChange | undefined> {
  const { diff, explicitDiff } = await computeRunDiff(
    inputs.run,
    inputs.current,
    previous,
    inputs.options,
    inputs.snapshotPath,
  );

  if (diff.empty) {
    return undefined;
  }

  return { diff, explicitDiff, previous };
}

/** The skip result of an empty diff: nothing runs. */
function noChangesSkip(run: RunContext): IngestResult {
  const reason = "no changed sources since the last ingest; nothing to do";

  run.onProgress(reason);

  return { status: "skipped", reason };
}

/** The run's resolved mode and its prompt file. */
interface RunMode {
  readonly mode: "full" | "incremental" | "expunge";
  readonly removedCount: number;
  readonly promptFile: string;
}

/** The mode step: first run full, removals expunge, everything else
 *  incremental — and the prompt file it names. */
function modeStep(change: RunChange): RunMode {
  const { mode, removedCount } = resolveRunMode(change.previous, change.diff);

  return { mode, removedCount, promptFile: promptFileFor(mode) };
}

/** The composed agent message, with the expunge direct set when one
 *  is due. */
interface RunPrompt {
  readonly composed: string;
  readonly directSet: readonly string[] | undefined;
}

/** The prompt step: read the mode's prompt file and compose the
 *  agent message. */
async function promptStep(
  inputs: RunInputs,
  change: RunChange,
  mode: RunMode,
): Promise<RunPrompt> {
  const promptText = await readPrompt(
    join(inputs.options.promptsDir, mode.promptFile),
  );

  return await composeRunPrompt(promptInput(inputs, change, mode, promptText));
}

/** The prompt input for the run's mode (the C-14 union's builder):
 *  full carries the prompt text alone, incremental adds the diff and
 *  the scoped run's operator note, expunge carries the removed-source
 *  count and the run's coordinates. */
function promptInput(
  inputs: RunInputs,
  change: RunChange,
  mode: RunMode,
  promptText: string,
): ComposeRunPromptInput {
  if (mode.mode === "full") {
    return { mode: "full", promptText };
  }

  if (mode.mode === "incremental") {
    return {
      mode: "incremental",
      promptText,
      diff: change.diff,
      note: scopedNote(inputs.options),
    };
  }

  return {
    mode: "expunge",
    removedCount: mode.removedCount,
    promptText,
    promptsDir: inputs.options.promptsDir,
    dataRoot: inputs.run.dataRoot,
    diff: change.diff,
    env: inputs.run.env,
    onProgress: inputs.run.onProgress,
  };
}

/** The agent run's outcome, held for the guardrail step: its stdout,
 *  or the failure that must wait for the guardrail check before it
 *  escapes. */
interface AgentRun {
  readonly pre: PreRunState;
  readonly stdout: string;
  readonly agentError: unknown;
}

/** The spawn step: capture the pre-run state, invoke the agent under
 *  its heartbeat, and hold the outcome for the guardrail step. */
async function spawnStep(
  inputs: RunInputs,
  mode: RunMode,
  composed: string,
): Promise<AgentRun> {
  const { dataRoot, env, now, onProgress } = inputs.run;
  const args = agentArgs(inputs.settings, composed);
  const runAgent = inputs.options.runAgent ?? spawnAgent;
  const pre = await capturePreRunState(dataRoot, env);

  onProgress(
    `wiki-ingest: mode ${mode.mode}, invoking agent: ${formatAgentInvocation(inputs.settings)}`,
  );

  const heartbeat = startHeartbeat({
    mode: mode.mode,
    now,
    intervalMs: inputs.options.heartbeatMs,
    onProgress,
  });

  let stdout = "";
  let agentError: unknown;

  try {
    ({ stdout } = await runAgent(inputs.settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs: inputs.options.timeoutMs,
    }));
  } catch (error) {
    agentError = error;
  } finally {
    clearInterval(heartbeat);
  }

  if (agentError === undefined) {
    onProgress("wiki-ingest: agent finished");
  }

  return { pre, stdout, agentError };
}

/** The digest destination of this run, under the outputs dir. */
async function runDigestPath(
  outputsDir: string,
  startedAt: Date,
): Promise<string> {
  const runsDir = join(outputsDir, "runs");

  await mkdir(outputsDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });

  return join(runsDir, `${startedAt.toISOString().replaceAll(":", "-")}.md`);
}

/** What the guardrail step leaves for the success path. */
interface CheckedRun {
  readonly post: PostRunState;
  readonly startedAt: Date;
  readonly digestPath: string;
}

/** The guardrail-or-fail step: run the post-run guardrails. A tripped
 *  check reverts the data repo to its pre-run state, writes the
 *  failure digest, and rejects; a passed check with a failed agent
 *  rejects with the agent's error (the changes stay, uncommitted). */
async function guardrailStep(
  inputs: RunInputs,
  change: RunChange,
  mode: RunMode,
  agent: AgentRun,
): Promise<CheckedRun> {
  const { dataRoot, env, now, onProgress } = inputs.run;
  const post = await runGuardrails(dataRoot, env, agent.pre);
  const startedAt = now();
  const digestPath = await runDigestPath(inputs.options.outputsDir, startedAt);
  const failure = post.failure;

  if (failure === undefined) {
    onProgress("wiki-ingest: guardrails passed");

    if (agent.agentError !== undefined) {
      onProgress("wiki-ingest: agent failed — guardrails passed, changes kept");

      throw agent.agentError;
    }

    return { post, startedAt, digestPath };
  }

  onProgress(
    `wiki-ingest: guardrail check ${failure.check} (${failure.name}) failed — reverting to ${agent.pre.commit.slice(0, 8)}`,
  );

  await revertToPreRun(dataRoot, env, agent.pre, post.entries);
  await writeFailureDigest(digestPath, {
    startedAt,
    mode: mode.mode,
    promptFile: `prompts/${mode.promptFile}`,
    settings: inputs.settings,
    diff: change.diff,
    agentOutput: agent.stdout,
    failure,
    explicitDiff: change.explicitDiff,
  });

  throw new Error(
    `guardrail check ${failure.check} (${failure.name}) failed; run reverted to ${agent.pre.commit.slice(0, 8)} — ${failure.problems.join("; ")}`,
    { cause: agent.agentError },
  );
}

/** The success step: bucket the run's wiki pages, write the digest
 *  and the snapshot, and report the run. */
async function successStep(
  inputs: RunInputs,
  change: RunChange,
  mode: RunMode,
  prompt: RunPrompt,
  agent: AgentRun,
  checked: CheckedRun,
): Promise<IngestResult> {
  const { dataRoot } = inputs.run;
  const pages = await wikiPages(dataRoot, checked.post.entries, agent.pre);
  const unverifiedFrontier = await readUnverifiedFrontier(dataRoot, pages);
  const digest = formatDigest({
    startedAt: checked.startedAt,
    mode: mode.mode,
    promptFile: `prompts/${mode.promptFile}`,
    settings: inputs.settings,
    diff: change.diff,
    pages,
    directSet: prompt.directSet,
    agentOutput: agent.stdout,
    unverifiedFrontier,
    ...(change.explicitDiff !== undefined && { explicitSources: true }),
  });

  await writeFile(checked.digestPath, digest, "utf8");
  await writeSnapshotIfNeeded(
    inputs.run,
    change.explicitDiff,
    change.previous,
    inputs.snapshotPath,
    inputs.current,
  );

  return {
    status: "ran",
    mode: mode.mode,
    digestPath: checked.digestPath,
    digest,
    pages,
    diff: change.diff,
  };
}

/** The dashboard step (issue #73, an explicit run step since issue
 *  #258, B-9): refresh the static dashboard after the digest and
 *  snapshot — the dashboard reflects the last good state, so a
 *  failure path (revert, agent error) never regenerates it. A
 *  refresh failure must not fail the run: the dashboard is derived. */
async function dashboardStep(run: RunContext): Promise<void> {
  const { dataRoot, env, now, onProgress } = run;

  try {
    const dashboardPath = await writeDashboard(dataRoot, {
      env,
      now,
      warn: (message) => onProgress(`wiki-ingest: WARNING — ${message}`),
    });

    onProgress(`wiki-ingest: dashboard refreshed at ${dashboardPath}`);
  } catch (error) {
    onProgress(
      `wiki-ingest: WARNING — dashboard refresh failed (${errorMessage(error)}); the previous dashboard stays`,
    );
  }
}

/**
 * One headless ingest run, as its named steps in run order: prepare,
 * housekeeping, diff, mode, prompt, spawn, guardrail-or-fail,
 * success, dashboard. The snapshot is written only after a
 * successful agent run, so a failure retries the same sources next
 * time instead of silently skipping them. An ordinary run records
 * the full current manifest; a scoped run writes a merged snapshot
 * (issue #150) that keeps pending manifest changes outside
 * `--sources` pending. A manifest diff with removed entries routes
 * to the expunge flow (issue #65); removed entries that pair with an
 * addition by equal full-file hash or identical body text are
 * renames and never route there (issue #143).
 */
export async function runWikiIngest(
  options: IngestOptions,
): Promise<IngestResult> {
  const inputs = await prepareRun(options);
  const previous = await housekeepingStep(inputs);
  const change = await diffStep(inputs, previous);

  if (change === undefined) {
    return noChangesSkip(inputs.run);
  }

  const mode = modeStep(change);
  const prompt = await promptStep(inputs, change, mode);
  const agent = await spawnStep(inputs, mode, prompt.composed);
  const checked = await guardrailStep(inputs, change, mode, agent);
  const result = await successStep(
    inputs,
    change,
    mode,
    prompt,
    agent,
    checked,
  );

  await dashboardStep(inputs.run);

  return result;
}

/* v8 ignore next: covered only under direct `node src/ingest/wiki-ingest.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-ingest");
