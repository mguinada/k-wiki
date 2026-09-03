/**
 * The wiki-ingest CLI (issue #258, split from wiki-ingest.ts so the
 * orchestrator module carries no argv parsing): the help text, the
 * flag derivation on the shared shell (B1's parseArgs — hand-rolled
 * flag scanning is gone), and the main() entry point. The run
 * itself lives in wiki-ingest.ts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../cli/colors.ts";
import { flagValueError } from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { type ProgressSink, stderrSink } from "../cli/progress.ts";
import { runContext } from "../cli/run-context.ts";
import { repoRoot } from "../cli/shared.ts";
import { type CliSpec, type ParsedCli, parseArgs } from "../cli/shell.ts";
import { loadSyncConfig, resolveRawDir } from "../sync/config.ts";
import { AGENT_HEARTBEAT_PREFIX, runWikiIngest } from "./wiki-ingest.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [--note <text>] [<raw-dir>]

Run the wiki agent headless over the sources that changed since the
last ingest, then write a per-run digest (guide §18).

Flow: read the raw manifest, diff it against the snapshot from the
previous successful run (<dataRoot>/outputs/last-ingested-manifest.json
— the data repo's outputs/, not this repo's; a legacy snapshot in
this repo's outputs/ is adopted into the data repo on first run), pick
prompts/ingest.md (no snapshot yet — first run),
prompts/incremental.md (changed sources appended to the prompt), or
prompts/expunge.md (a synced note was deleted — the removed note's
last content is recovered from the data repo's git history and
appended with the deterministic direct set of affected wiki pages; a
remove+add pair in one vault with an identical content hash is a
rename/retitle, not a deletion; an expunge run that also carries
added, edited, or renamed sources gets prompts/incremental.md
appended below the expunge prompt, so those sources are ingested in
the same run), invoke the agent CLI non-interactively in the data
repo root (the parent of the raw dir), and record what happened.

Before the agent runs, a pre-flight check lists tracked files that
also match an ignore rule — gitignore does not apply to tracked
files, so such a rule covers nothing and an external writer (an open
Obsidian) would trip guardrail 1 — as one yellow WARNING per file
with its fix (git rm --cached <path>); a signal, not a gate.

Switches and arguments:
  --settings <path>  Agent settings file. Default: the repo's
                     settings.yml — command, model, provider, and reasoning
                     level, passed to the agent as --model/--thinking;
                     provider is optional and passed as --provider when set.
                     isolate (true by default, false to opt out) adds the
                     pi isolation flags --no-context-files --no-extensions
                     --no-skills so global agent config cannot leak into
                     spawned runs. isolate.skills and
                     isolate.extensions (optional comma-separated lists)
                     whitelist specific entries back in:
                     one --skill flag per skill dir (a path, resolved
                     against the settings file's directory, ~ allowed)
                     and one -e flag per extension source (a path,
                     npm:<package>, or git:<repo>) — additive even under
                     the --no-* flags, so exactly the named entries load.
                     Each entry is a deliberate trust grant; an entry
                     that is missing warns and is omitted, and the run
                     proceeds. Both keys are ignored with isolate: false.
  --outputs <dir>    Where the run digest (runs/<timestamp>.md) goes.
                     Default: the repo's outputs/. The manifest snapshot
                     always lives in the data repo's outputs/ and is not
                     moved by this switch.
  --timeout <secs>   Kill the agent run after this many seconds and
                     fail it; the snapshot stays untouched. Default:
                     1800 (30 minutes).
  --sources <vault/path>
                     Scoped re-ingest of explicit sources:
                     re-open exactly these sources against the existing
                     wiki — the recovery affordance for a wiki that is
                     complete but under-filed. Repeatable; paths are
                     exact manifest paths (<vault name>/<vault-relative
                     path>), no globbing, no substring
                     matching — an unknown path is an error naming it.
                     Duplicates dedupe; the list sorts. The explicit
                     list replaces the manifest diff (every path a \`~\`
                     changed line), forces prompts/incremental.md, and
                     bypasses the no-change skip. On success the run
                     writes a merged snapshot — the previous snapshot
                     plus the explicit paths' current entries — so the
                     pending manifest diff outside the list stays
                     pending for the next ordinary run.
                     Requires a valid
                     manifest snapshot for this data root; a missing or
                     foreign-stamped snapshot is an error:
                     run a full ingest first. Never touches raw/ or
                     the vault.
  --note <text>      Operator intent for a scoped --sources run:
                     appended verbatim below the
                     changed-source list under an "Operator note:"
                     heading, so a re-opened set re-adjudicates filing
                     decisions instead of re-applying the no-change
                     precedent. Single flag; requires --sources, and
                     never lands on ordinary incremental, expunge, or
                     full runs. Default when --sources is present
                     without --note: a static line stating that
                     unchanged content does not imply a no-op and
                     asking the agent to re-adjudicate filing
                     decisions (if declining, to state per concept why
                     its treatment fails the page bar).
  -h, --help         Print this help and exit; no side effects.
  <raw-dir>          raw/ directory holding manifest.json. Default:
                     <dataRoot>/raw from sync.json, otherwise the
                     repo's own raw/.

What it writes:
  - wiki pages, by the agent, in the data repo (never raw/);
  - <dataRoot>/outputs/last-ingested-manifest.json — the manifest
    snapshot the next run diffs against (written after a successful
    agent run; a --sources run writes a merged snapshot that keeps
    pending changes outside the list pending), stamped with its data repo root: a snapshot stamped
    for another instance — or an unstamped legacy one — is ignored
    with a loud warning and the run falls back to full mode. A
    legacy snapshot in this repo's outputs/ is adopted (copied) into
    the data repo when the data repo has none;
  - outputs/runs/<timestamp>.md — the digest, also printed to stdout.

After every agent run three guardrails check the data repo (guide
§1, §7, §9): (1) immutability — only wiki/ (never the
wiki/AGENTS.md contract), outputs/, and raw/manifest.json may change,
and HEAD may not move; (2) frontmatter — every changed wiki page
parses with the required fields (wiki/log.md, the append-only log,
is exempt); (3) wikilinks — every [[wikilink]]
in a changed page resolves, and no remaining page links to a page
the run deleted. A tripped check auto-reverts the data repo to its
pre-run state (the pre-run commit plus the uncommitted work that
preceded the run), writes a failure digest naming the check, and
exits 1.

With no changed sources since the snapshot nothing runs: it says so
and exits 0 — unless --sources is present: the explicit list is the
change set even when the snapshot matches the manifest. A digest is labeled expunge when the run purged deleted
sources: it carries the direct-set preview, a deleted wiki-pages
category, and the agent's threshold decision. On a terminal (TTY, color enabled) the agent run shows
one animated status line - a braille spinner plus the elapsed time -
rewritten in place; piped, redirected, CI, or NO_COLOR runs get one
plain heartbeat line per 60 seconds instead. A run that fails or
exceeds the timeout still runs the guardrails, exits 1, and leaves
the snapshot untouched, so the next run retries the same sources. Live progress
goes to stderr; the digest goes to stdout. Unattended scheduling is
setup-schedule.`;

/** The wiki-ingest argv spec: the agent-run value flags plus the
 *  text `--note`, the repeatable `--sources`, and at most one
 *  `<raw-dir>` positional. */
const INGEST_SPEC = {
  value: ["--settings", "--outputs", "--timeout", "--note"],
  repeat: ["--sources"],
  positionals: {
    max: 1,
    error: (_arg: string, count: number) =>
      `expected at most one <raw-dir> argument, got ${count}`,
  },
} as const satisfies CliSpec;

/** wiki-ingest's CLI flag set, derived once from the parsed argv:
 *  the agent-run flags, the scoped `--sources` list typed after the
 *  presence check (the cast the old main() cast away — the invariant
 *  is now visible to the type system), and the operator note. */
export interface IngestCliFlags {
  readonly settings: string | undefined;
  readonly outputs: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly rawDir: string | undefined;
  readonly sources: readonly string[];
  readonly note: string | undefined;
}

/** The empty flag set an invalid argv derives: nothing runs. */
function emptyFlags(): IngestCliFlags {
  return {
    settings: undefined,
    outputs: undefined,
    timeoutMs: undefined,
    rawDir: undefined,
    sources: [],
    note: undefined,
  };
}

/** The `--note` usage error, or undefined when it is valid: the
 *  value is required, and a note only rides a scoped `--sources`
 *  run (issue #149). `--note` is a text flag: it validates here and
 *  never enters the path-flag validation — the old overlap where
 *  flag-args.ts disagreed about a missing value is gone (issue
 *  #258, C-17). */
function noteArgError(
  values: ReadonlyMap<string, string | undefined>,
  sourcesCount: number,
): string | undefined {
  const note = values.get("--note");

  if (values.has("--note") && (note === undefined || note.trim() === "")) {
    return "--note needs a value";
  }

  if (note !== undefined && sourcesCount === 0) {
    return "--note requires --sources";
  }

  return undefined;
}

/** The values without `--note`: the text flag's validator owns it
 *  entirely, so the shared path-flag validation never sees it. */
function pathValues(
  values: ReadonlyMap<string, string | undefined>,
): Map<string, string | undefined> {
  const paths = new Map(values);

  paths.delete("--note");

  return paths;
}

/** The collected `--sources` values, all present. The caller
 *  validates presence first; this predicate makes the invariant
 *  visible to the type system instead of a cast (issue #258, C-12). */
function definedSources(
  values: readonly (string | undefined)[],
): values is string[] {
  return values.every((value) => value !== undefined);
}

/** Derive wiki-ingest's flag set from the parsed argv: `--note` by
 *  its own validator, then the path flags, the sources values, and
 *  `--timeout` through the shared `flagValueError` — in that order,
 *  so the first usage error matches the historic precedence. */
export function ingestFlags(parsed: ParsedCli): {
  flags: IngestCliFlags;
  error: string | undefined;
} {
  if (parsed.error !== undefined) {
    return { flags: emptyFlags(), error: parsed.error };
  }

  const sourcesRaw = parsed.repeated.get("--sources") ?? [];
  const noteError = noteArgError(parsed.values, sourcesRaw.length);

  if (noteError !== undefined) {
    return { flags: emptyFlags(), error: noteError };
  }

  const error = flagValueError(pathValues(parsed.values), sourcesRaw);

  if (error !== undefined) {
    return { flags: emptyFlags(), error };
  }

  const timeout = parsed.values.get("--timeout");

  return {
    flags: {
      settings: parsed.values.get("--settings"),
      outputs: parsed.values.get("--outputs"),
      timeoutMs: timeout === undefined ? undefined : Number(timeout) * 1000,
      rawDir: parsed.positional[0],
      sources: definedSources(sourcesRaw) ? sourcesRaw : [],
      note: parsed.values.get("--note"),
    },
    error: undefined,
  };
}

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-ingest", message);
}

/** Run the ingest with the derived CLI flags and print the outcome;
 *  errors print red and set the exit code. */
async function runCliIngest(parsed: {
  flags: IngestCliFlags;
  heartbeatMs: number | undefined;
  sink: ProgressSink;
}): Promise<void> {

  try {
    const config = await loadSyncConfig(join(repoRoot, "sync.json"), homedir());
    const rawDir =
      parsed.flags.rawDir ?? resolveRawDir(config.dataRoot, repoRoot);
    const result = await runWikiIngest({
      settingsPath: parsed.flags.settings ?? join(repoRoot, "settings.yml"),
      run: runContext({ rawDir, onProgress: parsed.sink.render }),
      outputsDir: parsed.flags.outputs ?? join(repoRoot, "outputs"),
      promptsDir: join(repoRoot, "prompts"),
      sources: parsed.flags.sources,
      note: parsed.flags.note,
      timeoutMs: parsed.flags.timeoutMs,
      heartbeatMs: parsed.heartbeatMs,
    });

    parsed.sink.end();

    if (result.status === "skipped") {
      console.log(`wiki-ingest: ${result.reason}`);

      return;
    }

    console.log(result.digest);
  } catch (error) {
    parsed.sink.end();
    console.error(colors().red(`wiki-ingest: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/** wiki-ingest entry point: `wiki-ingest [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [--note <text>] [<raw-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, INGEST_SPEC);

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const { flags, error } = ingestFlags(parsed);

  if (error !== undefined) {
    fail(error);

    return;
  }

  const { sink, animated } = stderrSink(AGENT_HEARTBEAT_PREFIX);

  await runCliIngest({ flags, heartbeatMs: animated ? 100 : undefined, sink });
}

/* v8 ignore next: covered only under direct `node src/ingest/wiki-ingest-cli.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-ingest");
