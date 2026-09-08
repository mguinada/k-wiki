/**
 * The completion emitter (issue #352): `k-wiki completion [<shell>]`
 * — the front door's shell plumbing, not a wiki verb. Static and
 * wiki-independent by class: no checkout, instance, or door is
 * resolved (no dim door lines), nothing is read but the verb table
 * this CLI ships, and nothing is written anywhere — stdout only.
 * The output is byte-identical on every run, pinned by tests, so a
 * verb-table change that forgets the emitter fails CI. v1 emits zsh
 * only; the `<shell>` positional is the seam a future shell plugs
 * into (a second shell is a second emitter, not a framework).
 */

import { cliFail } from "./colors.ts";
import { parseArgs } from "./shell.ts";
import { tierSections, verbTable } from "./verb-table.ts";

/** The shells the emitter supports, in help order. */
const SUPPORTED_SHELLS: readonly string[] = ["zsh"];

/** The verb's own help (the dispatcher prints it for
 *  `k-wiki completion -h|--help`, both positions). */
export const HELP = `Usage: k-wiki completion [-h | --help] [<shell>]

Emit the shell completion function for the k-wiki front door.
Shell plumbing, not a wiki verb: no checkout, instance, or door is
resolved, nothing is read but the verb table this CLI ships, and
nothing is written anywhere — the script goes to stdout only, and
stderr stays silent on success. The output is static and
byte-identical on every run, so it can be redirected into a file
or sourced directly.

Arguments:
  <shell>    The shell to emit for. Default: zsh — the only
             supported shell today. Any other name is a usage
             error naming the supported shells, never a guess.

Options:
  -h, --help          This help; no side effects.

What it writes: the completion script to stdout, nothing else.
Try it now, zero setup:
  source <(k-wiki completion)
Keep it permanently:
  k-wiki completion zsh > ~/.zfunc/_k-wiki
  # ~/.zshrc — fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit
The script defines a zsh compdef function for k-wiki that completes
the verbs grouped by the bare-help tiers (daily, occasional
operator, maintenance) and the global flags (-w/--wiki, -h/--help,
--checkout <path>, which completes paths); verb arguments are not
completed statically. Exit 0 prints the script; exit 1 is a usage
error. NO_COLOR is honored (the script itself never uses color).`;

/** Escape text for a single-quoted zsh string (the only character a
 *  single-quoted shell string cannot hold is the quote itself). */
function zshQuote(text: string): string {
  return text.replaceAll("'", `'\\''`);
}

/** One tier's describe entries: `'name:first help line'` per verb,
 *  indented inside the tier's array literal. */
function tierEntries(tier: string): readonly string[] {
  return verbTable().filter((verb) => verb.tier === tier).map(
    (verb) => `    '${verb.name}:${zshQuote(verb.lines[0] ?? "")}'`,
  );
}

/** The tier arrays of the emitted function, one block per bare-help
 *  tier in tier order — the grouping the completion menu shows. */
function tierArrayBlocks(): readonly string[] {
  return tierSections().flatMap(({ tier }) => [
    `  _k_wiki_${tier}=(`,
    ...tierEntries(tier),
    "  )",
    "",
  ]);
}

/** The menu's _describe calls, one per tier in tier order. */
function describeCalls(): readonly string[] {
  return tierSections().map(
    ({ tier }) => `      _describe -t ${tier} '${tier} verb' _k_wiki_${tier}`,
  );
}

/** The static zsh completion script: a `#compdef k-wiki` header for
 *  the fpath/compinit install, the `_k-wiki` function (tier-grouped
 *  verbs at the first word, the global flags everywhere,
 *  `--checkout` completing paths), and a guarded trailing compdef
 *  so `source <(k-wiki completion)` registers with zero setup. */
export function zshCompletionScript(): string {
  return [
    "#compdef k-wiki",
    "# k-wiki zsh completion — emitted by `k-wiki completion` (static:",
    "# the verb table and the global flags; no wiki state is read at",
    "# completion time). Install it permanently:",
    "#   k-wiki completion zsh > ~/.zfunc/_k-wiki",
    "#   # ~/.zshrc — fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit",
    "# Or try it now, zero setup: source <(k-wiki completion)",
    "",
    "_k-wiki() {",
    "  local context state state_descr line",
    `  local -a ${tierSections().map(({ tier }) => `_k_wiki_${tier}`).join(" ")}`,
    "",
    ...tierArrayBlocks(),
    "  _arguments -S \\",
    "    '(-h --help)'{-h,--help}'[print help — the front door alone, or the verb after it]' \\",
    "    '(-w --wiki)'{-w,--wiki}'[select the wiki instance]:instance:' \\",
    "    '--checkout[k-wiki checkout for this run]:path:_files' \\",
    "    '1:verb:->verb' \\",
    "    '*: :'",
    "",
    "  case $state in",
    "    verb)",
    ...describeCalls(),
    "      ;;",
    "  esac",
    "}",
    "",
    "if (( $+functions[compdef] )); then",
    "  compdef _k-wiki k-wiki",
    "fi",
  ].join("\n");
}

/** The completion verb's runner (the verb-table dispatch target,
 *  like the read verbs' runAgentVerbs — no launcher of its own):
 *  parse, validate the shell, emit. */
export async function runCompletionVerb(
  args: readonly string[],
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const cli = parseArgs(args, {
    positionals: {
      max: 1,
      error: (arg) => `unexpected argument ${JSON.stringify(arg)}`,
    },
  });

  if (cli.error !== undefined) {
    cliFail("k-wiki", cli.error);

    return;
  }

  const shell = cli.positional[0] ?? "zsh";

  if (!SUPPORTED_SHELLS.includes(shell)) {
    cliFail(
      "k-wiki",
      `unsupported shell ${JSON.stringify(shell)} — the supported shells are: ${SUPPORTED_SHELLS.join(", ")}`,
    );

    return;
  }

  console.log(zshCompletionScript());
}
