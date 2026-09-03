import { errorMessage, terminalColors } from "../cli/colors.ts";
import { stderrSink } from "../cli/progress.ts";
import { QUERY_HEARTBEAT_PREFIX, runWikiQuery } from "./wiki-query.ts";

/**
 * The shared query CLI shell (finding D-8): one runner owns what
 * k-wiki's runQueryCommand and wiki-query's answerStage used to
 * duplicate line-for-line — the progress-sink construction, the
 * runWikiQuery option mapping, the answer print with its dim filing
 * hint, and the red prefixed failure path. Guardrail-critical
 * surface: a fix here reaches both CLIs together. Only the prefix
 * and the hint text differ between the two.
 */
export interface QueryCliOptions {
  /** The calling CLI's name, prefixed to failure lines. */
  readonly prefix: string;
  /** Path to the agent settings file (settings.yml). */
  readonly settingsPath: string;
  /** The raw dir of the data repo; its parent is the data repo root. */
  readonly rawDir: string;
  /** Directory holding query.md. */
  readonly promptsDir: string;
  /** Directory the saved answer is written to. */
  readonly outputsDir: string;
  /** The question, passed to the agent inside the composed prompt. */
  readonly question: string;
  /** Kill the agent run after this many milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** The dim stderr hint printed after the answer. */
  readonly hint: string;
}

/** Run one answer-only query: print the answer and the filing hint;
 *  a failure prints red under the prefix and sets the exit code. */
export async function runQueryCli(options: QueryCliOptions): Promise<void> {
  const colors = terminalColors(process.env);
  const { sink, animated } = stderrSink(QUERY_HEARTBEAT_PREFIX);

  try {
    const result = await runWikiQuery({
      settingsPath: options.settingsPath,
      rawDir: options.rawDir,
      promptsDir: options.promptsDir,
      outputsDir: options.outputsDir,
      question: options.question,
      timeoutMs: options.timeoutMs,
      heartbeatMs: animated ? 100 : undefined,
      onProgress: sink.render,
    });

    sink.end();

    console.log(result.answer);
    console.error();
    console.error(colors.dim(options.hint));
  } catch (error) {
    sink.end();
    console.error(colors.red(`${options.prefix}: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}
