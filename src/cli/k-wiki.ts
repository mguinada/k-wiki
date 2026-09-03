import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { checkRaw, printHealthReport } from "../health/check-raw.ts";
import { runQueryCli } from "../query/query-shell.ts";
import { expandHome, loadSyncConfig, resolveRawDir } from "../sync/config.ts";
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
import { type RunContext, runContext } from "./run-context.ts";
import { isPlainObject, statIfExists } from "./shared.ts";
import { agentRunFlags, parseArgs } from "./shell.ts";

/**
 * k-wiki: the agent-facing query entry point (guide §16, issue #76).
 * `k-wiki query "<question>"` asks the wiki bound to the current
 * project from any cwd — zero flags when a `.k-wiki.json` binding
 * exists — and delegates to the answer-only `runWikiQuery`. There is
 * no filing passthrough: filing stays the human-run
 * `wiki-query --file-last` inside the checkout (issue #72's two-stage
 * design). One command, the shared CLI shell, no framework (§27).
 */

/** The per-project binding file name, at the bound project's root. */
export const BINDING_FILE = ".k-wiki.json";

/** Environment variable naming a checkout without a binding file. */
export const CHECKOUT_ENV = "K_WIKI_CHECKOUT";

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

/** One parsed binding: exactly one wiki (issue #76's 1:1 rule). */
export interface KWikiBinding {
  /** k-wiki checkout path, `~` already expanded. */
  readonly checkout: string;
  /** Non-default settings file inside the checkout, when set. */
  readonly settings: string | undefined;
}

const BINDING_SHAPE =
  'a single JSON object: { "checkout": "<k-wiki checkout>", "settings": "<optional settings file>" }';

/** Reject any key beyond checkout and settings (the one-wiki shape). */
function rejectUnknownKeys(
  parsed: Record<string, unknown>,
  source: string,
): void {
  for (const key of Object.keys(parsed)) {
    if (key !== "checkout" && key !== "settings") {
      throw new Error(
        `invalid binding at ${source}: unknown key ${JSON.stringify(key)}; expected ${BINDING_SHAPE}`,
      );
    }
  }
}

/** Validate the optional settings field: absent, or a non-empty string. */
function parseSettingsField(
  settings: unknown,
  source: string,
): string | undefined {
  if (typeof settings === "string" && settings.length > 0) {
    return settings;
  }

  if (settings !== undefined) {
    throw new Error(
      `invalid binding at ${source}: "settings" must be a non-empty string`,
    );
  }

  return undefined;
}

/**
 * Parse and validate a binding file. The schema deliberately rejects
 * every list or multi-wiki form: one project binds exactly one wiki
 * (no ambient path between work and personal knowledge).
 */
export function parseBinding(
  text: string,
  source: string,
  home: string,
): KWikiBinding {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid binding at ${source}: not valid JSON`, { cause });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `invalid binding at ${source}: expected ${BINDING_SHAPE} — one project binds exactly one wiki; lists and multi-wiki forms are rejected`,
    );
  }

  rejectUnknownKeys(parsed, source);

  const checkout = parsed.checkout;

  if (typeof checkout !== "string" || checkout.length === 0) {
    throw new Error(
      `invalid binding at ${source}: "checkout" must be a non-empty string`,
    );
  }

  return {
    checkout: expandHome(checkout, home),
    settings: parseSettingsField(parsed.settings, source),
  };
}

/**
 * Find the nearest binding file walking up from `startDir`, stopping
 * at the home directory or the filesystem root (each checked last).
 * Undefined when no binding exists on the walk.
 */
export async function findBindingFile(
  startDir: string,
  home: string,
): Promise<string | undefined> {
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, BINDING_FILE);

    if ((await statIfExists(candidate))?.isFile() === true) {
      return candidate;
    }

    if (dir === home || dirname(dir) === dir) {
      return undefined;
    }

    dir = dirname(dir);
  }
}

/** Where the resolved checkout came from, for progress and errors. */
export type CheckoutOrigin = "flag" | "env" | "file" | "cwd";

export interface CheckoutResolution {
  /** The k-wiki checkout, `~` already expanded. */
  readonly checkout: string;
  /** Binding's non-default settings file, when the binding was used. */
  readonly settings: string | undefined;
  readonly origin: CheckoutOrigin;
}

/**
 * Resolve the k-wiki checkout (issue #76): explicit flag > env var >
 * binding file (cwd-upward walk) > the cwd itself — today's behavior
 * of running from inside the checkout, preserved.
 */
export async function resolveCheckout(input: {
  readonly flag: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
}): Promise<CheckoutResolution> {
  if (input.flag !== undefined) {
    return {
      checkout: expandHome(input.flag, input.home),
      settings: undefined,
      origin: "flag",
    };
  }

  const fromEnv = input.env[CHECKOUT_ENV];

  if (fromEnv !== undefined && fromEnv !== "") {
    return {
      checkout: expandHome(fromEnv, input.home),
      settings: undefined,
      origin: "env",
    };
  }

  const bindingPath = await findBindingFile(input.cwd, input.home);

  if (bindingPath === undefined) {
    return { checkout: input.cwd, settings: undefined, origin: "cwd" };
  }

  const binding = parseBinding(
    await readFile(bindingPath, "utf8"),
    bindingPath,
    input.home,
  );

  return {
    checkout: binding.checkout,
    settings: binding.settings,
    origin: "file",
  };
}

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
  { "checkout": "~/k-wiki", "settings": "settings-meta.yml" }
  checkout — a k-wiki checkout whose sync.json resolves the data
    repo; its prompts/, outputs/, and settings live there too.
  settings — optional non-default settings file inside the checkout
    (e.g. settings-meta.yml, the meta wiki's settings file);
    default settings.yml. Exactly one wiki per binding: the file
    must be a single JSON object; lists and multi-wiki forms are
    rejected — one project binds exactly one wiki, so no ambient
    path exists between work and personal knowledge.
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
                     settings file, data repo, wiki dir, index.md.
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
alias k-wiki='node ~/k-wiki/bin/k-wiki.ts'

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

/** Print the resolved binding: origin, checkout, paths (issue #76). */
async function runStatus(
  resolution: CheckoutResolution,
  run: RunContext,
): Promise<void> {
  console.log(
    [
      `checkout:  ${resolution.checkout} (from ${ORIGIN_LABELS[resolution.origin]})`,
      `settings:  ${join(resolution.checkout, resolution.settings ?? "settings.yml")}`,
      `data repo: ${run.dataRoot}`,
      `wiki:      ${run.wikiDir}`,
      `index:     ${join(run.wikiDir, "index.md")}`,
    ].join("\n"),
  );
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

/** The bound data repo's run context, from the checkout's sync.json:
 *  the boundary builds it once (issue #257) and every k-wiki command
 *  reads its paths from it. */
async function checkoutPaths(
  resolution: CheckoutResolution,
  home: string,
): Promise<RunContext> {
  const config = await loadSyncConfig(
    join(resolution.checkout, "sync.json"),
    home,
  );
  const rawDir = resolveRawDir(config.dataRoot, resolution.checkout);

  return runContext({ rawDir });
}

/** Run status, list, read, or health; true when one of them ran. */
async function runReadOnlyCommand(
  command: string | undefined,
  rest: readonly string[],
  resolution: CheckoutResolution,
  run: RunContext,
  failOnStale: boolean,
): Promise<boolean> {
  if (command === "status") {
    await runStatus(resolution, run);

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
 *  runWikiQuery mapping, answer + dim hint, failure rendering). */
async function runQueryCommand(
  resolution: CheckoutResolution,
  run: RunContext,
  timeoutMs: number | undefined,
  question: string,
): Promise<void> {
  await runQueryCli({
    prefix: "k-wiki",
    settingsPath: join(
      resolution.checkout,
      resolution.settings ?? "settings.yml",
    ),
    rawDir: run.rawDir,
    promptsDir: join(resolution.checkout, "prompts"),
    outputsDir: join(resolution.checkout, "outputs"),
    question,
    timeoutMs,
    hint: "To file this answer (human step): wiki-query --file-last, run inside the checkout",
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
    const run = await checkoutPaths(resolution, home);
    const handled = await runReadOnlyCommand(
      cli.positional[0],
      rest,
      resolution,
      run,
      cli.flags.has("--fail-on-stale"),
    );

    if (handled) {
      return;
    }

    await runQueryCommand(resolution, run, runFlags.timeoutMs, rest[0] ?? "");
  } catch (error) {
    fail(errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/cli/k-wiki.ts` runs */
refuseDirectExecution(import.meta.url, "k-wiki");
