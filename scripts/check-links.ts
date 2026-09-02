import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { anchorResolves } from "../src/wiki/chapter-headings.ts";
import {
  closingFence,
  FRONTMATTER_FENCE,
  listWikiPages,
} from "../src/wiki/pages.ts";
import {
  buildPageIndex,
  crossWikiTarget,
  extractWikilinks,
} from "../src/wiki/wiki-links.ts";

/**
 * Wikilink checker: scans every Markdown page under wiki/, extracts
 * each `[[wikilink]]` (bare, aliased, or with a heading anchor), and
 * resolves it by page file name against the scanned tree. A
 * body-text heading anchor (`[[page#Chapter]]`, issue #235) must
 * also match a heading in the target page byte-identically — the
 * same rule `check-provenance` enforces for anchored `sources`
 * citations (issue #226), shared through anchorResolves, so the two
 * surfaces cannot drift. Anchored links inside the frontmatter
 * block are `sources` citations — check-provenance's domain — and
 * are not double-reported here. `#^block-id` references are blocks,
 * not headings, and are skipped; a `[[page#A#B]]` multi-level anchor
 * resolves against its final heading segment. Cross-wiki
 * `[[<vault>/<page>]]` links are external to this wiki and are
 * skipped (issue #81); `check-crosslinks` validates them against
 * the domain wikis themselves. Prints one `file:line -> [[link]]` line
 * per broken link and exits 1; exits 0 when every link resolves.
 */

export interface LinkReport {
  /** One `file:line -> [[link]]` line per broken link. */
  readonly broken: readonly string[];
  /** Total wikilinks found across all scanned pages. */
  readonly links: number;
  /** Cross-wiki `[[<vault>/<page>]]` links, skipped as external. */
  readonly external: number;
  /** Markdown pages scanned under the wiki root. */
  readonly pages: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Check every wikilink under `wikiDirInput`, reporting broken links
 * with paths relative to the wiki root's parent directory. Agent
 * contract files (AGENTS.md) are not wiki pages and are skipped.
 * Throws when the wiki directory is missing or not a directory.
 */
export async function checkWikiLinks(
  wikiDirInput: string,
): Promise<LinkReport> {
  const wikiDir = resolve(wikiDirInput);
  const displayRoot = resolve(wikiDir, "..");
  // listWikiPages asserts the directory; the input path (not the
  // resolved one) lands in the error message, matching every other
  // checker that reports what the operator typed.
  const files = await listWikiPages(wikiDirInput);
  const index = buildPageIndex(files);
  const texts = new Map<string, string>();
  const broken: string[] = [];
  let links = 0;
  let external = 0;

  for (const file of files) {
    texts.set(file, await readFile(join(wikiDir, file), "utf8"));
  }

  for (const file of files) {
    const text = texts.get(file) ?? "";
    const reportPath = relative(displayRoot, join(wikiDir, file));
    const lines = text.split("\n");
    // Anchored links inside the frontmatter block are `sources`
    // citations — check-provenance's domain (issue #226); the anchor
    // rule applies to body-text links, which start after the closing
    // fence (line 1 when the page opens with no frontmatter; an
    // unclosed fence leaves the whole page body, matching
    // bodyAfterFrontmatter).
    const bodyFrom =
      lines[0] === FRONTMATTER_FENCE ? closingFence(lines) + 2 : 1;

    for (const link of extractWikilinks(text)) {
      links++;

      if (crossWikiTarget(link.target) !== undefined) {
        external++;

        continue;
      }

      const targetFile = index.get(link.target);

      if (targetFile === undefined) {
        broken.push(`${reportPath}:${link.line} -> ${link.raw}`);

        continue;
      }

      if (
        link.anchor !== undefined &&
        link.line >= bodyFrom &&
        !anchorResolves(texts.get(targetFile) ?? "", link.anchor)
      ) {
        broken.push(
          `${reportPath}:${link.line} -> ${link.raw} (target has no heading "${link.anchor}")`,
        );
      }
    }
  }

  return { broken, links, external, pages: files.length };
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-links [-h | --help] [<wiki-dir>]

Check that every [[wikilink]] under a wiki resolves: the target page
must exist by file name, and a body-text heading anchor
([[page#Chapter]]) must match a heading in the target page
byte-identically — no case or punctuation tolerance, because wiki
anchors are generated, not typed. Anchored citations inside the
frontmatter sources list are check-provenance's domain and are not
re-checked here; block references ([[page#^block-id]]) and
multi-level anchors' parent segments are skipped. Cross-wiki
[[<vault>/<page>]] links are external and skipped; check-crosslinks
validates them against the domain wikis.

  <wiki-dir>    Wiki root to scan. Default: the repo's own wiki/.
  -h, --help    Print this help and exit; no side effects.

Writes nothing. Prints one \`file:line -> [[link]]\` line per broken
link (red) to stderr and exits 1; prints an ok summary (green) and
exits 0 when every link resolves (an empty wiki is ok). NO_COLOR
disables color.`;

/** check-links entry point: `check-links [-h | --help] [<wiki-dir>]` (default: repo wiki/). */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const wikiDir = args[0] ?? join(repoRoot, "wiki");

  try {
    const report = await checkWikiLinks(wikiDir);

    if (report.broken.length === 0) {
      const links = `${report.links} ${report.links === 1 ? "wikilink" : "wikilinks"}`;
      const pages = `${report.pages} ${report.pages === 1 ? "page" : "pages"}`;
      const external =
        report.external > 0
          ? ` (${report.external} external ${report.external === 1 ? "cross-wiki link" : "cross-wiki links"})`
          : "";

      console.log(
        colors().green(
          `ok: ${links} ${report.links === 1 ? "resolves" : "resolve"} across ${pages}${external}`,
        ),
      );

      return;
    }

    for (const line of report.broken) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(colors().red(`check-links: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/check-links.ts` runs */
refuseDirectExecution(import.meta.url, "check-links");
