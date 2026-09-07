import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { checkCitationWall } from "../src/sandbox/citations.ts";

/**
 * One-way citation wall checker (issue #339): the CLI surface of the
 * audit core in `src/sandbox/citations.ts` — the same check the
 * wiki-sync cycle runs as its standing lint (which additionally
 * reverts the offending pages). Prints one
 * `wiki/<path>[:<line>] -> <evidence> (<reason>)` line per violation
 * and exits 1; exits 0 when the wall holds.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-citations [-h | --help] [<wiki-dir>]

Check the one-way wall between the wiki and its sandbox namespace
(wiki/sandbox/): sandbox notes may read the main wiki, the main wiki
must never depend on sandbox notes. Forbidden, in both link
surfaces: main pages linking or embedding sandbox pages (embeds
count as links), sandbox pages linking sandbox peers, sources
entries touching a sandbox page in either direction, cross-wiki
[[<vault>/<page>]] links from sandbox pages, and the via: agent
stamp outside the sandbox. Link resolution itself is check-links'
business; this tool judges direction and placement only.

  <wiki-dir>    Wiki root to scan. Default: the repo's own wiki/.
  -h, --help    Print this help and exit; no side effects.

Writes nothing. Prints one \`wiki/<path> -> <evidence>\` line per
violation (red) to stderr and exits 1; prints an ok summary (green)
and exits 0 when the wall holds (a wiki without a sandbox namespace
is ok — only the stamp-placement rule can trip there). NO_COLOR
disables color.`;

/** check-citations entry point: `check-citations [-h | --help] [<wiki-dir>]` (default: repo wiki/). */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const wikiDir = args[0] ?? join(repoRoot, "wiki");

  try {
    const report = await checkCitationWall(wikiDir);

    if (report.problems.length === 0) {
      const pages = `${report.pages} ${report.pages === 1 ? "page" : "pages"}`;
      const sandbox =
        report.sandboxPages > 0
          ? ` (${report.sandboxPages} sandbox ${report.sandboxPages === 1 ? "note" : "notes"})`
          : "";

      console.log(
        colors().green(`ok: the one-way wall holds over ${pages}${sandbox}`),
      );

      return;
    }

    for (const line of report.problems) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(colors().red(`check-citations: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/check-citations.ts` runs */
refuseDirectExecution(import.meta.url, "check-citations", "bin/libexec");
