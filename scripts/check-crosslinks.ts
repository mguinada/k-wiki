import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { checkCrossWikiLinks } from "../src/wiki/crosslinks.ts";

/**
 * Cross-wiki link checker CLI (issue #81): validates the one-way link
 * discipline between a wiki and its domain wikis — the audit core
 * lives in `src/wiki/crosslinks.ts` (the wiki-sync cycle stage runs
 * it too, issue #96).
 *
 * Prints one `file:line -> [[link]]` line per problem and exits 1;
 * exits 0 when the discipline holds.
 */

export { checkCrossWikiLinks } from "../src/wiki/crosslinks.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-crosslinks [-h | --help] <wiki-dir> <domain-wiki-dir> [<domain-wiki-dir>...]

Check the one-way cross-wiki link discipline between a wiki and its
domain wikis: every [[<vault>/<page>]] link in <wiki-dir>
must name a vault of a passed domain wiki — validated
case-insensitively against each domain repo's raw/manifest.json — and
resolve to an existing page of that wiki. The domain wikis themselves
must contain no cross-wiki links: they are link sinks and never
reference second-brain material.

  <wiki-dir>         Wiki root to audit (a second brain). Required.
  <domain-wiki-dir>  A domain wiki's wiki/ dir, inside its data repo
                     (the sibling raw/manifest.json supplies the vault
                     name). One or more.
  -h, --help         Print this help and exit; no side effects.

Writes nothing. Prints one \`file:line -> [[link]]\` line per problem
(red) to stderr and exits 1; prints an ok summary (green) and exits 0
when the discipline holds. Internal [[wikilinks]] are check-links'
business; this tool only audits cross-wiki links. NO_COLOR disables
color.`;

/** check-crosslinks entry point: `check-crosslinks [-h | --help] <wiki-dir> <domain-wiki-dir> [<domain-wiki-dir>...]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  if (args.length < 2) {
    console.error(
      colors().red(
        `check-crosslinks: expected <wiki-dir> and at least one <domain-wiki-dir>, got ${args.length} argument${args.length === 1 ? "" : "s"}`,
      ),
    );
    process.exitCode = 1;

    return;
  }

  const [wikiDir, ...domainDirs] = args;

  try {
    const report = await checkCrossWikiLinks(wikiDir ?? "", ...domainDirs);

    if (report.problems.length === 0) {
      const links = `${report.external} cross-wiki ${report.external === 1 ? "link" : "links"}`;
      const pages = `${report.domainPages} domain ${report.domainPages === 1 ? "page" : "pages"}`;

      console.log(
        colors().green(
          `ok: ${links} ${report.external === 1 ? "resolves" : "resolve"} against ${pages}`,
        ),
      );

      return;
    }

    for (const line of report.problems) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(colors().red(`check-crosslinks: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/check-crosslinks.ts` runs */
refuseDirectExecution(import.meta.url, "check-crosslinks");
