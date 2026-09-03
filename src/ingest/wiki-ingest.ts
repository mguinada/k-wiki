import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { startHeartbeat } from "../cli/progress.ts";
import type { RunContext } from "../cli/run-context.ts";
import { pluralized, readTextIfExists } from "../cli/shared.ts";
import { writeDashboard } from "../dashboard/generate.ts";
import { removedNoteContent } from "../data/git.ts";
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
import {
  directSetForRemovals,
  formatDigest,
  type IngestRun,
  writeFailureDigest,
} from "./digest.ts";
import {
  capturePreRunState,
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
  vaultEntryLines,
  type WikiPages,
  wikiPages,
} from "./manifest-diff.ts";
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

/** The static operator-intent line every scoped `--sources` run
 *  carries when the operator gave no `--note` (issue #149): the
 *  intent channel always exists, so unchanged content never reads
 *  as a no-op and filing decisions are re-adjudicated. */
const DEFAULT_OPERATOR_NOTE =
  "Sources re-opened by the operator: unchanged content does not imply a no-op; re-adjudicate filing decisions; if declining, state per concept why its treatment fails the page bar.";

/** Render the changed-source list appended below incremental and expunge prompts. */
function changedSourceLines(diff: ManifestDiff): string[] {
  return diff.vaults.flatMap(vaultEntryLines);
}

/**
 * Compose the agent message: the prompt file text, plus the explicit
 * changed-source list for an incremental run (the prompt restricts the
 * agent to those files). A full ingest gets the prompt unmodified. A
 * scoped run's operator note (issue #149) rides below the list under
 * an `Operator note:` heading — verbatim, beside the prompt exactly as
 * the list does, so prompts/*.md stay untouched (#133).
 */
export function composePrompt(
  promptText: string,
  diff: ManifestDiff | undefined,
  note?: string,
): string {
  if (diff === undefined) {
    return promptText;
  }

  const lines = [
    promptText,
    "",
    "Changed sources since the previous ingestion:",
    "",
    ...changedSourceLines(diff),
  ];

  if (note !== undefined) {
    lines.push("", "Operator note:", "", note);
  }

  return lines.join("\n");
}

/** A removed source note: its identity plus its last synced content. */
export interface RemovedNote {
  readonly vault: string;
  /** Vault-relative note path, as the manifest records it. */
  readonly path: string;
  /** Data-repo-relative raw path, `raw/notes/<vault>/<path>`. */
  readonly rawPath: string;
  /** Last synced content from git history; undefined when unrecorded. */
  readonly content: string | undefined;
}

/** A markdown fence longer than any backtick run in the content it wraps,
 *  so a note body can never close its own wrapper. */
function wrappingFence(content: string): string {
  let longest = 0;

  for (const run of content.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }

  return "`".repeat(Math.max(4, longest + 1));
}

/**
 * Compose the expunge agent message: the expunge prompt, the changed
 * sources (an expunge run may also carry adds and edits), each removed
 * note's last synced content, and the deterministic direct set. The
 * direct set is a lower bound the agent extends by search (guide §14a).
 * When the run also carries added, edited, or renamed sources, the
 * incremental prompt is appended so those sources are ingested in the
 * same run instead of being marked processed without ever reaching
 * the agent.
 */
export function composeExpungePrompt(
  promptText: string,
  diff: ManifestDiff,
  removedNotes: readonly RemovedNote[],
  directSet: readonly string[],
  incrementalText?: string,
): string {
  const lines = [promptText];

  if (incrementalText !== undefined) {
    lines.push(
      "",
      "This run also carries added, edited, or renamed sources (`+`, `~`, `→` in the list below). In the same run, process them exactly as an incremental ingestion would:",
      "",
      incrementalText,
    );
  }

  lines.push(
    "",
    "Changed sources since the previous ingestion:",
    "",
    ...changedSourceLines(diff),
    "",
    "Removed notes with their last synced content:",
    "",
  );

  for (const note of removedNotes) {
    lines.push(`### ${note.vault}/${note.path} (${note.rawPath})`, "");

    if (note.content === undefined) {
      lines.push(
        "(last synced content unavailable: no committed git history — purge by path, title, and full-text search)",
      );
    } else {
      const fence = wrappingFence(note.content);

      lines.push(`${fence}markdown`, note.content, fence);
    }

    lines.push("");
  }

  lines.push(
    "Direct set (deterministic seed — a lower bound, not a boundary):",
    "",
  );

  for (const page of directSet) {
    lines.push(`- wiki/${page}`);
  }

  return lines.join("\n");
}

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

/** The removed notes of a diff, each with its last synced content
 *  recovered from the data repo's git history. */
async function collectRemovedNotes(
  dataRoot: string,
  diff: ManifestDiff,
  env: NodeJS.ProcessEnv,
): Promise<RemovedNote[]> {
  const removedNotes: RemovedNote[] = [];

  for (const vault of diff.vaults) {
    for (const path of vault.removed) {
      const rawPath = `raw/notes/${vault.vault}/${path}`;
      const content = await removedNoteContent(dataRoot, rawPath, env);

      removedNotes.push({ vault: vault.vault, path, rawPath, content });
    }
  }

  return removedNotes;
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

/** The removed-content reader for rename pairing: each removed
 *  path's content as the snapshot's hash records it. */
function removedContentReader(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  previous: Manifest | undefined,
): (vault: string, path: string) => Promise<string | undefined> {
  return (vault, path) =>
    removedNoteContent(
      dataRoot,
      `raw/notes/${vault}/${path}`,
      env,
      previous?.vaults[vault]?.[path]?.hash,
    );
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

/** What composeRunPrompt needs: the resolved run mode with its
 *  prompt text, and the run's coordinates. */
interface PromptComposition {
  readonly mode: "full" | "incremental" | "expunge";
  readonly removedCount: number;
  readonly promptText: string;
  readonly promptsDir: string;
  readonly dataRoot: string;
  readonly diff: ManifestDiff;
  readonly env: NodeJS.ProcessEnv;
  readonly onProgress: (message: string) => void;
  readonly note: string | undefined;
}

/** Compose the agent message and, for an expunge run, its
 *  deterministic direct set. */
async function composeRunPrompt(
  run: PromptComposition,
): Promise<{ composed: string; directSet: readonly string[] | undefined }> {
  const { mode, removedCount, promptText, promptsDir, dataRoot, diff, env } =
    run;

  if (mode !== "expunge") {
    return {
      composed: composePrompt(
        promptText,
        mode === "incremental" ? diff : undefined,
        run.note,
      ),
      directSet: undefined,
    };
  }

  const removedNotes = await collectRemovedNotes(dataRoot, diff, env);
  const directSet = await directSetForRemovals(
    join(dataRoot, "wiki"),
    removedNotes.map((note) => note.rawPath),
  );

  const carriesNonRemovals =
    sourceCount(diff, "added") +
      sourceCount(diff, "changed") +
      sourceCount(diff, "renamed") >
    0;
  const incrementalText = carriesNonRemovals
    ? await readPrompt(join(promptsDir, "incremental.md"))
    : undefined;
  const composed = composeExpungePrompt(
    promptText,
    diff,
    removedNotes,
    directSet,
    incrementalText,
  );

  run.onProgress(
    `wiki-ingest: expunge — ${pluralized(removedCount, "removed source")}; direct set: ${directSet.map((page) => `wiki/${page}`).join(", ")}`,
  );

  return { composed, directSet };
}

/** Post-run hook (issue #73): refresh the static dashboard after the
 *  digest and snapshot — the dashboard reflects the last good state,
 *  so a failure path (revert, agent error) never regenerates it. A
 *  refresh failure must not fail the run: the dashboard is derived. */
async function refreshDashboard(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  onProgress: (message: string) => void,
): Promise<void> {
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
 * One headless ingest run. The snapshot is written only after a
 * successful agent run, so a failure retries the same sources next
 * time instead of silently skipping them. An ordinary run records
 * the full current manifest; a scoped run writes a merged snapshot
 * (issue #150) that keeps pending manifest changes outside
 * `--sources` pending. A manifest diff with removed
 * entries routes to the expunge flow (issue #65); removed entries that
 * pair with an addition by equal full-file hash or identical body
 * text are renames and never route there (issue #143).
 */
export async function runWikiIngest(
  options: IngestOptions,
): Promise<IngestResult> {
  const { dataRoot, rawDir, env, now, onProgress } = options.run;
  const settings =
    options.settings ??
    (await loadAgentSettings(options.settingsPath, { onProgress }));

  onProgress(`wiki-ingest: raw dir ${rawDir}`);

  const current = await readRunManifest(rawDir);
  const snapshotPath = join(dataRoot, "outputs", SNAPSHOT_FILENAME);
  const legacySnapshotPath = join(options.outputsDir, SNAPSHOT_FILENAME);

  await ensureSnapshotIgnored(dataRoot, onProgress);
  await ensureDashboardIgnored(dataRoot, onProgress);
  await adoptLegacySnapshot(legacySnapshotPath, snapshotPath, onProgress);
  await warnTrackedIgnored(dataRoot, env, onProgress);

  const previous = await readSnapshot(
    snapshotPath,
    dataRoot,
    onProgress,
    hasExplicitSources(options),
  );
  const { diff, explicitDiff } = await computeRunDiff(
    options.run,
    current,
    previous,
    options,
    snapshotPath,
  );

  if (diff.empty) {
    const reason = "no changed sources since the last ingest; nothing to do";

    onProgress(reason);

    return { status: "skipped", reason };
  }

  const { mode, removedCount } = resolveRunMode(previous, diff);
  const promptFile = promptFileFor(mode);
  const promptText = await readPrompt(join(options.promptsDir, promptFile));
  const { composed, directSet } = await composeRunPrompt({
    mode,
    removedCount,
    promptText,
    promptsDir: options.promptsDir,
    dataRoot,
    diff,
    env,
    onProgress,
    note: scopedNote(options),
  });

  const args = agentArgs(settings, composed);
  const runAgent = options.runAgent ?? spawnAgent;
  const pre = await capturePreRunState(dataRoot, env);

  onProgress(
    `wiki-ingest: mode ${mode}, invoking agent: ${formatAgentInvocation(settings)}`,
  );

  const heartbeat = startHeartbeat({
    mode,
    now,
    intervalMs: options.heartbeatMs,
    onProgress,
  });

  let stdout = "";
  let agentError: unknown;

  try {
    ({ stdout } = await runAgent(settings.command, args, {
      cwd: dataRoot,
      env,
      timeoutMs: options.timeoutMs,
    }));
  } catch (error) {
    agentError = error;
  } finally {
    clearInterval(heartbeat);
  }

  if (agentError === undefined) {
    onProgress("wiki-ingest: agent finished");
  }

  const post = await runGuardrails(dataRoot, env, pre);
  const startedAt = now();

  await mkdir(options.outputsDir, { recursive: true });
  await mkdir(join(options.outputsDir, "runs"), { recursive: true });

  const digestPath = join(
    options.outputsDir,
    "runs",
    `${startedAt.toISOString().replaceAll(":", "-")}.md`,
  );

  if (post.failure !== undefined) {
    const failure = post.failure;

    onProgress(
      `wiki-ingest: guardrail check ${failure.check} (${failure.name}) failed — reverting to ${pre.commit.slice(0, 8)}`,
    );

    await revertToPreRun(dataRoot, env, pre, post.entries);
    await writeFailureDigest(digestPath, {
      startedAt,
      mode,
      promptFile: `prompts/${promptFile}`,
      settings,
      diff,
      agentOutput: stdout,
      failure,
      explicitDiff,
    });

    throw new Error(
      `guardrail check ${failure.check} (${failure.name}) failed; run reverted to ${pre.commit.slice(0, 8)} — ${failure.problems.join("; ")}`,
      { cause: agentError },
    );
  }

  onProgress("wiki-ingest: guardrails passed");

  if (agentError !== undefined) {
    onProgress("wiki-ingest: agent failed — guardrails passed, changes kept");

    throw agentError;
  }

  const pages = await wikiPages(dataRoot, post.entries, pre);
  const unverifiedFrontier = await readUnverifiedFrontier(dataRoot, pages);

  const run: IngestRun = {
    startedAt,
    mode,
    promptFile: `prompts/${promptFile}`,
    settings,
    diff,
    pages,
    directSet,
    agentOutput: stdout,
    unverifiedFrontier,
    ...(explicitDiff !== undefined && { explicitSources: true }),
  };
  const digest = formatDigest(run);

  await writeFile(digestPath, digest, "utf8");
  await writeSnapshotIfNeeded(
    options.run,
    explicitDiff,
    previous,
    snapshotPath,
    current,
  );
  await refreshDashboard(dataRoot, env, now, onProgress);

  return { status: "ran", mode, digestPath, digest, pages, diff };
}

/* v8 ignore next: covered only under direct `node src/ingest/wiki-ingest.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-ingest");
