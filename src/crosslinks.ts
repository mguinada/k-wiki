import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readTextIfExists } from "./cli/shared.ts";
import { parseManifest } from "./sync/manifest.ts";
import { listWikiPages, pageReportPath } from "./wiki/pages.ts";
import {
  buildPageIndex,
  crossWikiTarget,
  extractWikilinks,
} from "./wiki/wiki-links.ts";

/**
 * The cross-wiki link audit (issue #81): the library core behind
 * `scripts/check-crosslinks.ts` and the wiki-sync cycle stage
 * (issue #96). It validates the one-way link discipline between a
 * wiki and its domain wikis:
 *
 *  1. every `[[<vault>/<page>]]` link in the audited wiki must name a
 *     vault of one of the passed domain wikis (validated
 *     case-insensitively against each domain repo's
 *     `raw/manifest.json`) and resolve to an existing page of that
 *     wiki — second-brain notes may reference domain knowledge, and
 *     the reference must be alive;
 *  2. the domain wikis themselves must contain no cross-wiki links —
 *     they are link sinks and never point at second-brain material.
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

/** Load one domain wiki: its pages plus the vault names its sibling
 *  manifest declares. The manifest is the prefix's identity source —
 *  without it there is nothing to validate the link grammar against. */
async function loadDomainWiki(dirInput: string): Promise<DomainWiki> {
  const dir = resolve(dirInput);
  const files = await listWikiPages(dirInput);
  const manifestPath = join(dir, "..", "raw", "manifest.json");
  const manifestText = await readTextIfExists(manifestPath);

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

/** Audit the audited wiki's outgoing links: every cross-wiki link
 *  must name a known domain vault and resolve to that domain's page. */
async function auditWikiLinks(
  wikiDir: string,
  files: readonly string[],
  domains: readonly DomainWiki[],
): Promise<{ problems: string[]; external: number }> {
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

      const where = `${pageReportPath(wikiDir, file)}:${link.line} -> ${link.raw}`;
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

  return { problems, external };
}

/** Audit the domain wikis: they are link sinks, so any cross-wiki
 *  link inside them is forbidden. */
async function auditDomainLinks(
  domains: readonly DomainWiki[],
): Promise<string[]> {
  const problems: string[] = [];

  for (const domain of domains) {
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

  return problems;
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
  const files = await listWikiPages(wikiDirInput);
  const domains = [];

  for (const dirInput of domainDirInputs) {
    domains.push(await loadDomainWiki(dirInput));
  }

  const audited = await auditWikiLinks(wikiDir, files, domains);
  const domainProblems = await auditDomainLinks(domains);

  return {
    problems: [...audited.problems, ...domainProblems],
    external: audited.external,
    auditedPages: files.length,
    domainPages: domains.reduce(
      (total, domain) => total + domain.files.length,
      0,
    ),
  };
}
