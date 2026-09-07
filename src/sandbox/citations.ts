/**
 * The one-way citation wall core (issue #339, decision 4 of epic
 * #289): sandbox notes may read the main wiki, but the main wiki
 * must never depend on sandbox notes — the TTL reaper would break
 * main→sandbox links, and `sources` edges into the sandbox would
 * give unsourced agent notes provenance they did not earn. This
 * module is the pure audit both enforcement surfaces share: the
 * `bin/libexec/check-citations` checker and the wiki-sync cycle's
 * standing lint (which additionally path-scoped-reverts the
 * offending pages). Forbidden edges, all first-class:
 *
 *  - main→sandbox body links and `![[…]]` embeds (embeds are links);
 *  - sandbox→sandbox body links — a promoted note citing a
 *    still-sandbox sibling would become a main→sandbox violation at
 *    promotion, and sandbox-to-sandbox citation is the laundering
 *    path around the wall;
 *  - `sources` edges touching a sandbox page in either direction;
 *  - cross-wiki `[[<vault>/<page>]]` links from sandbox pages
 *    (also enforced by check-crosslinks, its own surface);
 *  - the `via: agent` stamp outside `wiki/sandbox/` (stamp
 *    placement — the epilogue writes it, so a main page carrying it
 *    is a forged or misplaced stamp).
 *
 * Link *resolution* is never judged here: a sandbox link to a
 * renamed-away main page is check-links' business (targets must
 * resolve, same as main-page links); this core judges direction and
 * placement only.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunContext } from "../cli/run-context.ts";
import { pluralized } from "../cli/shared.ts";
import {
  closingFence,
  FRONTMATTER_FENCE,
  isWikilinkEntry,
  listSandboxPages,
  listWikiPages,
  parsePageFields,
  unquote,
  wikilinkTarget,
} from "../wiki/pages.ts";
import { crossWikiTarget, extractWikilinks, stem } from "../wiki/wiki-links.ts";
import { revertPathsToLastCommit } from "./sandbox-run.ts";
import { SANDBOX_ROOT } from "./stamps.ts";

/** What one wall audit found. */
export interface CitationWallReport {
  /** One `wiki/<path>[:<line>] -> <evidence> (<reason>)` line per
   *  violation, in page order. */
  readonly problems: readonly string[];
  /** The wiki-relative paths of the offending pages (unique, sorted)
   *  — the standing lint's path-scoped revert set. */
  readonly offendingPaths: readonly string[];
  /** Main wiki pages scanned. */
  readonly pages: number;
  /** Sandbox pages scanned. */
  readonly sandboxPages: number;
}

/** One violation before formatting: the offending page and the line
 *  when the surface carries one (body links and stamps do; `sources`
 *  entries are parsed without positions). */
interface Violation {
  readonly path: string;
  readonly line: number | undefined;
  readonly message: string;
}

/** Format one violation as the checker's report line. */
function formatViolation(violation: Violation): string {
  const where =
    violation.line === undefined
      ? `wiki/${violation.path}`
      : `wiki/${violation.path}:${violation.line}`;

  return `${where} -> ${violation.message}`;
}

/** Every way a link target names a sandbox page: by page-name stem
 *  (`[[proposal]]`) or by wiki-relative path (`[[sandbox/proposal]]`). */
function sandboxNamer(files: readonly string[]): (target: string) => boolean {
  const stems = new Set(files.map(stem));
  const slashed = new Set(files.map((file) => file.replace(/\.md$/, "")));

  return (target: string) => stems.has(target) || slashed.has(target);
}

/** The 1-based line of the top-level `via: agent` stamp inside the
 *  frontmatter block; undefined when the page carries none. */
function agentStampLine(text: string): number | undefined {
  const lines = text.split(/\r?\n/);

  if (lines[0] !== FRONTMATTER_FENCE) {
    return undefined;
  }

  const end = closingFence(lines);

  if (end === -1) {
    return undefined;
  }

  for (const [i, line] of lines.slice(1, end).entries()) {
    if (/^via:/.test(line) && unquote(line.slice(4).trim()) === "agent") {
      return i + 2;
    }
  }

  return undefined;
}

/** Body-link violations of one page: links into the sandbox (either
 *  side) and cross-wiki links from sandbox pages. Embeds are links —
 *  the extractor sees `![[x]]` as `[[x]]`. Anchored links inside the
 *  frontmatter block are `sources` citations, not body links, and are
 *  skipped here (check-links' own bodyFrom rule). */
function bodyViolations(
  path: string,
  text: string,
  namesSandbox: (target: string) => boolean,
  fromSandbox: boolean,
): Violation[] {
  const lines = text.split("\n");
  const bodyFrom = lines[0] === FRONTMATTER_FENCE ? closingFence(lines) + 2 : 1;
  const violations: Violation[] = [];

  for (const link of extractWikilinks(text)) {
    if (link.line < bodyFrom) {
      continue;
    }

    const crossWiki = crossWikiTarget(link.target) !== undefined;
    const intoSandbox = namesSandbox(link.target);

    if (fromSandbox && crossWiki) {
      violations.push({
        path,
        line: link.line,
        message: `${link.raw} (sandbox pages must not use cross-wiki links)`,
      });
    } else if (intoSandbox) {
      violations.push({
        path,
        line: link.line,
        message: fromSandbox
          ? `${link.raw} (sandbox pages cite main wiki content only, never sandbox peers)`
          : `${link.raw} (main pages must not link or embed sandbox pages)`,
      });
    }
  }

  return violations;
}

/** `sources`-edge violations of one page: edges touching the sandbox
 *  in either direction — an entry naming a sandbox page (any page),
 *  or any wikilink entry on a sandbox page. Raw-path entries carry no
 *  edge to a wiki page and never trip. */
function sourcesViolations(
  path: string,
  text: string,
  namesSandbox: (target: string) => boolean,
  fromSandbox: boolean,
): Violation[] {
  const violations: Violation[] = [];

  for (const entry of parsePageFields(text).sources) {
    if (!isWikilinkEntry(entry)) {
      continue;
    }

    if (fromSandbox || namesSandbox(wikilinkTarget(entry))) {
      violations.push({
        path,
        line: undefined,
        message: `sources entry "${entry}" (sources edges never touch the sandbox)`,
      });
    }
  }

  return violations;
}

/** Stamp-placement violations of one main page: the `via: agent`
 *  stamp outside the sandbox namespace. */
function stampViolations(path: string, text: string): Violation[] {
  const line = agentStampLine(text);

  return line === undefined
    ? []
    : [
        {
          path,
          line,
          message:
            "via: agent (agent-stamped pages live only under wiki/sandbox/)",
        },
      ];
}

/**
 * Audit the one-way wall of `wikiDirInput`'s working tree: every
 * main page (the walker's tree) and every sandbox page (through the
 * sandbox-only door, `listSandboxPages`). Throws naming the
 * directory when the wiki root is missing.
 */
export async function checkCitationWall(
  wikiDirInput: string,
): Promise<CitationWallReport> {
  const wikiDir = resolve(wikiDirInput);
  const pages = await listWikiPages(wikiDirInput);
  const sandboxPages = await listSandboxPages(wikiDirInput);
  const namesSandbox = sandboxNamer(sandboxPages);
  const sandboxPrefix = `${SANDBOX_ROOT}/`;
  const violations: Violation[] = [];

  for (const path of [...pages, ...sandboxPages]) {
    const text = await readFile(join(wikiDir, path), "utf8");
    const fromSandbox = path.startsWith(sandboxPrefix);

    violations.push(...bodyViolations(path, text, namesSandbox, fromSandbox));

    if (fromSandbox) {
      violations.push(...sourcesViolations(path, text, namesSandbox, true));
    } else {
      violations.push(
        ...sourcesViolations(path, text, namesSandbox, false),
        ...stampViolations(path, text),
      );
    }
  }

  return {
    problems: violations.map(formatViolation),
    offendingPaths: [...new Set(violations.map((v) => v.path))].sort(),
    pages: pages.length,
    sandboxPages: sandboxPages.length,
  };
}

/** What the citation wall stage reports back to the wiki-sync cycle
 *  digest. */
export interface CitationWallStageResult {
  /** Main wiki pages scanned. */
  readonly pages: number;
  /** Sandbox pages scanned. */
  readonly sandboxPages: number;
}

export interface CitationWallOptions {
  /** The run context: the audit runs over the context's wiki dir. */
  readonly run: RunContext;
}

/**
 * The standing lint stage (issue #339): run the one-way audit over
 * the working tree's wiki/ — every wiki-sync cycle, whatever the
 * ingest stage did. A violation path-scoped-reverts every offending
 * page to its last committed state (never a whole-repo reset), then
 * throws one problem line per finding, stopping the cycle before
 * the commit — nothing compounds without the operator's commit: a
 * rogue edge predating the cycle is present in any pre-cycle
 * capture too, so only the last committed state is guaranteed clean
 * of it. The cycle prints its own numbered stage line around this
 * call; the revert itself is family 3's primitive shape.
 */
export async function runCitationWallStage(
  options: CitationWallOptions,
): Promise<CitationWallStageResult> {
  const { run } = options;

  run.onProgress("wiki-sync: citations — checking the one-way sandbox wall");

  const report = await checkCitationWall(run.wikiDir);

  if (report.problems.length > 0) {
    run.onProgress(
      `wiki-sync: citations — path-scoped revert of ${pluralized(report.offendingPaths.length, "rogue page")} to their last committed state`,
    );

    await revertPathsToLastCommit(
      run,
      report.offendingPaths.map((path) => `wiki/${path}`),
    );

    throw new Error(`citation wall failed:\n${report.problems.join("\n")}`);
  }

  return {
    pages: report.pages,
    sandboxPages: report.sandboxPages,
  };
}
