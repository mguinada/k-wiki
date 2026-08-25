import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule, refuseTestWorker } from "../src/cli/is-main.ts";
import { checkWikiProvenance } from "../src/wiki/provenance.ts";

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

/** Colors at the render boundary: green = ok, yellow = warning, red =
 *  problem/error; NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

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

/** check-provenance entry point: `check-provenance [-h | --help] [<wiki-dir> [<raw-dir>]]` (defaults: repo wiki/, sibling raw/). */
export async function main(): Promise<void> {
  refuseTestWorker("check-provenance");

  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  if (args.length > 2) {
    console.error(
      colors().red("check-provenance: expected at most two arguments"),
    );
    process.exitCode = 1;

    return;
  }

  const wikiDir = args[0] ?? join(repoRoot, "wiki");
  const rawDir = args[1] ?? join(dirname(wikiDir), "raw");

  try {
    const report = await checkWikiProvenance(wikiDir, rawDir);

    if (report.problems.length === 0) {
      const sourcePart = `${report.sources} ${report.sources === 1 ? "source link" : "source links"} ${report.sources === 1 ? "resolves" : "resolve"}`;
      const originPart = `${report.origins} ${report.origins === 1 ? "origin exists" : "origins exist"}`;
      const pages = `${report.pages} ${report.pages === 1 ? "page" : "pages"}`;

      console.log(
        colors().green(`ok: ${sourcePart}, ${originPart} across ${pages}`),
      );

      if (report.missingOrigins > 0) {
        printBackfillWarning(report.missingOrigins, wikiDir, rawDir);
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
        `check-provenance: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under `node scripts/check-provenance.ts` */
if (isMainModule(import.meta.url)) {
  await main();
}
