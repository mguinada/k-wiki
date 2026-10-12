/**
 * The one-shot query verb (issue #452's extraction from
 * agent-verbs.ts, keeping the read-verb runner inside its structure
 * budget): the verb's usage errors and the runQueryCli dispatch.
 * The verb stays answer-only; `--web` reuses the shared two-pass
 * enrichment machinery — the run never writes the wiki.
 */

import { join } from "node:path";
import { runQueryCli } from "../query/query-shell.ts";
import { queryGapHint } from "../query/web-enrich.ts";
import type { WikiInstance } from "../sync/instance.ts";
import type { RunContext } from "./run-context.ts";

/** Usage error for k-wiki query's question, undefined when valid. */
export function queryUsageError(rest: readonly string[]): string | undefined {
  const question = rest[0] ?? "";

  if (question.trim() === "") {
    return 'a question is required: k-wiki query "<question>"';
  }

  if (rest.length > 1) {
    return `expected exactly one <question> argument, got ${rest.length}`;
  }

  return undefined;
}

/** Usage error when --web appears on a verb other than query:
 *  enrichment belongs to the one-shot ask. */
export function webVerbError(verb: string, web: boolean): string | undefined {
  if (web && verb !== "query") {
    return "--web belongs to k-wiki query";
  }

  return undefined;
}

/** Run the one LLM verb: query — the shared query shell. The
 *  settings path follows the resolved instance (the caller applies
 *  the binding's explicit settings key); `--web` opts into the
 *  two-pass enrichment. */
export async function runQueryVerb(
  run: RunContext,
  instance: WikiInstance,
  settingsPath: string,
  checkout: string,
  timeoutMs: number | undefined,
  question: string,
  web: boolean,
): Promise<void> {
  const wiki = instance.name === undefined ? "" : `--wiki ${instance.name} `;
  const hint = `To file this answer (human step): k-wiki wiki-query ${wiki}--file-last, run inside the checkout`;

  await runQueryCli({
    prefix: "k-wiki",
    settingsPath,
    rawDir: run.rawDir,
    promptsDir: join(checkout, "prompts"),
    outputsDir: instance.outputsDir,
    question,
    timeoutMs,
    hint,
    gapHint: queryGapHint(instance.name),
    web,
  });
}
