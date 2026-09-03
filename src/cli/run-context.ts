import { dirname, join } from "node:path";

/**
 * The run context (issue #257): the ambient trio — environment,
 * clock, progress sink — plus the three canonical paths every wiki
 * stage shares (data root, raw dir, wiki dir), as one required
 * object. Each CLI boundary builds it once and threads it through
 * the options interfaces and stage plumbing (wiki-sync stages,
 * runWikiIngest, runWikiQuery, lint/verification), so no stage
 * re-derives the raw dir's parent or re-defaults the trio; leaf helpers
 * keep their explicit `(dataRoot, env)` params.
 */
export interface RunContext {
  /** The data repo root — the raw dir's parent: the agents' cwd and
   *  the commit, guardrail, and publish target. */
  readonly dataRoot: string;
  /** The `raw/` projection directory inside the data repo. */
  readonly rawDir: string;
  /** The `wiki/` directory inside the data repo. */
  readonly wikiDir: string;
  /** Environment for child processes (the default: `process.env`). */
  readonly env: NodeJS.ProcessEnv;
  /** Clock for timestamps, report paths, and digests (the default:
   *  the wall clock). */
  readonly now: () => Date;
  /** Progress sink, uncolored messages (the default: silent). */
  readonly onProgress: (message: string) => void;
}

/** What a CLI boundary supplies: the raw dir it resolved, plus the
 *  ambient trio's optional overrides (tests inject a fixed clock,
 *  a controlled env, a recording sink). */
export interface RunContextInput {
  /** The `raw/` directory; its parent is the data repo. */
  readonly rawDir: string;
  /** Environment for child processes; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

/** Build the run context once at the CLI boundary: derive the data
 *  root and wiki dir from the raw dir, apply the ambient defaults. */
export function runContext(input: RunContextInput): RunContext {
  const dataRoot = dirname(input.rawDir);

  return {
    dataRoot,
    rawDir: input.rawDir,
    wikiDir: join(dataRoot, "wiki"),
    env: input.env ?? process.env,
    now: input.now ?? (() => new Date()),
    onProgress: input.onProgress ?? (() => {}),
  };
}
