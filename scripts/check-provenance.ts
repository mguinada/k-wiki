import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import {
  checkWikiProvenance,
  summarizeProvenance,
} from "../src/wiki/provenance.ts";

/**
 * Dead-provenance checker CLI (issue #65): every `sources` entry must
 * resolve to an existing page or raw file, and every source page's
 * `origin` must exist under `raw/`. The core lives in
 * src/wiki/provenance.ts (the wiki-sync verification stage runs it
 * every cycle, issue #138); this script renders its report. Prints one
 * `wiki/<page> -> …` line per problem and exits 1; exits 0 when the
 * wiki is coherent (an empty wiki is coherent).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The missing-origin warning (issue #92): a signal, not a gate — the
 *  exit code stays 0. Names the exact backfill commands with the paths
 *  as resolved for this run, dry run first (it prints every pairing
 *  and writes nothing). Shared with check-fidelity (issue #125). */
export function printBackfillWarning(
  missing: number,
  wikiDir: string,
  rawDir: string,
): void {
  const noun = missing === 1 ? "page lacks" : "pages lack";
  const date = new Date().toISOString().slice(0, 10);
  const targets = `"${wikiDir}" "${rawDir}"`;

  console.log(
    colors().yellow(
      `warning: ${missing} type: source ${noun} origin — run a backfill:`,
    ),
  );
  console.log(
    `  first preview:  npm run backfill-origin -- --dry-run --date ${date} ${targets}`,
  );
  console.log(
    `  then write:     npm run backfill-origin -- --date ${date} ${targets}`,
  );
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-provenance [-h | --help] [<wiki-dir> [<raw-dir>]]

Check that the wiki's frontmatter provenance is alive: every
\`sources\` entry resolves — a wikilink entry to an existing wiki
page, a path entry to an existing file under the raw projection — and
every source page's \`origin\` raw path exists under the raw directory.

  <wiki-dir>    Wiki root to scan. Default: the repo's own wiki/.
  <raw-dir>     Raw projection to check origins against. Default: the
                sibling \`raw/\` of the wiki directory.
  -h, --help    Print this help and exit; no side effects.

Writes nothing. Prints one \`wiki/<page> -> …\` line per problem (red)
to stderr and exits 1; prints an ok summary (green) and exits 0 when
the provenance is coherent (an empty wiki is ok). When \`type: source\`
pages lack \`origin\`, a yellow warning block below the ok summary
names the exact backfill-origin commands to run, dry run first — a
signal, not a gate; the exit code stays 0. NO_COLOR disables color.`;

/** The shared checker-CLI shape (check-provenance, check-fidelity,
 *  and any future checker): help, arity, wiki/raw defaults, and
 *  rendering are identical; the check, summary, and warning-count
 *  deltas parameterize it. Prints one red problem line each and
 *  exits 1; ok exits 0. */
export async function runChecker<
  T extends { problems: readonly string[] },
>(options: {
  readonly name: string;
  readonly help: string;
  readonly check: (wikiDir: string, rawDir: string) => Promise<T>;
  readonly summarize: (report: T) => string;
  readonly warnCount: (report: T) => number;
}): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(options.help);

    return;
  }

  if (args.length > 2) {
    console.error(
      colors().red(`${options.name}: expected at most two arguments`),
    );
    process.exitCode = 1;

    return;
  }

  const wikiDir = args[0] ?? join(repoRoot, "wiki");
  const rawDir = args[1] ?? join(dirname(wikiDir), "raw");

  try {
    const report = await options.check(wikiDir, rawDir);

    if (report.problems.length === 0) {
      console.log(colors().green(`ok: ${options.summarize(report)}`));

      const warnCount = options.warnCount(report);

      if (warnCount > 0) {
        printBackfillWarning(warnCount, wikiDir, rawDir);
      }

      return;
    }

    for (const line of report.problems) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(colors().red(`${options.name}: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/** check-provenance entry point: `check-provenance [-h | --help] [<wiki-dir> [<raw-dir>]]` (defaults: repo wiki/, sibling raw/). */
export function main(): Promise<void> {
  return runChecker({
    name: "check-provenance",
    help: HELP,
    check: checkWikiProvenance,
    summarize: summarizeProvenance,
    warnCount: (report) => report.missingOrigins,
  });
}

/* v8 ignore next: covered only under direct `node scripts/check-provenance.ts` runs */
refuseDirectExecution(import.meta.url, "check-provenance");
