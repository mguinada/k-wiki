import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule, refuseTestWorker } from "../src/cli/is-main.ts";
import { checkWikiFidelity, summarizeFidelity } from "../src/wiki/fidelity.ts";
import { printBackfillWarning } from "./check-provenance.ts";

/**
 * Citation-fidelity checker CLI (issue #125): the deterministic tier of
 * the fidelity stack. Every machine-checkable token a `type: source`
 * page quotes — tilde paths, dotted config keys, CLI flags, `npm run`
 * commands — must appear in the page's `origin` file, and every
 * non-structural page's `title` must kebab-case to its file name. The
 * core lives in src/wiki/fidelity.ts (the wiki-sync verification stage
 * runs it every cycle, issue #138); this script renders its report.
 * Prints one `wiki/<page> -> …` line per problem and exits 1; exits 0
 * when the wiki is faithful. Relational misquotes (right tokens, wrong
 * containment) stay with the lint prompt (tier 2) and §19 review.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Colors at the render boundary: green = ok, yellow = warning, red =
 *  problem/error; NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-fidelity [-h | --help] [<wiki-dir> [<raw-dir>]]

Check citation fidelity (issue #125): every machine-checkable token a
\`type: source\` page quotes in its body — tilde paths (\`~/…\`),
dotted config keys (\`push.pushOption\` style, file names excluded),
long and short CLI flags, and \`npm run\` commands — appears in the
page's \`origin\` file under the raw projection, and every page's
\`title\` kebab-cases to its file name (\`index\`, \`overview\`, and
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
export async function main(): Promise<void> {
  refuseTestWorker("check-fidelity");

  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  if (args.length > 2) {
    console.error(
      colors().red("check-fidelity: expected at most two arguments"),
    );
    process.exitCode = 1;

    return;
  }

  const wikiDir = args[0] ?? join(repoRoot, "wiki");
  const rawDir = args[1] ?? join(dirname(wikiDir), "raw");

  try {
    const report = await checkWikiFidelity(wikiDir, rawDir);

    if (report.problems.length === 0) {
      console.log(colors().green(`ok: ${summarizeFidelity(report)}`));

      if (report.skipped > 0) {
        printBackfillWarning(report.skipped, wikiDir, rawDir);
      }

      return;
    }

    for (const line of report.problems) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(
      colors().red(
        `check-fidelity: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under `node scripts/check-fidelity.ts` */
if (isMainModule(import.meta.url)) {
  await main();
}
