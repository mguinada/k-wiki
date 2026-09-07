/**
 * The `propose` verb (issue #340, family 6 of epic #289): the v1
 * agent write verb — the accept-gate's caller. One candidate note
 * per invocation (decision 11): the body comes from a file (or
 * stdin), the verb wraps it in the deterministic template, composes
 * the sandbox-write prompt, and drives family 3's primitive —
 * write, accept-gate, stamp, atomic commit as one process with one
 * exit code (decision 13). Redirect-not-reject: a write through
 * this verb IS a sandbox write — the note lands under wiki/sandbox/
 * of the instance resolved through the verb's own chain (decision
 * 10: the -w/--wiki flag beats the binding's wiki key, decision
 * 12), never an ambient cwd default. There is no ungated write
 * path: a run whose agent touches anything outside wiki/sandbox/
 * is path-scoped-reverted and fails loudly. The sandbox write
 * rules live in prompts/propose.md (the writing agent's contract)
 * and the landed docs — not in wiki/AGENTS.md, whose scope is the
 * reviewed wiki surface (the #336 landed-docs decision).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bindingSettings, resolveAgentInstance } from "../cli/agent-verbs.ts";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { resolveCheckout } from "../cli/k-wiki-binding.ts";
import { stderrSink } from "../cli/progress.ts";
import { runContext } from "../cli/run-context.ts";
import { agentRunFlags, type ParsedCli, parseArgs } from "../cli/shell.ts";
import { readPrompt } from "../ingest/agent-run.ts";
import { loadAgentSettings } from "../ingest/agent-settings.ts";
import { wikiArgError } from "../sync/instance.ts";
import { isPageType, PAGE_TYPES } from "../wiki/browse.ts";
import { runSandboxRun, slugError } from "./sandbox-run.ts";

/** Help for `k-wiki propose -h`: the verb's own contract, per the
 *  repo's help rule (every switch, argument, and default; prints
 *  before any argument is validated or any file is read). */
export const HELP = `Usage: k-wiki propose [-h | --help] [-w, --wiki <name>] [--checkout <path>]
       [--timeout <secs>] [--title <text>] [--type <type>] <slug> [<file>]

Propose one candidate note for the wiki — the agent write verb.
The note body comes from <file> (or stdin when no file is given),
is wrapped in the deterministic template, and lands under
wiki/sandbox/ of the resolved wiki instance as one gated run:
write, accept-gate (only wiki/sandbox/ deltas survive; anything
else is path-scoped-reverted and the run fails), stamp (via:
agent, expires:), and one atomic sandbox: <slug> commit with a
wiki/log.md audit entry. The note is provisional: a human reviews
and promotes it into the wiki; filing is a human step. Works
identically on both doors — a write through this verb is a
sandbox write by construction.

Arguments:
  <slug>    The candidate note's identity: lowercase kebab-case
            (letters and digits, single hyphens). Derives the note's
            path wiki/sandbox/<slug>.md; a second run with the same
            slug refuses — no overwrite, no silent suffixing.
  <file>    The note body, Markdown. Read from stdin when omitted;
            a terminal without a piped stdin is a usage error.

Options:
  -w, --wiki <name>   Select the wiki instance — an alias in
                      sync.json's instances map first, then a
                      sync-<name>.json stem in the checkout root —
                      overriding the binding's wiki key. An unknown
                      name fails listing every known name.
  --checkout <path>   k-wiki checkout for this run (a ~ path
                      expands).
  --timeout <secs>    Kill the agent run after this many seconds
                      and fail it. Default: 1800.
  --title <text>      The note's title frontmatter; one line.
                      Default: the slug.
  --type <type>       The note's type frontmatter:
                      concept|entity|source|query|comparison.
                      Default: query.
  -h, --help          This help; no side effects.

What it writes: one candidate page wiki/sandbox/<slug>.md plus one
wiki/log.md audit entry, committed together as sandbox: <slug> in
the resolved instance's data repo — nothing else; a run touching
any other path reverts its own changes and exits 1. On success
prints the proposed path and the commit. The note carries an
expires: stamp (at least 7 days out); expired notes are deleted by
the wiki-ingest hygiene sweep unless a human promotes them first.
Errors print red, prefixed k-wiki:, and exit 1; progress lines go
to stderr; NO_COLOR is honored.`;

/** Print one usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("k-wiki", message);
}

/** The note body with its trailing whitespace normalized to one
 *  final newline — byte-exact everywhere else. */
function normalizeBody(body: string): string {
  return `${body.replace(/\s+$/, "")}\n`;
}

/** The deterministic candidate-note template: title and type
 *  frontmatter (single-line JSON-quoted title), blank line, the
 *  body. The epilogue appends the via:/expires: stamps itself —
 *  caller-supplied ones are overwritten (stamp authority). */
export function templateCandidateNote(input: {
  readonly title: string;
  readonly type: string;
  readonly body: string;
}): string {
  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    `type: ${input.type}`,
    "---",
    "",
    normalizeBody(input.body),
  ].join("\n");
}

/** Compose the agent message: the sandbox-write prompt, the exact
 *  target path, and the note fenced between explicit markers —
 *  the agent writes exactly those bytes, nothing else. */
export function composeProposePrompt(
  promptText: string,
  slug: string,
  note: string,
): string {
  return [
    promptText,
    "",
    `Target path: wiki/sandbox/${slug}.md`,
    "",
    "Note content — write exactly this, byte for byte:",
    "-----BEGIN NOTE-----",
    note,
    "-----END NOTE-----",
  ].join("\n");
}

/** The slug-and-input usage error, undefined when valid. */
function positionalError(
  cli: ParsedCli,
  stdinIsTty: boolean,
): string | undefined {
  const slug = cli.positional[0];

  if (slug === undefined) {
    return "a <slug> is required: k-wiki propose <slug> [<file>]";
  }

  const error = slugError(slug);

  if (error !== undefined) {
    return error;
  }

  if (cli.positional[1] === undefined && stdinIsTty) {
    return "the note body is required: pass a <file> argument or pipe the note on stdin";
  }

  return undefined;
}

/** The --title/--type usage error, undefined when valid. */
function noteMetaError(
  values: ReadonlyMap<string, string | undefined>,
): string | undefined {
  const title = values.get("--title");

  if (title?.includes("\n") === true) {
    return "--title must be a single line";
  }

  const type = values.get("--type") ?? "query";

  if (!isPageType(type)) {
    return `unknown type ${JSON.stringify(type)}; valid types: ${PAGE_TYPES.join("|")}`;
  }

  return undefined;
}

/** The verb's usage error, undefined when its argv is valid: the
 *  shell's parse error first, then the shared --wiki/--timeout
 *  rules, the positional rules, and the note-meta rules. */
export function proposeArgError(
  cli: ParsedCli,
  stdinIsTty: boolean,
): string | undefined {
  return (
    cli.error ??
    wikiArgError(cli.values) ??
    agentRunFlags(cli.values).error ??
    positionalError(cli, stdinIsTty) ??
    noteMetaError(cli.values)
  );
}

/** Read the note body: the file argument, or stdin to EOF. */
async function readNoteBody(file: string | undefined): Promise<string> {
  if (file === undefined) {
    return await new Promise<string>((resolve, reject) => {
      let text = "";

      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        text += chunk;
      });
      process.stdin.on("end", () => resolve(text));
      process.stdin.on("error", reject);
    });
  }

  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    throw new Error(`cannot read the note file at ${file}`, { cause });
  }
}

/** What one validated run carries: the slug, the body source, and
 *  the parsed flag values. */
interface ProposeInput {
  readonly slug: string;
  readonly file: string | undefined;
  readonly values: ReadonlyMap<string, string | undefined>;
}

/** Resolve the checkout and the instance through the verb's own
 *  chain (decision 10): the -w/--wiki flag beats the binding's
 *  wiki key (decision 12), and the run context follows the
 *  instance — never an ambient cwd default. */
async function resolveInstance(input: ProposeInput, home: string) {
  const resolution = await resolveCheckout({
    flag: input.values.get("--checkout"),
    env: process.env,
    cwd: process.cwd(),
    home,
  });

  return {
    resolution,
    instance: await resolveAgentInstance(
      resolution,
      home,
      input.values.get("--wiki"),
    ),
  };
}

/** Drive one gated proposal: template the note, compose the prompt,
 *  and run family 3's primitive; print the landed page on success. */
async function runPropose(input: ProposeInput): Promise<void> {
  const body = await readNoteBody(input.file);

  if (body.trim() === "") {
    throw new Error("the note body is empty — nothing to propose");
  }

  const home = homedir();
  const { resolution, instance } = await resolveInstance(input, home);
  const settings = await loadAgentSettings(
    bindingSettings(resolution, instance),
  );
  const { sink } = stderrSink(`k-wiki: proposing ${input.slug}`);

  try {
    const run = runContext({
      rawDir: instance.rawDir,
      onProgress: sink.render,
    });
    const promptText = await readPrompt(
      join(resolution.checkout, "prompts", "propose.md"),
    );
    const note = templateCandidateNote({
      title: input.values.get("--title") ?? input.slug,
      type: input.values.get("--type") ?? "query",
      body,
    });
    const result = await runSandboxRun({
      instance,
      run,
      settings,
      slug: input.slug,
      prompt: composeProposePrompt(promptText, input.slug, note),
      timeoutMs: agentRunFlags(input.values).timeoutMs,
    });

    if (result.status === "empty") {
      throw new Error("the agent run wrote nothing — no note was proposed");
    }

    console.log(
      `proposed ${result.pages.join(", ")} (commit ${result.commit.slice(0, 8)}) — a human reviews and promotes it into the wiki; filing is a human step`,
    );
  } finally {
    sink.end();
  }
}

/** The propose verb's runner (the verb-table dispatch target, like
 *  the read verbs' runAgentVerbs — no launcher of its own): parse,
 *  validate, and drive the gated run. */
export async function runProposeVerb(args: readonly string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const cli = parseArgs(args, {
    value: ["--checkout", "--timeout", "--wiki", "--title", "--type"],
    alias: new Map([["-w", "--wiki"]]),
    positionals: {
      max: 2,
      error: (arg) => `unexpected argument ${JSON.stringify(arg)}`,
    },
  });
  const error = proposeArgError(cli, process.stdin.isTTY === true);

  if (error !== undefined) {
    fail(error);

    return;
  }

  try {
    await runPropose({
      slug: cli.positional[0] ?? "",
      file: cli.positional[1],
      values: cli.values,
    });
  } catch (caught) {
    fail(errorMessage(caught));
  }
}
