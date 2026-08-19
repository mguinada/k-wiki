import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Extract every wikilink from markdown text. Aliased links keep only
 * the page name, heading anchors are dropped, and anchor-only or
 * alias-only links are ignored.
 */
export function extractWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];

  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const body = match[1] ?? "";
    const target = body.split("|")[0]?.split("#")[0]?.trim() ?? "";

    if (target === "") {
      continue;
    }

    links.push({
      target,
      line: text.slice(0, match.index).split("\n").length,
      raw: match[0],
    });
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
 * with paths relative to the wiki root's parent directory.
 */
export async function checkWikiLinks(
  wikiDirInput: string,
): Promise<LinkReport> {
  const wikiDir = resolve(wikiDirInput);
  const displayRoot = resolve(wikiDir, "..");
  const files = (await listFiles(wikiDir)).filter((file) =>
    file.endsWith(".md"),
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

/** check-links entry point: `check-links [<wiki-dir>]` (default: repo wiki/). */
export async function main(): Promise<void> {
  const wikiDir = process.argv[2] ?? join(repoRoot, "wiki");
  const report = await checkWikiLinks(wikiDir);

  if (report.broken.length === 0) {
    const links = `${report.links} ${report.links === 1 ? "wikilink" : "wikilinks"}`;
    const pages = `${report.pages} ${report.pages === 1 ? "page" : "pages"}`;

    console.log(
      `ok: ${links} ${report.links === 1 ? "resolves" : "resolve"} across ${pages}`,
    );

    return;
  }

  for (const line of report.broken) {
    console.error(line);
  }

  process.exitCode = 1;
}

/* v8 ignore next: import guard — distinguishes direct execution from
   import; not exercisable in-process by construction */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

/* v8 ignore next: covered only under `node scripts/check-links.ts` */
if (isMain) {
  await main();
}
