import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createColors } from "picocolors";
import { isMainModule } from "../src/cli/is-main.ts";
import { parseManifest, readManifestText } from "../src/sync/manifest.ts";
import { listWikiPages } from "../src/wiki/pages.ts";
import {
  buildPageIndex,
  crossWikiTarget,
  extractWikilinks,
} from "../src/wiki-links.ts";

/**
 * Cross-wiki link checker (issue #81): validates the one-way link
 * discipline between a wiki and its domain wikis.
 *
 *  1. every `[[<vault>/<page>]]` link in the audited wiki must name a
 *     vault of one of the passed domain wikis (validated
 *     case-insensitively against each domain repo's
 *     `raw/manifest.json`) and resolve to an existing page of that
 *     wiki — second-brain notes may reference domain knowledge, and
 *     the reference must be alive;
 *  2. the domain wikis themselves must contain no cross-wiki links —
 *     they are link sinks and never point at second-brain material.
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
  readonly auditedPages: number;
  /** Markdown pages scanned across the domain wikis. */
  readonly domainPages: number;
}

/** One linkable domain wiki: its dir, its files, the page-name index,
 *  and the vault names its manifest declares (lowercased). */
interface DomainWiki {
  readonly dir: string;
  readonly files: readonly string[];
  readonly vaults: ReadonlySet<string>;
  readonly pages: ReadonlyMap<string, string>;
}

/** Colors at the render boundary: green = ok, red = broken/error;
 *  NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** Load one domain wiki: its pages plus the vault names its sibling
 *  manifest declares. The manifest is the prefix's identity source —
 *  without it there is nothing to validate the link grammar against. */
async function loadDomainWiki(dirInput: string): Promise<DomainWiki> {
  const dir = resolve(dirInput);
  const files = await listWikiPages(dirInput);
  const manifestPath = join(dir, "..", "raw", "manifest.json");
  const manifestText = await readManifestText(manifestPath);

  if (manifestText === undefined) {
    throw new Error(
      `cannot validate the domain wiki at ${dirInput}: no manifest at ${manifestPath} — pass a domain data repo's wiki dir`,
    );
  }

  const vaults = new Set(
    Object.keys(parseManifest(manifestText, manifestPath).vaults).map((vault) =>
      vault.toLowerCase(),
    ),
  );

  if (vaults.size === 0) {
    throw new Error(
      `cannot validate the domain wiki at ${dirInput}: the manifest at ${manifestPath} names no vaults`,
    );
  }

  return { dir, files, vaults, pages: buildPageIndex(files) };
}

/**
 * Audit the cross-wiki discipline of `wikiDirInput` against one or
 * more domain wikis, reporting problems with paths relative to each
 * wiki root's parent directory. Throws when a directory is missing or
 * a domain wiki has no sibling manifest.
 */
export async function checkCrossWikiLinks(
  wikiDirInput: string,
  ...domainDirInputs: string[]
): Promise<CrossLinkReport> {
  const wikiDir = resolve(wikiDirInput);
  const displayRoot = resolve(wikiDir, "..");
  const files = await listWikiPages(wikiDirInput);
  const domains = [];

  for (const dirInput of domainDirInputs) {
    domains.push(await loadDomainWiki(dirInput));
  }

  const problems: string[] = [];
  let external = 0;

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");

    for (const link of extractWikilinks(text)) {
      const target = crossWikiTarget(link.target);

      if (target === undefined) {
        continue;
      }

      external++;

      const where = `${relative(displayRoot, join(wikiDir, file))}:${link.line} -> ${link.raw}`;
      const domain = domains.find((wiki) =>
        wiki.vaults.has(target.vault.toLowerCase()),
      );

      if (domain === undefined) {
        problems.push(`${where} (unknown domain wiki "${target.vault}")`);
      } else if (!domain.pages.has(target.page)) {
        problems.push(where);
      }
    }
  }

  let domainPages = 0;

  for (const domain of domains) {
    domainPages += domain.files.length;
    const domainDisplayRoot = resolve(domain.dir, "..");

    for (const file of domain.files) {
      const text = await readFile(join(domain.dir, file), "utf8");

      for (const link of extractWikilinks(text)) {
        if (crossWikiTarget(link.target) !== undefined) {
          problems.push(
            `${relative(domainDisplayRoot, join(domain.dir, file))}:${link.line} -> ${link.raw} (domain wikis must not use cross-wiki links)`,
          );
        }
      }
    }
  }

  return { problems, external, auditedPages: files.length, domainPages };
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-crosslinks [-h | --help] <wiki-dir> <domain-wiki-dir> [<domain-wiki-dir>...]

Check the one-way cross-wiki link discipline between a wiki and its
domain wikis (issue #81): every [[<vault>/<page>]] link in <wiki-dir>
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
    const report = await checkCrossWikiLinks(
      wikiDir ?? "",
      ...domainDirs,
    );

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
