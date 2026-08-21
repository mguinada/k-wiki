import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule } from "../src/cli/is-main.ts";

/**
 * Wikilink checker: scans every Markdown page under wiki/, extracts
 * each `[[wikilink]]` (bare, aliased, or with a heading anchor), and
 * resolves it by page file name against the scanned tree. Prints one
 * `file:line -> [[link]]` line per broken link and exits 1; exits 0
 * when every link resolves.
 */

export interface Wikilink {
  /** The page name the link points at: before any alias and anchor. */
  readonly target: string;
  /** The 1-based line the link starts on. */
  readonly line: number;
  /** The original `[[...]]` text as written. */
  readonly raw: string;
}

export interface LinkReport {
  /** One `file:line -> [[link]]` line per broken link. */
  readonly broken: readonly string[];
  /** Total wikilinks found across all scanned pages. */
  readonly links: number;
  /** Markdown pages scanned under the wiki root. */
  readonly pages: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Colors at the render boundary: green = ok, red = broken/error;
 *  NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

/**
 * Extract every wikilink from markdown text, skipping fenced code
 * blocks. Aliased links keep only the page name, heading anchors are
 * dropped, and anchor-only or alias-only links are ignored.
 */
export function extractWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];
  let fenceChar: string | null = null;

  for (const [i, line] of text.split("\n").entries()) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

    if (fence !== undefined) {
      if (fenceChar === null) {
        fenceChar = fence[0] ?? null;
      } else if (fence[0] === fenceChar) {
        fenceChar = null;
      }

      continue;
    }

    if (fenceChar !== null) {
      continue;
    }

    for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const body = match[1] ?? "";
      const target = body.split("|")[0]?.split("#")[0]?.trim() ?? "";

      if (target === "") {
        continue;
      }

      links.push({ target, line: i + 1, raw: match[0] });
    }
  }

  return links;
}

/**
 * Map page names to their wiki-relative paths by file name (kebab-case
 * naming per wiki/AGENTS.md); later files win on duplicate names.
 */
export function buildPageIndex(files: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const file of files) {
    if (file.endsWith(".md")) {
      index.set(basename(file, ".md"), file);
    }
  }

  return index;
}

/** Recursively list every wiki-relative path under `dir`. */
async function listFiles(
  dir: string,
  prefix = "",
  files: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await listFiles(join(dir, entry.name), rel, files);
    } else {
      files.push(rel);
    }
  }

  return files;
}

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

  await assertWikiDir(wikiDir, wikiDirInput);

  const displayRoot = resolve(wikiDir, "..");
  const files = (await listFiles(wikiDir)).filter(
    (file) => file.endsWith(".md") && basename(file) !== "AGENTS.md",
  );
  const index = buildPageIndex(files);
  const broken: string[] = [];
  let links = 0;

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");

    for (const link of extractWikilinks(text)) {
      links++;

      if (!index.has(link.target)) {
        broken.push(
          `${relative(displayRoot, join(wikiDir, file))}:${link.line} -> ${link.raw}`,
        );
      }
    }
  }

  return { broken, links, pages: files.length };
}

async function assertWikiDir(
  wikiDir: string,
  wikiDirInput: string,
): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(wikiDir)).isDirectory();
  } catch {
    throw new Error(`wiki directory does not exist: ${wikiDirInput}`);
  }

  if (!isDirectory) {
    throw new Error(`wiki directory is not a directory: ${wikiDirInput}`);
  }
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-links [-h | --help] [<wiki-dir>]

Check that every [[wikilink]] under a wiki resolves to an existing
page by file name (bare, aliased, and heading-anchor links).

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

      console.log(
        colors().green(
          `ok: ${links} ${report.links === 1 ? "resolves" : "resolve"} across ${pages}`,
        ),
      );

      return;
    }

    for (const line of report.broken) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(
      colors().red(
        `check-links: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under `node scripts/check-links.ts` */
if (isMainModule(import.meta.url)) {
  await main();
}
