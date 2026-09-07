/**
 * k-wiki: the universal front door (issue #337, the #289 dispatcher).
 * One executable serves two doors over one library — the verb table
 * (verb-table.ts) dispatches by import to the same main()s the
 * `bin/` and `bin/libexec/` launchers shim, never a spawned process.
 * The door is the resolution context, not the entry name (decision
 * 1): a checkout resolved by the `--checkout` flag, the
 * `K_WIKI_CHECKOUT` env var, or a `.k-wiki.json` binding is the
 * agent door (read verbs only; operator verbs refused loudly with
 * both escapes named); the cwd itself is the human door (full
 * table, structural default instance). Flag position is verb-first
 * canonical: leading global flags (`-w`/`--wiki`, `-h`/`--help`)
 * only may lead the verb and are reordered after it — a
 * reordering, not a second parser (git's `-C <path> log` model); a
 * verb-specific flag before the verb is a usage error. Every run
 * prints its resolved door and instance as dim stderr lines
 * (decision 16) so wrong-door and wrong-corpus calls stay visible
 * in the transcript. The read verbs live in agent-verbs.ts; the
 * binding-file schema and checkout resolution in
 * k-wiki-binding.ts.
 */

import { homedir } from "node:os";
import { ORIGIN_LABELS, runAgentVerbs } from "./agent-verbs.ts";
import { errorMessage, terminalColors } from "./colors.ts";
import { refuseDirectExecution } from "./is-main.ts";
import {
  type CheckoutOrigin,
  type CheckoutResolution,
  resolveCheckout,
} from "./k-wiki-binding.ts";
import { HELP, PORCELAIN_VERBS, VERBS, type VerbSpec } from "./verb-table.ts";

/** The leading global flag tokens (the reordering set). */
const HELP_FLAGS = new Set(["-h", "--help"]);
const WIKI_FLAGS = new Set(["-w", "--wiki"]);
const CHECKOUT_TOKENS = new Set(["--checkout"]);

/** Print one usage error red on stderr and set the exit code. */
function fail(message: string): void {
  console.error(terminalColors().red(`k-wiki: ${message}`));

  process.exitCode = 1;
}

/** Split the leading global flags (-h/--help, -w/--wiki with its
 *  value, --wiki=<name>) off the head of argv — the reordering set
 *  for the verb-first canonical form. The lead array's length is
 *  the token count consumed. */
function splitLeadingGlobals(argv: readonly string[]): {
  readonly lead: string[];
  readonly helpAsked: boolean;
} {
  const lead: string[] = [];
  let helpAsked = false;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";

    if (HELP_FLAGS.has(token)) {
      lead.push(token);
      helpAsked = true;
      index += 1;
    } else if (WIKI_FLAGS.has(token)) {
      lead.push(token);

      const value = argv[index + 1];

      if (value !== undefined) {
        lead.push(value);
      }

      index += 2;
    } else if (token.startsWith("--wiki=")) {
      lead.push(token);
      index += 1;
    } else {
      break;
    }
  }

  return { lead, helpAsked };
}

/** The door an invocation runs on: the resolution chain resolving a
 *  binding (flag, env, file) is the agent door; the cwd fallback is
 *  the human door (decision 1). */
function doorFor(origin: CheckoutOrigin): "human" | "agent" {
  return origin === "cwd" ? "human" : "agent";
}

/** The value of one flag among a verb's args: the two-token form
 *  (`--checkout <path>`, `-w <name>`) or the inline long form
 *  (`--flag=value`). Scans left to right, stops at a bare `--`,
 *  matches whole tokens only — a positional containing the flag
 *  text never matches, and a repeated occurrence overrides — the
 *  parseArgs rule (a repeated flag's last value wins), so every
 *  flag the dispatcher reads names the value the run resolves.
 *  Undefined when absent. */
function lastFlagValueFrom(
  args: readonly string[],
  tokens: ReadonlySet<string>,
  inlinePrefix: string,
): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      return value;
    }

    if (tokens.has(arg)) {
      value = args[index + 1];
    } else if (arg.startsWith(inlinePrefix)) {
      value = arg.slice(inlinePrefix.length);
    }
  }

  return value;
}

/** The wiki instance name the dispatcher resolved for the dim line
 *  (decision 16): the explicit -w/--wiki flag — last occurrence
 *  wins, as in the verb's own parse, wherever it stood before the
 *  reordering — beats the binding's wiki key; absent both, the
 *  structural default. */
function resolvedInstanceName(
  verb: VerbSpec,
  verbArgs: readonly string[],
  resolution: CheckoutResolution,
): string {
  const fromFlag = verb.wiki
    ? lastFlagValueFrom(verbArgs, WIKI_FLAGS, "--wiki=")
    : undefined;

  return fromFlag ?? resolution.wiki ?? "default";
}

/** Print the resolved door and instance as dim stderr lines — the
 *  transcript's wrong-door and wrong-corpus evidence. */
function printDoorLines(
  verb: VerbSpec,
  resolution: CheckoutResolution,
  verbArgs: readonly string[],
): void {
  const dim = terminalColors().dim;

  console.error(
    dim(
      `door: ${doorFor(resolution.origin)} (from ${ORIGIN_LABELS[resolution.origin]})`,
    ),
  );
  console.error(
    dim(`instance: ${resolvedInstanceName(verb, verbArgs, resolution)}`),
  );
}

/** The loud absence (decision 15): an operator verb on the agent
 *  door is not forwarded — the error names the door and both
 *  escapes (cd into the checkout; the standalone launcher). */
function operatorRefusal(verb: VerbSpec, checkout: string): string {
  const launcher =
    verb.tier === "libexec" ? `bin/libexec/${verb.name}` : `bin/${verb.name}`;

  return `the verb ${verb.name} is an operator verb and is not available on the agent door (a binding resolved this run) — run it from inside the checkout (cd ${checkout}), or use the standalone launcher: ${launcher}`;
}

/** The verb spec for a name, undefined when unknown. */
function verbSpec(name: string): VerbSpec | undefined {
  return VERBS.find((verb) => verb.name === name);
}

/** One resolved invocation: the verb, the argv it runs with (the
 *  verb replaced by the reordered leading globals), and the argv
 *  that followed the verb. */
interface Invocation {
  readonly verb: VerbSpec;
  readonly verbArgs: readonly string[];
  readonly tail: readonly string[];
}

/** Resolve the front-door argv into the invocation to run; a help
 *  or usage outcome prints and returns undefined. */
function resolveInvocation(argv: readonly string[]): Invocation | undefined {
  const { lead, helpAsked } = splitLeadingGlobals(argv);
  const rest = argv.slice(lead.length);
  const verbName = rest[0];

  if (helpAsked || verbName === undefined) {
    console.log(HELP);

    return undefined;
  }

  if (verbName.startsWith("-")) {
    fail(
      `unexpected ${JSON.stringify(verbName)} before the verb — verb flags come after the verb; only -w/--wiki and -h/--help may lead`,
    );

    return undefined;
  }

  const verb = verbSpec(verbName);

  if (verb === undefined) {
    fail(
      `unknown verb ${JSON.stringify(verbName)}; the daily verbs are: ${PORCELAIN_VERBS.join(", ")} — k-wiki --help lists every tier`,
    );

    return undefined;
  }

  const tail = rest.slice(1);

  if (
    verb.klass === "read" &&
    (tail.includes("-h") || tail.includes("--help"))
  ) {
    console.log(HELP);

    return undefined;
  }

  return {
    verb,
    verbArgs: [...lead, ...tail],
    tail,
  };
}

/** Resolve the checkout; undefined (already failed) when it throws. */
async function resolveCheckoutOrFail(input: {
  readonly flag: string | undefined;
  readonly cwd: string;
  readonly home: string;
}): Promise<CheckoutResolution | undefined> {
  try {
    return await resolveCheckout({ ...input, env: process.env });
  } catch (error) {
    fail(errorMessage(error));

    return undefined;
  }
}

/** Run the resolved invocation: classify the door, refuse operator
 *  verbs on the agent door, print the dim door lines, and dispatch
 *  — read verbs through the agent-verb runner, operator verbs
 *  through their launcher-shimmed main with the remaining argv
 *  verbatim. */
async function runInvocation(
  invocation: Invocation,
  input: { readonly cwd: string; readonly home: string },
): Promise<void> {
  const { verb } = invocation;

  if (
    verb.klass === "write-note" &&
    (invocation.tail.includes("-h") || invocation.tail.includes("--help"))
  ) {
    await verb.main?.(invocation.verbArgs);

    return;
  }

  const flag =
    verb.klass !== "operator"
      ? lastFlagValueFrom(invocation.tail, CHECKOUT_TOKENS, "--checkout=")
      : undefined;
  const resolution = await resolveCheckoutOrFail({
    flag,
    cwd: input.cwd,
    home: input.home,
  });

  if (resolution === undefined) {
    return;
  }

  if (doorFor(resolution.origin) === "agent" && verb.klass === "operator") {
    fail(operatorRefusal(verb, resolution.checkout));

    return;
  }

  printDoorLines(verb, resolution, invocation.verbArgs);

  if (verb.klass === "read") {
    await runAgentVerbs(verb.name, invocation.verbArgs, {
      resolution,
      home: input.home,
    });

    return;
  }

  await verb.main?.(invocation.verbArgs);
}

/** The dispatch loop: reorder leading globals, resolve the verb,
 *  classify the door, print the dim door lines, and run it. */
async function dispatch(
  argv: readonly string[],
  input: { readonly cwd: string; readonly home: string },
): Promise<void> {
  const invocation = resolveInvocation(argv);

  if (invocation === undefined) {
    return;
  }

  await runInvocation(invocation, input);
}

/** k-wiki entry point: `k-wiki [-h | --help] | k-wiki <verb> [<args>]` — the universal front door over both doors' verb tables. */
export async function main(cwd: string = process.cwd()): Promise<void> {
  await dispatch(process.argv.slice(2), { cwd, home: homedir() });
}

/* v8 ignore next: covered only under direct `node src/cli/k-wiki.ts` runs */
refuseDirectExecution(import.meta.url, "k-wiki");
