/**
 * The wiki-lint CLI: the lint stage's standalone door. The run
 * itself — the prompt, the guardrails, the auto-revert — is
 * runLintStage from wiki-sync.ts, invoked unchanged; this module
 * only binds it to argv and renders its result. It exists for the
 * runs the cycle cannot make: a lint that timed out mid-cycle (its
 * partial, guardrail-passed edits stay; the audit never finished)
 * and a lint the cycle skipped (lint runs only after an ingest).
 * The stage's progress lines say "wiki-sync: lint"; the boundary
 * re-labels them "wiki-lint" so the door's output names the door.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { stderrSink } from "../cli/progress.ts";
import { runContext } from "../cli/run-context.ts";
import { repoRoot } from "../cli/shared.ts";
import {
  agentRunFlags,
  type CliSpec,
  type ParsedCli,
  parseArgs,
} from "../cli/shell.ts";
import { resolveWikiInstance, wikiArgError } from "./instance.ts";
import { type LintResult, runLintStage } from "./wiki-sync.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-lint [-h | --help] [--wiki, -w <name>] [--settings <path>] [--timeout <secs>] [<raw-dir>]

Run the quality-lint agent (the audit prompt prompts/lint.md) over
the data repo's wiki, alone — no sync, no ingest, no commit. The
lint stage of the wiki-sync cycle, as a standalone command: same
prompt, same agent settings, same post-run guardrails and
auto-revert. Use it when the cycle's lint timed out (its partial
edits stay in the working tree; the audit never finished) or when
the cycle skipped lint (lint runs only after an ingest).

Switches and arguments:
  --wiki, -w <name>  Select the wiki instance to lint: resolved
                     through the checkout's registry, exactly as
                     wiki-ingest resolves it. Default: absent — the
                     default instance. An explicit --settings or
                     <raw-dir> always overrides the derived
                     counterpart. -w is the short alias of --wiki.
  --settings <path>  Agent settings file (command, model, provider,
                     reasoning, isolation) — the same file the other
                     agent verbs read. Default: the instance's
                     derived settings file.
  --timeout <secs>   Kill the agent run after this many seconds and
                     fail it. Default: 1800 (30 minutes) — the same
                     budget the cycle gives the stage; raise it for a
                     heavy audit.
  -h, --help         Print this help and exit; no side effects.
  <raw-dir>          raw/ directory; its parent is the data repo the
                     agent runs in. Default: <dataRoot>/raw from the
                     resolved instance's sync config.

What it writes:
  - wiki pages, by the agent, in the data repo (never raw/);
  - the lint report at outputs/lint-<YYYY-MM-DD>.md in the DATA
    repo's outputs/ — the same path the cycle's lint stage uses.

After the agent run the same three guardrails as the cycle check the
data repo: (1) immutability — only wiki/ (never wiki/AGENTS.md),
outputs/, and raw/manifest.json may change, and HEAD may not move;
(2) frontmatter — every changed wiki page parses with the required
fields; (3) wikilinks — every [[wikilink]] in a changed page
resolves. A tripped check auto-reverts the data repo to its pre-run
state and exits 1; an agent timeout still runs the guardrails (the
partial edits stay when they pass) and exits 1.

Nothing commits: the edits stay in the working tree, and the next
wiki-sync cycle's citation wall, verification, commit, and publish
stages carry them. On a terminal the agent run shows one animated
status line; piped or NO_COLOR runs get one plain heartbeat line per
60 seconds. Live progress goes to stderr; the digest goes to stdout.`;

/** The wiki-lint argv spec: the agent-run value flags, the instance
 *  `--wiki` name (short alias -w), and at most one `<raw-dir>`
 *  positional. */
export const LINT_CLI_SPEC = {
  value: ["--settings", "--timeout", "--wiki"],
  alias: new Map([["-w", "--wiki"]]),
  positionals: {
    max: 1,
    error: (_arg: string, count: number) =>
      `expected at most one <raw-dir> argument, got ${count}`,
  },
} as const satisfies CliSpec;

/** wiki-lint's CLI flag set, derived once from the parsed argv. */
export interface LintCliFlags {
  readonly settings: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly rawDir: string | undefined;
  /** The --wiki instance name, when passed. */
  readonly wiki: string | undefined;
}

/** The empty flag set an invalid argv derives: nothing runs. */
function emptyFlags(): LintCliFlags {
  return {
    settings: undefined,
    timeoutMs: undefined,
    rawDir: undefined,
    wiki: undefined,
  };
}

/** Derive wiki-lint's flag set from the parsed argv: the instance
 *  name through its own validator, then the agent-run flags
 *  (settings, timeout) through the shared derivation. */
export function lintFlags(parsed: ParsedCli): {
  flags: LintCliFlags;
  error: string | undefined;
} {
  if (parsed.error !== undefined) {
    return { flags: emptyFlags(), error: parsed.error };
  }

  const wikiError = wikiArgError(parsed.values);

  if (wikiError !== undefined) {
    return { flags: emptyFlags(), error: wikiError };
  }

  const pathValues = new Map(parsed.values);

  pathValues.delete("--wiki");

  const runFlags = agentRunFlags(pathValues);

  if (runFlags.error !== undefined) {
    return { flags: emptyFlags(), error: runFlags.error };
  }

  return {
    flags: {
      settings: runFlags.settings,
      timeoutMs: runFlags.timeoutMs,
      rawDir: parsed.positional[0],
      wiki: parsed.values.get("--wiki"),
    },
    error: undefined,
  };
}

/** The door's heartbeat prefix: the stage's line, re-labelled. */
const LINT_DOOR_HEARTBEAT_PREFIX = "wiki-lint agent still running";

/** The stage's "wiki-sync: lint" labels, re-labelled for this door. */
function doorLabel(message: string): string {
  return message.replaceAll("wiki-sync: lint", "wiki-lint");
}

/** The stdout digest: where the report landed, then the agent's own
 *  summary. */
function digest(result: LintResult): string {
  const report = result.reportWritten
    ? result.reportPath
    : `${result.reportPath} (not written)`;

  return `# wiki-lint digest\n\n- report: ${report}\n\n${result.summary}`;
}

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-lint", message);
}

/** Run the lint stage for the derived CLI flags and print the
 *  digest; errors print red and set the exit code. The instance
 *  resolves through the shared chain; each explicit flag or
 *  positional overrides its derived counterpart. */
async function runCliLint(parsed: {
  flags: LintCliFlags;
  heartbeatMs: number | undefined;
  onProgress: (message: string) => void;
  sink: ReturnType<typeof stderrSink>["sink"];
}): Promise<void> {
  try {
    const instance = await resolveWikiInstance({
      checkout: repoRoot,
      name: parsed.flags.wiki,
      home: homedir(),
    });
    const result = await runLintStage({
      settingsPath: parsed.flags.settings ?? instance.settingsPath,
      run: runContext({
        rawDir: parsed.flags.rawDir ?? instance.rawDir,
        onProgress: parsed.onProgress,
      }),
      promptsDir: join(repoRoot, "prompts"),
      timeoutMs: parsed.flags.timeoutMs,
      heartbeatMs: parsed.heartbeatMs,
    });

    parsed.sink.end();
    console.log(digest(result));
  } catch (error) {
    parsed.sink.end();
    console.error(colors().red(`wiki-lint: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/** wiki-lint entry point: `wiki-lint [-h | --help] [--wiki, -w <name>] [--settings <path>] [--timeout <secs>] [<raw-dir>]`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, LINT_CLI_SPEC);

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const { flags, error } = lintFlags(parsed);

  if (error !== undefined) {
    fail(error);

    return;
  }

  const { sink, animated } = stderrSink(LINT_DOOR_HEARTBEAT_PREFIX);

  await runCliLint({
    flags,
    heartbeatMs: animated ? 100 : undefined,
    onProgress: (message) => sink.render(doorLabel(message)),
    sink,
  });
}

/* v8 ignore next: covered only under direct `node src/sync/wiki-lint.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-lint");
