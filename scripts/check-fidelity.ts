import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { checkWikiFidelity, summarizeFidelity } from "../src/wiki/fidelity.ts";
import { runChecker } from "./check-provenance.ts";

/**
 * Citation-fidelity checker CLI (issue #125): the deterministic tier of
 * the fidelity stack. Every machine-checkable token a `type: source`
 * page quotes — tilde paths, dotted config keys, CLI flags, `npm run`
 * commands — must appear in the page's `origin` file, and every
 * non-structural page's `title` must slug to its file name under
 * the shared page-slug rule (the filing cap, the uncapped kebab
 * for longer names, either minus query filing's `-2` … `-999`
 * collision counter — see src/wiki/fidelity.ts, issue #383). The
 * core lives in src/wiki/fidelity.ts (the
 * wiki-sync verification stage runs it every cycle, issue #138);
 * this script renders its report.
 * Prints one `wiki/<page> -> …` line per problem and exits 1; exits 0
 * when the wiki is faithful. Relational misquotes (right tokens, wrong
 * containment) stay with the lint prompt (tier 2) and §19 review.
 */

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-fidelity [-h | --help] [<wiki-dir> [<raw-dir>]]

Check citation fidelity: every machine-checkable token a
\`type: source\` page quotes in its body — tilde paths (\`~/…\`),
dotted config keys (\`push.pushOption\` style, file names excluded),
long and short CLI flags, and \`npm run\` commands — appears in the
page's \`origin\` file under the raw projection, and every page's
\`title\` matches its file name under the shared page-slug rule —
kebab-case capped at the 80-character file-name budget, or the
uncapped kebab, with query filing's collision counter (\`-2\` …
\`-999\`) accepted between rule and stem, the counter itself
un-verified (\`index\`, \`overview\`, and
\`log\` are exempt; their file names are mandated by the wiki
contract). Relational misquotes (right tokens, wrong containment)
are not detectable here — the lint prompt and diff review own them.

  <wiki-dir>    Wiki root to scan. Default: the repo's own wiki/.
  <raw-dir>     Raw projection to read origins from. Default: the
                sibling \`raw/\` of the wiki directory.
  -h, --help    Print this help and exit; no side effects.

Writes nothing. Prints one \`wiki/<page> -> …\` line per problem (red)
to stderr and exits 1; prints an ok summary (green) and exits 0 when
the wiki is faithful (an empty wiki is ok). Source pages whose origin
file is missing skip quote checking (check-provenance reports that).
When \`type: source\` pages lack \`origin\`, a yellow warning block
below the ok summary names the exact backfill-origin commands to run,
dry run first — a signal, not a gate; the exit code stays 0. NO_COLOR
disables color.`;

/** check-fidelity entry point: `check-fidelity [-h | --help] [<wiki-dir> [<raw-dir>]]` (defaults: repo wiki/, sibling raw/). */
export function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  return runChecker({
    name: "check-fidelity",
    help: HELP,
    check: checkWikiFidelity,
    summarize: summarizeFidelity,
    warnCount: (report) => report.skipped,
    argv: args,
  });
}

/* v8 ignore next: covered only under direct `node scripts/check-fidelity.ts` runs */
refuseDirectExecution(import.meta.url, "check-fidelity", "bin/libexec");
