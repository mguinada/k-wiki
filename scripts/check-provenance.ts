import { stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../src/cli/is-main.ts";
import {
  buildPageIndex,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  readPageFields,
  wikilinkTarget,
} from "../src/wiki/pages.ts";

/**
 * Dead-provenance checker (issue #65): the deterministic backstop that
 * catches any purge miss — and any sync/wiki drift of any kind. Every
 * `sources` wikilink on every wiki page must resolve to an existing
 * page, and every `origin` raw path must exist under `raw/`. Prints one
 * `wiki/<page> -> …` line per problem and exits 1; exits 0 when the
 * wiki is coherent (an empty wiki is coherent).
 */

export interface ProvenanceReport {
  /** One `wiki/<page> -> …` line per dead-provenance problem. */
  readonly problems: readonly string[];
  /** `sources` wikilinks checked across all scanned pages. */
  readonly sources: number;
  /** `origin` fields checked. */
  readonly origins: number;
  /** `type: source` pages whose frontmatter lacks `origin`. */
  readonly missingOrigins: number;
  /** Markdown pages scanned under the wiki root. */
  readonly pages: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Colors at the render boundary: green = ok, yellow = warning, red =
 *  problem/error; NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

/**
 * The missing-origin warning (issue #92): a signal, not a gate — the
 * exit code stays 0. Names the exact backfill commands with the paths
 * as resolved for this run, dry run first (it prints every pairing
 * and writes nothing).
 */
function printBackfillWarning(
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

/** The raw projection must be a directory; named on failure. */
async function assertRawDir(rawDir: string): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(rawDir)).isDirectory();
  } catch {
    throw new Error(`raw directory does not exist: ${rawDir}`);
  }

  if (!isDirectory) {
    throw new Error(`raw directory is not a directory: ${rawDir}`);
  }
}

/**
 * Check every wiki page under `wikiDirInput` against the raw projection
 * at `rawDirInput`, reporting problems with paths relative to the wiki
 * root's parent directory. A `sources` entry must be alive: a wikilink
 * entry resolves to an existing wiki page, a path entry to an existing
 * file under `raw/`; an `origin` must exist under `raw/`. Agent
 * contract files (AGENTS.md) are not wiki pages and are skipped.
 * Throws when either directory is missing.
 */
export async function checkWikiProvenance(
  wikiDirInput: string,
  rawDirInput: string,
): Promise<ProvenanceReport> {
  const wikiDir = resolve(wikiDirInput);
  const rawDir = resolve(rawDirInput);

  // listWikiPages asserts the wiki directory itself; only the raw
  // side needs its own check here.
  const files = await listWikiPages(wikiDir);

  await assertRawDir(rawDir);
  const index = buildPageIndex(files);
  const problems: string[] = [];
  let sources = 0;
  let origins = 0;
  let missingOrigins = 0;

  for (const file of files) {
    const fields = await readPageFields(join(wikiDir, file));
    const page = relative(resolve(wikiDir, ".."), join(wikiDir, file));

    if (fields.type === "source" && fields.origin === undefined) {
      missingOrigins++;
    }

    for (const entry of fields.sources) {
      sources++;

      if (isWikilinkEntry(entry)) {
        if (!index.has(wikilinkTarget(entry))) {
          problems.push(`${page} -> ${entry} (missing source page)`);
        }

        continue;
      }

      try {
        await stat(join(rawDir, normalizeRawPath(entry)));
      } catch {
        problems.push(`${page} -> sources ${entry} (missing under raw/)`);
      }
    }

    if (fields.origin !== undefined) {
      origins++;

      try {
        await stat(join(rawDir, normalizeRawPath(fields.origin)));
      } catch {
        problems.push(
          `${page} -> origin ${fields.origin} (missing under raw/)`,
        );
      }
    }
  }

  return { problems, sources, origins, missingOrigins, pages: files.length };
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
