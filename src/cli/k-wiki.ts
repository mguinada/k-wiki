import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { checkRaw, printHealthReport } from "../health/check-raw.ts";
import { runQueryCli } from "../query/query-shell.ts";
import { resolveWikiInstance, type WikiInstance } from "../sync/instance.ts";
import {
  filteredLines,
  groupedLines,
  groupPages,
  isPageType,
  listablePages,
  lookupPage,
  PAGE_TYPES,
} from "../wiki/browse.ts";
import { cliFail } from "./colors.ts";
import { refuseDirectExecution } from "./is-main.ts";
import {
  CHECKOUT_ENV,
  type CheckoutResolution,
  resolveCheckout,
} from "./k-wiki-binding.ts";
import { type RunContext, runContext } from "./run-context.ts";
import { agentRunFlags, parseArgs } from "./shell.ts";

/**
 * k-wiki: the agent-facing query entry point (guide §16, issue #76).
 * `k-wiki query "<question>"` asks the wiki bound to the current
 * project from any cwd — zero flags when a `.k-wiki.json` binding
 * exists — and delegates to the answer-only `runWikiQuery`. There is
 * no filing passthrough: filing stays the human-run
 * `wiki-query --file-last` inside the checkout (issue #72's two-stage
 * design). One command, the shared CLI shell, no framework (§27).
 * The binding-file schema and checkout resolution live in
 * k-wiki-binding.ts; the browsing domain logic in src/wiki/browse.ts.
 */

/** Human phrase for each checkout resolution origin. */
const ORIGIN_LABELS = {
  flag: "the --checkout flag",
  env: `the ${CHECKOUT_ENV} environment variable`,
  file: ".k-wiki.json",
  cwd: "the cwd itself",
} as const;

/** The k-wiki command vocabulary (drift-guarded against the
 *  k-wiki skill by tests/cli/k-wiki-skill.test.ts). */
export const COMMANDS = ["query", "status", "list", "read", "health"] as const;

/** COMMANDS widened to strings for membership checks on runtime
 *  input (cast the receiver, never the argument). */
const COMMAND_NAMES = COMMANDS as readonly string[];

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: k-wiki [-h | --help] | k-wiki <command> [<args>]
       k-wiki query [--checkout <path>] [--timeout <secs>] <question>
       k-wiki status
       k-wiki list [<type>]
       k-wiki read <slug>
       k-wiki health [--fail-on-stale]

The agent-facing entry point (guide §16): one LLM command
(query) and four read-only deterministic ones (status, list, read,
health), usable from any cwd with zero flags once the project is
bound. One command set — the shared CLI shell, no CLI framework. None of
them can write to the wiki.

Binding file .k-wiki.json (at the bound project's root):
  { "checkout": "~/k-wiki", "wiki": "meta", "settings": "settings-meta.yml" }
  checkout — a k-wiki checkout whose sync.json resolves the data
    repo; its prompts/, outputs/, and settings live there too.
  wiki — optional instance name inside the checkout: resolved
    through the checkout's registry — an alias in sync.json's
    instances map first, then a free stem sync-<name>.json in the
    checkout root — and every derived path follows the resolved
    config: its dataRoot is the data repo queried, and the saved
    answer goes to outputs-<stem>/ (outputs/ and settings.yml for
    the default instance, whose stem is sync.json). An unknown
    name fails listing every known name. Default: absent — the
    default instance. Exactly one wiki per binding: the file must
    be a single JSON object; lists and multi-wiki forms are
    rejected — one project binds exactly one wiki, so no ambient
    path exists between work and personal knowledge.
  settings — optional non-default settings file inside the checkout
    (e.g. settings-meta.yml); overrides the instance's derived
    settings file (settings-<stem>.yml, falling back to settings.yml).
  Gitignore the file in personal projects; commit it in team
    projects.

Checkout resolution order (first hit wins, every command):
  1. --checkout <path>   this run's checkout (a ~ path is expanded)
  2. K_WIKI_CHECKOUT     environment variable naming a checkout
  3. .k-wiki.json        nearest binding found walking up from the
                         cwd, stopping at the home directory or the
                         filesystem root
  4. the cwd itself      today's behavior preserved: run from inside
                         the k-wiki checkout

Commands:
  query <question>   Ask the bound wiki one question (the only LLM
                     command). Prints the answer, saves the run to
                     <checkout>/outputs/last-query.md; answer-only
                     by construction: any change under wiki/
                     during the run reverts the data repo and fails.
                     Filing is not exposed here.
  status             Print the resolved binding: checkout, origin,
                     instance name, sync config, settings file, data
                     repo, outputs dir, wiki dir, index.md.
                     No agent, no side effects.
  list [<type>]      Print one 'slug — title' line per wiki page,
                     grouped by type in index.md order; the navigation
                     pages (index, log, overview) are not listed —
                     read them by name. Optional filter, one of
                     concept|entity|source|query|comparison.
  read <slug>        Print one page verbatim, resolved by file name
                     across the wiki tree (concepts/, sources/, …).
                     Absent slugs fail with near matches; file names
                     must stay unique (ambiguous names fail).
  health             Check the bound projection's coherence and
                     freshness (delegates to check-raw, read-only).
                     --fail-on-stale makes a stale projection exit 1.

Switches:
  --checkout <path>   k-wiki checkout for this run (all commands).
  --timeout <secs>    Kill the agent run after this many seconds and
                      fail it (query only). Default: 1800 (30 min).
  --fail-on-stale     Make a stale projection fail health (exit 1).
  -h, --help          Print this help and exit; no side effects.

What it writes: query writes <checkout>/outputs/last-query.md and
prints the answer; status, list, read, and health write nothing.
Errors print red, prefixed "k-wiki:", and exit 1. Progress goes to
stderr (an animated status line on a terminal, one plain heartbeat
line per 60 seconds otherwise); NO_COLOR is honored. Human alias,
optional:
alias k-wiki='node ~/k-wiki/bin/k-wiki'

If you are an AI agent, follow these instructions:
  - Run: k-wiki query "<question>" — zero flags inside a bound
    project.
  - The answer is stdout, nothing else. Progress goes to stderr;
    ignore it.
  - Exit 0 always carries an answer. If the wiki cannot answer, the
    answer says so and suggests sources — report that, do not retry.
  - Exit 1 means the run failed and nothing was saved; the error on
    stderr names the cause. Retry only if the cause is transient.
  - You cannot file the answer anywhere; filing is a human step
    (wiki-query --file-last, run by the human inside the checkout).
    Do not attempt wiki writes.
  - k-wiki status shows which wiki you are bound to and where it
    lives; run it before querying an unfamiliar project.
  - k-wiki list [type] and k-wiki read <slug> browse the wiki
    deterministically (no tokens): list prints one 'slug — title'
    line per page grouped by type; read prints one page verbatim.
  - k-wiki health checks the projection's coherence and freshness;
    check it before trusting answers from a repo-sourced projection.`;

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("k-wiki", message);
}

/** Print the resolved binding: origin, checkout, instance, paths
 *  (issue #76; the instance lines landed with issue #306). */
async function runStatus(
  resolution: CheckoutResolution,
  run: RunContext,
  instance: WikiInstance,
): Promise<void> {
  console.log(
    [
      `checkout:  ${resolution.checkout} (from ${ORIGIN_LABELS[resolution.origin]})`,
      `instance:  ${instance.name ?? "default"}`,
      `sync:      ${instance.configPath}`,
      `settings:  ${bindingSettings(resolution, instance)}`,
      `data repo: ${run.dataRoot}`,
      `outputs:   ${instance.outputsDir}`,
      `wiki:      ${run.wikiDir}`,
      `index:     ${join(run.wikiDir, "index.md")}`,
    ].join("\n"),
  );
}

/** The effective settings file: the binding's explicit settings key
 *  overrides the instance's derived settings — one precedence rule,
 *  mirroring the human door's flags (issue #306). */
function bindingSettings(
  resolution: CheckoutResolution,
  instance: WikiInstance,
): string {
  return resolution.settings === undefined
    ? instance.settingsPath
    : join(resolution.checkout, resolution.settings);
}

/** Print the structured wiki listing, grouped (or filtered) by type. */
async function runList(
  wikiDir: string,
  typeFilter: string | undefined,
): Promise<void> {
  if (typeFilter !== undefined && !isPageType(typeFilter)) {
    fail(
      `unknown type ${JSON.stringify(typeFilter)}; valid types: ${PAGE_TYPES.join("|")}`,
    );

    return;
  }

  const pages = await listablePages(wikiDir);

  if (typeFilter !== undefined) {
    console.log(filteredLines(pages, typeFilter).join("\n"));

    return;
  }

  console.log(groupedLines(groupPages(pages)).join("\n"));
}

/** Print one wiki page verbatim, resolved by file name. */
async function runRead(wikiDir: string, slug: string): Promise<void> {
  const lookup = await lookupPage(wikiDir, slug);

  if (lookup.kind === "page") {
    process.stdout.write(lookup.content);

    return;
  }

  if (lookup.kind === "ambiguous") {
    fail(
      `ambiguous page name ${JSON.stringify(slug)}: ${lookup.matches.join(", ")}`,
    );

    return;
  }

  fail(
    lookup.nearMatches.length === 0
      ? `no page named ${JSON.stringify(slug)}`
      : `no page named ${JSON.stringify(slug)}; near matches: ${lookup.nearMatches.join(", ")}`,
  );
}

/** Check the bound projection (delegates to check-raw, read-only). */
async function runHealth(rawDir: string, failOnStale: boolean): Promise<void> {
  printHealthReport(await checkRaw(rawDir), "k-wiki", failOnStale);
}

/** Usage error for k-wiki read's argument count, undefined when valid. */
function readArityError(rest: readonly string[]): string | undefined {
  if (rest.length === 0) {
    return "a <slug> is required: k-wiki read <slug>";
  }

  if (rest.length > 1) {
    return "k-wiki read takes exactly one <slug> argument";
  }

  return undefined;
}

/** Usage error for a command's argument count, undefined when valid. */
function arityErrorFor(
  command: string,
  rest: readonly string[],
): string | undefined {
  if ((command === "status" || command === "health") && rest.length > 0) {
    return `k-wiki ${command} takes no arguments (got ${JSON.stringify(rest[0])})`;
  }

  if (command === "list" && rest.length > 1) {
    return "k-wiki list takes at most one <type> argument";
  }

  if (command === "read") {
    return readArityError(rest);
  }

  return undefined;
}

/** Usage error for k-wiki query's question, undefined when valid. */
function queryUsageError(rest: readonly string[]): string | undefined {
  const question = rest[0] ?? "";

  if (question.trim() === "") {
    return 'a question is required: k-wiki query "<question>"';
  }

  if (rest.length > 1) {
    return `expected exactly one <question> argument, got ${rest.length}`;
  }

  return undefined;
}

/** Usage error for the command and its arguments, undefined when valid. */
function commandUsageError(
  command: string | undefined,
  rest: readonly string[],
): string | undefined {
  if (command === undefined) {
    return `a command is required: ${COMMANDS.map((c) => `k-wiki ${c}`).join(" | ")}`;
  }

  if (!COMMAND_NAMES.includes(command)) {
    return `unknown command ${JSON.stringify(command)}; the commands are: ${COMMANDS.join(", ")}`;
  }

  const arityError = arityErrorFor(command, rest);

  if (arityError !== undefined) {
    return arityError;
  }

  if (command === "query") {
    return queryUsageError(rest);
  }

  return undefined;
}

/** Resolve the checkout; undefined (already failed) when it throws. */
async function resolveCheckoutOrFail(input: {
  readonly flag: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
}): Promise<CheckoutResolution | undefined> {
  try {
    return await resolveCheckout(input);
  } catch (error) {
    fail(errorMessage(error));

    return undefined;
  }
}

/** The bound instance's run context and resolution, from the
 *  checkout's sync.json through the shared instance resolver: the
 *  binding's wiki key (issue #306) selects the config — the default
 *  instance when absent — and every derived path follows it. */
async function checkoutPaths(
  resolution: CheckoutResolution,
  home: string,
): Promise<{ run: RunContext; instance: WikiInstance }> {
  const instance = await resolveWikiInstance({
    checkout: resolution.checkout,
    name: resolution.wiki,
    home,
    nameSource: resolution.origin === "file" ? ".k-wiki.json" : undefined,
  });

  return { run: runContext({ rawDir: instance.rawDir }), instance };
}

/** Run status, list, read, or health; true when one of them ran. */
async function runReadOnlyCommand(
  command: string | undefined,
  rest: readonly string[],
  resolution: CheckoutResolution,
  run: RunContext,
  instance: WikiInstance,
  failOnStale: boolean,
): Promise<boolean> {
  if (command === "status") {
    await runStatus(resolution, run, instance);

    return true;
  }

  if (command === "list") {
    await runList(run.wikiDir, rest[0]);

    return true;
  }

  if (command === "read") {
    await runRead(run.wikiDir, rest[0] ?? "");

    return true;
  }

  if (command === "health") {
    await runHealth(run.rawDir, failOnStale);

    return true;
  }

  return false;
}

/** Run the one LLM command: query — the shared query shell (sink,
 *  runWikiQuery mapping, answer + dim hint, failure rendering). The
 *  settings and outputs paths follow the resolved instance (issue
 *  #306); the binding's explicit settings key still wins. */
async function runQueryCommand(
  resolution: CheckoutResolution,
  run: RunContext,
  instance: WikiInstance,
  timeoutMs: number | undefined,
  question: string,
): Promise<void> {
  const hint =
    instance.name === undefined
      ? "To file this answer (human step): wiki-query --file-last, run inside the checkout"
      : `To file this answer (human step): wiki-query --wiki ${instance.name} --file-last, run inside the checkout`;

  await runQueryCli({
    prefix: "k-wiki",
    settingsPath: bindingSettings(resolution, instance),
    rawDir: run.rawDir,
    promptsDir: join(resolution.checkout, "prompts"),
    outputsDir: instance.outputsDir,
    question,
    timeoutMs,
    hint,
  });
}

/** k-wiki entry point: `k-wiki [-h | --help] | k-wiki <command> [<args>]` — query, status, list, read, health. */
export async function main(cwd: string = process.cwd()): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const cli = parseArgs(args, {
    value: ["--checkout", "--timeout"],
    boolean: ["--fail-on-stale"],
  });

  if (cli.error !== undefined) {
    fail(cli.error);

    return;
  }

  const rest = cli.positional.slice(1);
  const runFlags = agentRunFlags(cli.values);
  const usageError =
    runFlags.error ?? commandUsageError(cli.positional[0], rest);

  if (usageError !== undefined) {
    fail(usageError);

    return;
  }

  const home = homedir();
  const resolution = await resolveCheckoutOrFail({
    flag: cli.values.get("--checkout"),
    env: process.env,
    cwd,
    home,
  });

  if (resolution === undefined) {
    return;
  }

  try {
    const { run, instance } = await checkoutPaths(resolution, home);
    const handled = await runReadOnlyCommand(
      cli.positional[0],
      rest,
      resolution,
      run,
      instance,
      cli.flags.has("--fail-on-stale"),
    );

    if (handled) {
      return;
    }

    await runQueryCommand(
      resolution,
      run,
      instance,
      runFlags.timeoutMs,
      rest[0] ?? "",
    );
  } catch (error) {
    fail(errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/cli/k-wiki.ts` runs */
refuseDirectExecution(import.meta.url, "k-wiki");
