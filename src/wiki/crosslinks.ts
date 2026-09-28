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
 *     the reference must be alive; outputs-namespace `[[outputs/…]]`
 *     citations are not cross-wiki: they resolve against the data
 *     root's outputs/ directory — the wiki dir's sibling — and must
 *     name an existing file there (issue #414);
 *  2. the domain wikis themselves must contain no cross-wiki links —
 *     they are link sinks and never point at second-brain material;
 *     an `[[outputs/…]]` citation is not cross-wiki there either: it
 *     resolves against that domain repo's outputs/ directory (issue
 *     #414);
 *  3. the audited wiki's sandbox namespace contains no cross-wiki
 *     links at all (issue #339) — sandbox notes are agent scratch
 *     inside one instance, and a slashed link from them is a
 *     cross-instance leak, forbidden outright, validity aside — an
 *     `[[outputs/…]]` citation excepted: same-instance data,
 *     resolved against the data root's outputs/ directory like any
 *     other page's (issue #414).
 */

import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readTextIfExists } from "../cli/shared.ts";
import { parseManifest } from "../sync/manifest.ts";
import {
  isOutputsTarget,
  OUTPUTS_DIR,
  outputsFileProbe,
  outputsLinkProblem,
  outputsProblemReason,
} from "./outputs-links.ts";
import { listSandboxPages, listWikiPages, pageReportPath } from "./pages.ts";
import {
  buildPageIndex,
  crossWikiTarget,
  extractWikilinks,
} from "./wiki-links.ts";

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
 *  must name a known domain vault and resolve to that domain's page;
 *  an outputs-namespace citation instead resolves against the data
 *  root's outputs/ directory — the wiki dir's sibling — and must
 *  name an existing file there (issue #414). */
async function auditWikiLinks(
  wikiDir: string,
  files: readonly string[],
  domains: readonly DomainWiki[],
): Promise<{ problems: string[]; external: number }> {
  const problems: string[] = [];
  let external = 0;
  const outputs = await outputsFileProbe(join(wikiDir, "..", OUTPUTS_DIR));

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");

    for (const link of extractWikilinks(text)) {
      const where = `${pageReportPath(wikiDir, file)}:${link.line} -> ${link.raw}`;

      // Outputs-namespace citations (issue #410) are not cross-wiki:
      // they resolve against this data root's outputs/ directory,
      // before any slashed-target reading (issue #414).
      if (isOutputsTarget(link.target)) {
        const problem = outputsLinkProblem(link.target, outputs);

        if (problem !== undefined) {
          problems.push(
            `${where} (${outputsProblemReason(link.target, problem)})`,
          );
        }

        continue;
      }

      const target = crossWikiTarget(link.target);

      if (target === undefined) {
        continue;
      }

      external++;

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
 *  link inside them is forbidden; an outputs citation instead
 *  resolves against the domain repo's outputs/ directory — the
 *  domain wiki dir's sibling — and must name an existing file there
 *  (issue #414). */
async function auditDomainLinks(
  domains: readonly DomainWiki[],
): Promise<string[]> {
  const problems: string[] = [];

  for (const domain of domains) {
    const domainDisplayRoot = resolve(domain.dir, "..");
    const outputs = await outputsFileProbe(join(domain.dir, "..", OUTPUTS_DIR));

    for (const file of domain.files) {
      const text = await readFile(join(domain.dir, file), "utf8");

      for (const link of extractWikilinks(text)) {
        const where = `${relative(domainDisplayRoot, join(domain.dir, file))}:${link.line} -> ${link.raw}`;

        if (isOutputsTarget(link.target)) {
          const problem = outputsLinkProblem(link.target, outputs);

          if (problem !== undefined) {
            problems.push(
              `${where} (${outputsProblemReason(link.target, problem)})`,
            );
          }

          continue;
        }

        if (crossWikiTarget(link.target) !== undefined) {
          problems.push(
            `${where} (domain wikis must not use cross-wiki links)`,
          );
        }
      }
    }
  }

  return problems;
}

/** Audit the audited wiki's sandbox namespace (issue #339): sandbox
 *  notes are agent scratch inside one instance — a slashed
 *  `[[<vault>/<page>]]` link from them is a cross-instance leak, so
 *  every one is forbidden outright, validity aside. Plain internal
 *  links from sandbox pages are the citation wall's business, not
 *  this audit's. An outputs citation is same-instance data, not a
 *  leak: it resolves against the data root's outputs/ directory —
 *  the wiki dir's sibling — like any other page's (issue #414). */
async function auditSandboxLinks(wikiDir: string): Promise<string[]> {
  const problems: string[] = [];
  const outputs = await outputsFileProbe(join(wikiDir, "..", OUTPUTS_DIR));

  for (const file of await listSandboxPages(wikiDir)) {
    const text = await readFile(join(wikiDir, file), "utf8");

    for (const link of extractWikilinks(text)) {
      const where = `${pageReportPath(wikiDir, file)}:${link.line} -> ${link.raw}`;

      if (isOutputsTarget(link.target)) {
        const problem = outputsLinkProblem(link.target, outputs);

        if (problem !== undefined) {
          problems.push(
            `${where} (${outputsProblemReason(link.target, problem)})`,
          );
        }

        continue;
      }

      if (crossWikiTarget(link.target) !== undefined) {
        problems.push(`${where} (sandbox pages must not use cross-wiki links)`);
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
  const sandboxFiles = await listSandboxPages(wikiDirInput);
  const domains = [];

  for (const dirInput of domainDirInputs) {
    domains.push(await loadDomainWiki(dirInput));
  }

  const audited = await auditWikiLinks(wikiDir, files, domains);
  const domainProblems = await auditDomainLinks(domains);
  const sandboxProblems = await auditSandboxLinks(wikiDir);

  return {
    problems: [...audited.problems, ...domainProblems, ...sandboxProblems],
    external: audited.external,
    auditedPages: files.length + sandboxFiles.length,
    domainPages: domains.reduce(
      (total, domain) => total + domain.files.length,
      0,
    ),
  };
}
