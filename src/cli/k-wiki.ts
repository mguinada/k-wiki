import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "../cli/colors.ts";
import { checkRaw } from "../health/check-raw.ts";
import { createAgentProgressSink } from "../ingest/agent-run.ts";
import {
  canAnimate,
  QUERY_HEARTBEAT_PREFIX,
  runWikiQuery,
  terminalColors,
} from "../query/wiki-query.ts";
import {
  expandHome,
  isPlainObject,
  loadSyncConfig,
  resolveRawDir,
} from "../sync/config.ts";
import { listWikiPages, readPageFields } from "../wiki/pages.ts";
import { cliFail } from "./colors.ts";
import { timeoutArgError } from "./flag-args.ts";
import { refuseDirectExecution } from "./is-main.ts";

/**
 * k-wiki: the agent-facing query entry point (guide §16, issue #76).
 * `k-wiki query "<question>"` asks the wiki bound to the current
 * project from any cwd — zero flags when a `.k-wiki.json` binding
 * exists — and delegates to the answer-only `runWikiQuery`. There is
 * no filing passthrough: filing stays the human-run
 * `wiki-query --file-last` inside the checkout (issue #72's two-stage
 * design). One command, `util.parseArgs`, no framework (§27).
 */

/** The per-project binding file name, at the bound project's root. */
export const BINDING_FILE = ".k-wiki.json";

/** Environment variable naming a checkout without a binding file. */
export const CHECKOUT_ENV = "K_WIKI_CHECKOUT";

/** The wiki page types (guide §9), listed in index.md order (guide §11). */
const PAGE_TYPES = [
  "concept",
  "entity",
  "source",
  "query",
  "comparison",
] as const;

/** Navigation pages: listed by neither `list` nor typed, readable by name. */
const NAV_PAGES = new Set(["index.md", "log.md", "overview.md"]);

/** The type/command vocabularies widened to strings for membership
 *  checks on runtime input (cast the receiver, never the argument). */
const PAGE_TYPE_NAMES = PAGE_TYPES as readonly string[];

/** Human phrase for each checkout resolution origin. */
const ORIGIN_LABELS = {
  flag: "the --checkout flag",
  env: `the ${CHECKOUT_ENV} environment variable`,
  file: ".k-wiki.json",
  cwd: "the cwd itself",
} as const;

/** The k-wiki command vocabulary (drift-guarded against the
 *  k-wiki skill by tests/k-wiki-skill.test.ts). */
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
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

    if (await isFile(candidate)) {
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
bound. One command set — util.parseArgs, no CLI framework. None of
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
  paths: { readonly rawDir: string; readonly wikiDir: string },
): Promise<void> {
  const dataRoot = dirname(paths.rawDir);

  console.log(
    [
      `checkout:  ${resolution.checkout} (from ${ORIGIN_LABELS[resolution.origin]})`,
      `settings:  ${join(resolution.checkout, resolution.settings ?? "settings.yml")}`,
      `data repo: ${dataRoot}`,
      `wiki:      ${paths.wikiDir}`,
      `index:     ${join(paths.wikiDir, "index.md")}`,
    ].join("\n"),
  );
}

/** One listed page: its slug and frontmatter fields. */
interface ListedPage {
  readonly path: string;
  readonly slug: string;
  readonly type: string | undefined;
  readonly title: string | undefined;
}

/** Collect the listable pages: every page except the navigation trio. */
async function listablePages(wikiDir: string): Promise<ListedPage[]> {
  const pages: ListedPage[] = [];

  for (const path of await listWikiPages(wikiDir)) {
    if (NAV_PAGES.has(basename(path))) {
      continue;
    }

    const fields = await readPageFields(join(wikiDir, path));

    pages.push({
      path,
      slug: basename(path, ".md"),
      type: fields.type,
      title: fields.title,
    });
  }

  return pages;
}

const PLURAL: Record<string, string> = {
  concept: "concepts",
  entity: "entities",
  source: "sources",
  query: "queries",
  comparison: "comparisons",
};

/** One 'slug — title' line per page of one type filter. */
function filteredLines(
  pages: readonly ListedPage[],
  typeFilter: string,
): string[] {
  return pages
    .filter((page) => page.type === typeFilter)
    .map((page) => `${page.slug} — ${page.title ?? page.slug}`);
}

/** Group the pages by frontmatter type; pages without one go to "untyped". */
function groupPages(pages: readonly ListedPage[]): Map<string, ListedPage[]> {
  const groups = new Map<string, ListedPage[]>();

  for (const page of pages) {
    const key = page.type ?? "untyped";
    const bucket = groups.get(key);

    if (bucket === undefined) {
      groups.set(key, [page]);
    } else {
      bucket.push(page);
    }
  }

  return groups;
}

/** Section order: known types in index.md order, then unknown types
 *  sorted, then untyped last. */
function sectionOrder(groups: ReadonlyMap<string, ListedPage[]>) {
  return [
    ...PAGE_TYPES.filter((type) => groups.has(type)).map((type) => ({
      key: type,
      header: PLURAL[type],
    })),
    ...[...groups.keys()]
      .filter((key) => !PAGE_TYPE_NAMES.includes(key) && key !== "untyped")
      .sort()
      .map((key) => ({ key, header: `${key}s` })),
    ...(groups.has("untyped") ? [{ key: "untyped", header: "untyped" }] : []),
  ];
}

/** Render the grouped listing: a '## header' line per section and one
 *  'slug — title' line per page under it. */
function groupedLines(groups: ReadonlyMap<string, ListedPage[]>): string[] {
  const lines: string[] = [];

  for (const section of sectionOrder(groups)) {
    lines.push(`## ${section.header}`);

    for (const page of groups.get(section.key) ?? []) {
      lines.push(`${page.slug} — ${page.title ?? page.slug}`);
    }
  }

  return lines;
}

/** Print the structured wiki listing, grouped (or filtered) by type. */
async function runList(
  wikiDir: string,
  typeFilter: string | undefined,
): Promise<void> {
  if (typeFilter !== undefined && !PAGE_TYPE_NAMES.includes(typeFilter)) {
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
  const pages = await listWikiPages(wikiDir);
  const matches = pages.filter((path) => basename(path) === `${slug}.md`);

  if (matches.length === 0) {
    const lower = slug.toLowerCase();
    const near = pages
      .map((path) => basename(path, ".md"))
      .filter(
        (name) =>
          name.toLowerCase().includes(lower) ||
          lower.includes(name.toLowerCase()),
      );

    fail(
      near.length === 0
        ? `no page named ${JSON.stringify(slug)}`
        : `no page named ${JSON.stringify(slug)}; near matches: ${near.join(", ")}`,
    );

    return;
  }

  if (matches.length > 1) {
    fail(`ambiguous page name ${JSON.stringify(slug)}: ${matches.join(", ")}`);

    return;
  }

  process.stdout.write(await readFile(join(wikiDir, matches[0] ?? ""), "utf8"));
}

/** Check the bound projection (delegates to check-raw, read-only). */
async function runHealth(rawDir: string, failOnStale: boolean): Promise<void> {
  const colors = terminalColors(process.env);
  const report = await checkRaw(rawDir);

  for (const warning of report.warnings) {
    console.error(colors.yellow(`k-wiki: ${warning}`));
  }

  if (report.healthy) {
    console.log(colors.green(report.summary));
  } else {
    for (const line of report.problems) {
      console.error(colors.red(line));
    }

    process.exitCode = 1;
  }

  if (failOnStale && report.stale) {
    process.exitCode = 1;
  }
}

/** The argv shape main consumes after util.parseArgs. */
interface CliArguments {
  readonly values: {
    checkout?: string;
    timeout?: string;
    "fail-on-stale"?: boolean;
  };
  readonly positionals: string[];
}

/** Parse argv; undefined (already failed) when the syntax is invalid. */
function parseCliArguments(args: string[]): CliArguments | undefined {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        checkout: { type: "string" },
        timeout: { type: "string" },
        "fail-on-stale": { type: "boolean" },
      },
    });
  } catch (error) {
    fail(errorMessage(error));

    return undefined;
  }
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

/** The bound data repo's raw and wiki dirs, from the checkout's sync.json. */
async function checkoutPaths(
  resolution: CheckoutResolution,
  home: string,
): Promise<{ readonly rawDir: string; readonly wikiDir: string }> {
  const config = await loadSyncConfig(
    join(resolution.checkout, "sync.json"),
    home,
  );
  const rawDir = resolveRawDir(config.dataRoot, resolution.checkout);

  return { rawDir, wikiDir: join(dirname(rawDir), "wiki") };
}

/** Run status, list, read, or health; true when one of them ran. */
async function runReadOnlyCommand(
  command: string | undefined,
  rest: readonly string[],
  resolution: CheckoutResolution,
  paths: { readonly rawDir: string; readonly wikiDir: string },
  failOnStale: boolean,
): Promise<boolean> {
  if (command === "status") {
    await runStatus(resolution, paths);

    return true;
  }

  if (command === "list") {
    await runList(paths.wikiDir, rest[0]);

    return true;
  }

  if (command === "read") {
    await runRead(paths.wikiDir, rest[0] ?? "");

    return true;
  }

  if (command === "health") {
    await runHealth(paths.rawDir, failOnStale);

    return true;
  }

  return false;
}

/** Run the one LLM command: query — the answer plus the filing hint. */
async function runQueryCommand(
  resolution: CheckoutResolution,
  paths: { readonly rawDir: string; readonly wikiDir: string },
  timeoutArg: string | undefined,
  rest: readonly string[],
): Promise<void> {
  const colors = terminalColors(process.env);
  const animated = canAnimate(process.stderr.isTTY === true, process.env);
  const sink = createAgentProgressSink(
    (text) => process.stderr.write(text),
    (text) => console.error(text),
    animated,
    colors,
    QUERY_HEARTBEAT_PREFIX,
  );

  try {
    const result = await runWikiQuery({
      settingsPath: join(
        resolution.checkout,
        resolution.settings ?? "settings.yml",
      ),
      rawDir: paths.rawDir,
      promptsDir: join(resolution.checkout, "prompts"),
      outputsDir: join(resolution.checkout, "outputs"),
      question: rest[0] ?? "",
      timeoutMs:
        timeoutArg === undefined ? undefined : Number(timeoutArg) * 1000,
      heartbeatMs: animated ? 100 : undefined,
      onProgress: sink.render,
    });

    sink.end();

    console.log(result.answer);
    console.error();
    console.error(
      colors.dim(
        "To file this answer (human step): wiki-query --file-last, run inside the checkout",
      ),
    );
  } catch (error) {
    sink.end();
    console.error(colors.red(`k-wiki: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/** k-wiki entry point: `k-wiki [-h | --help] | k-wiki <command> [<args>]` — query, status, list, read, health. */
export async function main(cwd: string = process.cwd()): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const cli = parseCliArguments(args);

  if (cli === undefined) {
    return;
  }

  const timeout = cli.values.timeout;
  const timeoutError =
    timeout === undefined ? undefined : timeoutArgError(timeout);

  if (timeoutError !== undefined) {
    fail(timeoutError);

    return;
  }

  const rest = cli.positionals.slice(1);
  const usageError = commandUsageError(cli.positionals[0], rest);

  if (usageError !== undefined) {
    fail(usageError);

    return;
  }

  const home = homedir();
  const resolution = await resolveCheckoutOrFail({
    flag: cli.values.checkout,
    env: process.env,
    cwd,
    home,
  });

  if (resolution === undefined) {
    return;
  }

  try {
    const paths = await checkoutPaths(resolution, home);
    const handled = await runReadOnlyCommand(
      cli.positionals[0],
      rest,
      resolution,
      paths,
      cli.values["fail-on-stale"] === true,
    );

    if (handled) {
      return;
    }

    await runQueryCommand(resolution, paths, cli.values.timeout, rest);
  } catch (error) {
    fail(errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/cli/k-wiki.ts` runs */
refuseDirectExecution(import.meta.url, "k-wiki");
