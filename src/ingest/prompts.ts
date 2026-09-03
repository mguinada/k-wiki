import { join } from "node:path";
import { pluralized } from "../cli/shared.ts";
import { removedNoteContent } from "../data/git.ts";
import type { Manifest } from "../sync/manifest.ts";
import { readPrompt } from "./agent-run.ts";
import { directSetForRemovals } from "./digest.ts";
import {
  type ManifestDiff,
  sourceCount,
  vaultEntryLines,
} from "./manifest-diff.ts";

/** The static operator-intent line every scoped `--sources` run
 *  carries when the operator gave no `--note` (issue #149): the
 *  intent channel always exists, so unchanged content never reads
 *  as a no-op and filing decisions are re-adjudicated. */
export const DEFAULT_OPERATOR_NOTE =
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

/** The removed-content reader for rename pairing: each removed
 *  path's content as the snapshot's hash records it. */
export function removedContentReader(
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
export async function composeRunPrompt(
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
