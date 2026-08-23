import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createColors } from "picocolors";
import { isMainModule } from "../src/cli/is-main.ts";
import {
  buildPageIndex,
  crossWikiTarget,
  extractWikilinks,
  listFiles,
} from "../src/wiki-links.ts";

/**
 * Cross-wiki link checker (issue #81): validates the one-way link
 * discipline between a wiki and the engineering wiki.
 *
 *  1. every `[[engineering/<page>]]` link in the audited wiki must
 *     resolve to an existing page of the engineering wiki (personal
 *     notes may reference domain knowledge; the reference must be
 *     alive);
 *  2. the engineering wiki itself must contain no cross-wiki links —
 *     it stays self-contained and never points at personal material,
 *     and no page may dodge internal link resolution via the prefix.
 *
 * Prints one `file:line -> [[link]]` line per problem and exits 1;
 * exits 0 when the discipline holds.
 */

export interface CrossLinkReport {
  /** One `file:line -> [[link]]` line per broken or forbidden link. */
  readonly problems: readonly string[];
  /** Cross-wiki links found in the audited wiki. */
  readonly external: number;
  /** Markdown pages scanned in the audited wiki. */
  readonly pages: number;
  /** Markdown pages scanned in the engineering wiki. */
  readonly engineeringPages: number;
}

/** Colors at the render boundary: green = ok, red = broken/error;
 *  NO_COLOR yields plain text. */

/** Colors at the render boundary: green = ok, red = broken/error;
 *  NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

async function assertWikiDir(
  dir: string,
  dirInput: string,
  label: string,
): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    throw new Error(`${label} directory does not exist: ${dirInput}`);
  }

  if (!isDirectory) {
    throw new Error(`${label} directory is not a directory: ${dirInput}`);
  }
}

/** Markdown pages of one wiki tree, skipping the AGENTS.md contract. */
async function wikiPages(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter(
    (file) => file.endsWith(".md") && basename(file) !== "AGENTS.md",
  );
}

/**
 * Audit the cross-wiki discipline of `wikiDirInput` against
 * `engineeringDirInput`, reporting problems with paths relative to
 * each wiki root's parent directory. Throws when either directory is
 * missing or not a directory.
 */
export async function checkCrossWikiLinks(
  wikiDirInput: string,
  engineeringDirInput: string,
): Promise<CrossLinkReport> {
  const wikiDir = resolve(wikiDirInput);
  const engineeringDir = resolve(engineeringDirInput);

  await assertWikiDir(wikiDir, wikiDirInput, "wiki");
  await assertWikiDir(engineeringDir, engineeringDirInput, "engineering wiki");

  const files = await wikiPages(wikiDir);
  const engineeringFiles = await wikiPages(engineeringDir);
  const index = buildPageIndex(engineeringFiles);
  const problems: string[] = [];
  let external = 0;

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");

    for (const link of extractWikilinks(text)) {
      const page = crossWikiTarget(link.target);

      if (page === undefined) {
        continue;
      }

      external++;

      if (!index.has(page)) {
        problems.push(
          `${relative(resolve(wikiDir, ".."), join(wikiDir, file))}:${link.line} -> ${link.raw}`,
        );
      }
    }
  }

  for (const file of engineeringFiles) {
    const text = await readFile(join(engineeringDir, file), "utf8");

    for (const link of extractWikilinks(text)) {
      if (crossWikiTarget(link.target) !== undefined) {
        problems.push(
          `${relative(resolve(engineeringDir, ".."), join(engineeringDir, file))}:${link.line} -> ${link.raw}`,
        );
      }
    }
  }

  return {
    problems,
    external,
    pages: files.length,
    engineeringPages: engineeringFiles.length,
  };
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-crosslinks [-h | --help] <wiki-dir> <engineering-wiki-dir>

Check the one-way cross-wiki link discipline between a wiki and the
engineering wiki (issue #81): every [[engineering/<page>]] link in
<wiki-dir> must resolve to an existing page of the engineering wiki,
and the engineering wiki itself must contain no cross-wiki links —
it stays self-contained and never references personal material.

  <wiki-dir>              Wiki root to audit (the personal or any
                          other non-engineering wiki). Required.
  <engineering-wiki-dir>  The engineering wiki that cross-wiki links
                          resolve against. Required.
  -h, --help              Print this help and exit; no side effects.

Writes nothing. Prints one \`file:line -> [[link]]\` line per problem
(red) to stderr and exits 1; prints an ok summary (green) and exits 0
when the discipline holds. Internal [[wikilinks]] are check-links'
business; this tool only audits the cross-wiki prefix. NO_COLOR
disables color.`;

/** check-crosslinks entry point: `check-crosslinks [-h | --help] <wiki-dir> <engineering-wiki-dir>`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  if (args.length !== 2) {
    console.error(
      colors().red(
        `check-crosslinks: expected exactly two arguments (<wiki-dir> <engineering-wiki-dir>), got ${args.length}`,
      ),
    );
    process.exitCode = 1;

    return;
  }

  try {
    const report = await checkCrossWikiLinks(args[0] ?? "", args[1] ?? "");

    if (report.problems.length === 0) {
      const links = `${report.external} cross-wiki ${report.external === 1 ? "link" : "links"}`;
      const pages = `${report.engineeringPages} engineering ${report.engineeringPages === 1 ? "page" : "pages"}`;

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
    console.error(
      colors().red(
        `check-crosslinks: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under `node scripts/check-crosslinks.ts` */
if (isMainModule(import.meta.url)) {
  await main();
}
