/**
 * The wiki-lint CLI: the lint stage's standalone door. The run
 * itself — the prompt, the guardrails, the auto-revert — is
 * runLintStage from lint-stage.ts, invoked unchanged; this module
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
import { type LintResult, runLintStage } from "./lint-stage.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-lint [-h | --help] [--full] [--wiki, -w <name>] [--settings <path>] [--timeout <secs>] [<raw-dir>]

Run the quality-lint agent over the data repo's wiki, alone — no
sync, no ingest, no commit. The lint stage of the wiki-sync cycle,
as a standalone command: same agent settings, same post-run
guardrails and auto-revert. Use it when the cycle's lint timed out
(its partial edits stay in the working tree; the audit never
finished) or when the cycle skipped lint (lint runs only after an
ingest).

Windowed by default: with a lint-window snapshot from a
previous successful lint, the audit covers only the pages changed
since plus their reverse-link neighbors (prompts/lint-window.md); a
missing snapshot means a first run and audits everything
(prompts/lint.md). The deterministic worklists (orphan,
single-source, frontmatter, tag, index, duplicate-title candidates)
ride in the prompt — the agent judges, never scans.

Switches and arguments:
  --full             Audit every page (prompts/lint.md, the complete
                     check list including the global report-only
                     checks), whatever the snapshot says; the snapshot
                     still advances on success. Default: absent —
                     windowed when a snapshot exists, full otherwise.
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
                     heavy audit (the weekly full sweep runs with
                     7200 through scheduled-run --lint-full).
  -h, --help         Print this help and exit; no side effects.
  <raw-dir>          raw/ directory; its parent is the data repo the
                     agent runs in. Default: <dataRoot>/raw from the
                     resolved instance's sync config.

What it writes:
  - wiki pages, by the agent, in the data repo (never raw/);
  - the lint report at outputs/lint-<YYYY-MM-DD>.md in the DATA
    repo's outputs/ — the same path the cycle's lint stage uses;
  - the lint-window snapshot outputs/lint-window.json (gitignored,
    per-instance state) after a completed audit.

After the agent run the same three guardrails as the cycle check the
data repo: (1) immutability — only wiki/ (never wiki/AGENTS.md),
outputs/, and raw/manifest.json may change, and HEAD may not move;
(2) frontmatter — every changed wiki page parses with the required
fields; (3) wikilinks — every [[wikilink]] in a changed page
resolves. A tripped check auto-reverts the data repo to its pre-run
state and exits 1; an agent timeout still runs the guardrails (the
partial edits stay when they pass) and exits 1 — the untouched
snapshot makes the next run retry the same window.

Nothing commits: the edits stay in the working tree, and the next
wiki-sync cycle's citation wall, verification, commit, and publish
stages carry them. On a terminal the agent run shows one animated
status line; piped or NO_COLOR runs get one plain heartbeat line per
60 seconds. Live progress goes to stderr; the digest goes to stdout.`;

/** The wiki-lint argv spec: the agent-run value flags, the instance
 *  `--wiki` name (short alias -w), the `--full` boolean, and at most
 *  one `<raw-dir>` positional. */
export const LINT_CLI_SPEC = {
  value: ["--settings", "--timeout", "--wiki"],
  boolean: ["--full"],
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
  /** Whether --full forced the whole-wiki audit. */
  readonly full: boolean;
}

/** The empty flag set an invalid argv derives: nothing runs. */
function emptyFlags(): LintCliFlags {
  return {
    settings: undefined,
    timeoutMs: undefined,
    rawDir: undefined,
    wiki: undefined,
    full: false,
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
      full: parsed.flags.has("--full"),
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

/** The stdout digest: which audit ran, where the report landed, then
 *  the agent's own summary. */
function digest(result: LintResult): string {
  const report = result.reportWritten
    ? result.reportPath
    : `${result.reportPath} (not written)`;
  const audit =
    result.skipped === "empty-window"
      ? "window empty — nothing changed since the last audit"
      : `${result.mode} audit (${pluralAudit(result)})`;

  return `# wiki-lint digest\n\n- audit: ${audit}\n- report: ${report}\n\n${result.summary}`;
}

/** The audit's page scope for the digest line. */
function pluralAudit(result: LintResult): string {
  const pages = result.windowPages ?? undefined;

  return pages === undefined
    ? "every page"
    : `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
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
      full: parsed.flags.full,
    });

    parsed.sink.end();
    console.log(digest(result));
  } catch (error) {
    parsed.sink.end();
    console.error(colors().red(`wiki-lint: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/** wiki-lint entry point: `wiki-lint [-h | --help] [--full] [--wiki, -w <name>] [--settings <path>] [--timeout <secs>] [<raw-dir>]`. */
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
