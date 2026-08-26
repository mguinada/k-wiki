import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createAgentProgressSink } from "../ingest/wiki-ingest.ts";
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

/** One parsed binding: exactly one wiki (issue #76's 1:1 rule). */
export interface KWikiBinding {
  /** k-wiki checkout path, `~` already expanded. */
  readonly checkout: string;
  /** Non-default settings file inside the checkout, when set. */
  readonly settings: string | undefined;
}

const BINDING_SHAPE =
  'a single JSON object: { "checkout": "<k-wiki checkout>", "settings": "<optional settings file>" }';

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

  for (const key of Object.keys(parsed)) {
    if (key !== "checkout" && key !== "settings") {
      throw new Error(
        `invalid binding at ${source}: unknown key ${JSON.stringify(key)}; expected ${BINDING_SHAPE}`,
      );
    }
  }

  const checkout = parsed.checkout;

  if (typeof checkout !== "string" || checkout.length === 0) {
    throw new Error(
      `invalid binding at ${source}: "checkout" must be a non-empty string`,
    );
  }

  const settings = parsed.settings;

  if (
    settings !== undefined &&
    (typeof settings !== "string" || settings.length === 0)
  ) {
    throw new Error(
      `invalid binding at ${source}: "settings" must be a non-empty string`,
    );
  }

  return { checkout: expandHome(checkout, home), settings };
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
const HELP = `Usage: k-wiki [-h | --help] | k-wiki query [--checkout <path>] [--timeout <secs>] <question>

The agent-facing query entry point (guide §16, issue #76): ask the
wiki bound to the current project from any cwd, with zero flags
once the project is bound. One command — util.parseArgs, no CLI
framework. \`k-wiki query "<question>"\` prints the answer and saves
the run for human review; it can never write to the wiki.

Binding file .k-wiki.json (at the bound project's root):
  { "checkout": "~/k-wiki", "settings": "settings-meta.yml" }
  checkout — a k-wiki checkout whose sync.json resolves the data
    repo; its prompts/, outputs/, and settings live there too.
  settings — optional non-default settings file inside the checkout
    (e.g. settings-meta.yml, the meta-wiki instance of issue #74);
    default settings.yml. Exactly one wiki per binding: the file
    must be a single JSON object; lists and multi-wiki forms are
    rejected — one project binds exactly one wiki, so no ambient
    path exists between work and personal knowledge.
  Gitignore the file in personal projects; commit it in team
    projects.

Checkout resolution order (first hit wins):
  1. --checkout <path>   this run's checkout (a ~ path is expanded)
  2. K_WIKI_CHECKOUT     environment variable naming a checkout
  3. .k-wiki.json        nearest binding found walking up from the
                         cwd, stopping at the home directory or the
                         filesystem root
  4. the cwd itself      today's behavior preserved: run from inside
                         the k-wiki checkout

Switches and arguments:
  --checkout <path>  k-wiki checkout to resolve the query through
                     (see the resolution order above).
  --timeout <secs>   Kill the agent run after this many seconds and
                     fail it. Default: 1800 (30 minutes).
  -h, --help         Print this help and exit; no side effects.
  query              The only command: ask the bound wiki one
                     question. Filing has no passthrough here.
  <question>         The question, quoted (one positional argument).

What it writes: the answer prints to stdout, and the run (question,
answer, pages cited, timestamp) is saved to
<checkout>/outputs/last-query.md for human review. It never writes
wiki/ — answer-only by construction (issue #72): the wrapper
captures the data repo's pre-run git state, and any change under
wiki/ during the run reverts the data repo and fails the run.
Filing the saved answer is the human-run wiki-query --file-last
inside the checkout. A wrong pairing (a binding whose checkout
resolves an unexpected data repo) fails loudly via the existing
guardrails. Errors print red, prefixed "k-wiki:", and exit 1.
Progress goes to stderr (an animated status line on a terminal,
one plain heartbeat line per 60 seconds otherwise); NO_COLOR is
honored. Human alias, optional:
alias k-wiki='node ~/k-wiki/bin/k-wiki.ts'`;

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  console.error(terminalColors(process.env).red(`k-wiki: ${message}`));
  process.exitCode = 1;
}

/** k-wiki entry point: `k-wiki [-h | --help] | k-wiki query [--checkout <path>] [--timeout <secs>] <question>`. */
export async function main(cwd: string = process.cwd()): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  let parsed: {
    values: { checkout?: string; timeout?: string };
    positionals: string[];
  };

  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        checkout: { type: "string" },
        timeout: { type: "string" },
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));

    return;
  }

  const timeoutArg = parsed.values.timeout;

  if (timeoutArg !== undefined && !/^[1-9][0-9]*$/.test(timeoutArg)) {
    fail("--timeout needs a positive integer number of seconds");

    return;
  }

  const command = parsed.positionals[0];

  if (command === undefined) {
    fail('a command is required: k-wiki query "<question>"');

    return;
  }

  if (command !== "query") {
    fail(
      `unknown command ${JSON.stringify(command)}; the only command is: k-wiki query "<question>"`,
    );

    return;
  }

  if (parsed.positionals.length > 2) {
    fail(
      `expected exactly one <question> argument, got ${parsed.positionals.length - 1}`,
    );

    return;
  }

  const question = parsed.positionals[1] ?? "";

  if (question.trim() === "") {
    fail('a question is required: k-wiki query "<question>"');

    return;
  }

  const home = homedir();

  let resolution: CheckoutResolution;

  try {
    resolution = await resolveCheckout({
      flag: parsed.values.checkout,
      env: process.env,
      cwd,
      home,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));

    return;
  }

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
    const config = await loadSyncConfig(
      join(resolution.checkout, "sync.json"),
      home,
    );
    const rawDir = resolveRawDir(config.dataRoot, resolution.checkout);
    const result = await runWikiQuery({
      settingsPath: join(
        resolution.checkout,
        resolution.settings ?? "settings.yml",
      ),
      rawDir,
      promptsDir: join(resolution.checkout, "prompts"),
      outputsDir: join(resolution.checkout, "outputs"),
      question,
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
    console.error(
      colors.red(
        `k-wiki: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/cli/k-wiki.ts` runs */
refuseDirectExecution(import.meta.url, "k-wiki");
