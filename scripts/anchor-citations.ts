import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { isIsoDate, readDateFlag } from "../src/cli/flag-args.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { assertCleanTree } from "../src/data/git.ts";
import { insertChapterHeadings } from "../src/wiki/chapter-headings.ts";
import {
  appendWikiLog,
  closingFence,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  type PageFields,
  unquote,
  wikilinkTarget,
} from "../src/wiki/pages.ts";
import {
  citationAlias,
  citationChapter,
  loadSourceHubIndex,
} from "../src/wiki/source-hubs.ts";
import { stem } from "../src/wiki-links.ts";

/**
 * One-shot chapter-anchor migration: every aliased hub citation
 * (`[[hub|Chapter]]`, the pre-anchor migrated form) is rewritten to
 * the anchored form (`[[hub#Chapter]]`), and every hub body gains one
 * generated heading per cited chapter — byte-identical to the anchor,
 * the only way irregular-whitespace chapter names resolve. A hub's
 * chapter set derives from its own `sources` citation list, so both
 * halves stay in step. Aliases that name no chapter of their hub
 * (display aliases) are skipped and reported, never guessed; aliases
 * to non-source pages are untouched; so is a cited chapter whose
 * generated heading does not round-trip in the hub body (an
 * unclosed code fence, a chapter name no heading carries
 * byte-identically). Safety envelope modeled on
 * link-sources: dry run by default, `--write` refuses a tree with
 * uncommitted changes, the audit trail lands in `wiki/log.md`
 * (wiki/log.md itself is never rewritten: only `sources` lists
 * inside a frontmatter block are), and a re-run over migrated data
 * changes nothing (idempotent).
 */

/** One performed (or planned) citation rewrite, the audit unit. */
export interface AnchorRewrite {
  /** Wiki-relative page path. */
  readonly page: string;
  /** The aliased entry as written. */
  readonly entry: string;
  /** The anchored wikilink that replaces it. */
  readonly replacement: string;
}

/** One aliased citation the script could not map to a chapter. */
export interface AnchorSkip {
  readonly page: string;
  readonly entry: string;
  readonly reason: string;
}

/** One heading skeleton appended to a hub body. */
export interface AnchorHeading {
  readonly page: string;
  /** The chapter (== heading text) added. */
  readonly chapter: string;
}

export interface AnchorReport {
  readonly rewrites: readonly AnchorRewrite[];
  readonly skipped: readonly AnchorSkip[];
  readonly headings: readonly AnchorHeading[];
}

export interface AnchorOptions {
  /** Perform the migration; default (false) computes and reports only. */
  readonly write: boolean;
  /** The date on the `wiki/log.md` audit entry. */
  readonly date: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The chapters a hub's own `sources` list cites, in citation order:
 *  the self-wikilink chapter of each wikilink entry plus the parent
 *  directory name of each raw-path entry other than the hub's own
 *  origin (the origin migrates to a plain self-link, not a chapter)
 *  — the citation-alias rule, the same string an anchored citation
 *  and its heading must carry. */
function chapterSet(name: string, fields: PageFields): string[] {
  const chapters: string[] = [];
  const origin =
    fields.origin === undefined ? undefined : normalizeRawPath(fields.origin);

  for (const entry of fields.sources) {
    const chapter = isWikilinkEntry(entry)
      ? wikilinkTarget(entry) === name
        ? citationChapter(entry)
        : undefined
      : normalizeRawPath(entry) === origin
        ? undefined
        : citationAlias(normalizeRawPath(entry));

    if (chapter !== undefined) {
      chapters.push(chapter);
    }
  }

  return [...new Set(chapters)];
}

/** Rewrite every aliased chapter citation of one page's `sources`
 *  list to the anchored form, in place, only inside the frontmatter
 *  block; body text, other frontmatter lines, anchored entries, and
 *  aliases that name no chapter stay byte-identical. */
function rewritePage(
  text: string,
  page: string,
  chaptersByHub: ReadonlyMap<string, ReadonlySet<string>>,
  isSource: (page: string) => boolean,
  report: {
    rewrites: AnchorRewrite[];
    skipped: AnchorSkip[];
  },
): string {
  const lines = text.split("\n");
  const closing = closingFence(lines);
  const start = lines.findIndex(
    (line, index) => index < closing && line.startsWith("sources:"),
  );

  if (closing === -1 || start === -1) {
    return text;
  }

  const rewritten = [...lines];

  for (let i = start + 1; i < closing; i += 1) {
    const line = lines[i] ?? "";

    if (/^\S/.test(line)) {
      break;
    }

    const item = /^(\s+-\s+)(.+)$/.exec(line);

    if (item === null) {
      continue;
    }

    const entry = unquote(item[2]?.trim() ?? "");
    const body = entry.slice(2, -2);

    if (!isWikilinkEntry(entry) || !body.includes("|") || body.includes("#")) {
      continue;
    }

    const [targetPart, aliasPart] = body.split("|");
    const target = targetPart?.trim() ?? "";
    const alias = aliasPart?.trim() ?? "";

    if (!isSource(target)) {
      continue;
    }

    if (!chaptersByHub.get(target)?.has(alias)) {
      report.skipped.push({
        page,
        entry,
        reason: "alias does not name a chapter of this hub",
      });

      continue;
    }

    const replacement = `[[${target}#${alias}]]`;

    rewritten[i] = `${item[1] ?? ""}"${replacement}"`;
    report.rewrites.push({ page, entry, replacement });
  }

  return rewritten.join("\n");
}

/** Append the audit entry to `wiki/log.md` — one line per rewrite and
 *  per inserted heading — creating the log with its standard header
 *  when absent. */
async function appendLogEntry(
  wikiDir: string,
  report: AnchorReport,
  date: string,
): Promise<void> {
  const logPath = join(wikiDir, "log.md");
  let prior = "";

  try {
    prior = await readFile(logPath, "utf8");
  } catch {
    prior = "";
  }

  const pages = new Set([
    ...report.rewrites.map((rewrite) => rewrite.page),
    ...report.headings.map((heading) => heading.page),
  ]).size;
  const entry = [
    `## [${date}] anchor-citations-migration | ${pages} page${pages === 1 ? "" : "s"}`,
    "",
    ...report.rewrites.map(
      (rewrite) =>
        `- wiki/${rewrite.page}: "${rewrite.entry}" -> "${rewrite.replacement}"`,
    ),
    ...report.headings.map(
      (heading) => `- wiki/${heading.page}: + "## ${heading.chapter}"`,
    ),
  ].join("\n");

  await writeFile(logPath, appendWikiLog(prior, entry));
}

/**
 * Plan (and with `write`, perform) the chapter-anchor migration under
 * `wikiDirInput`: anchored citations plus generated hub headings.
 * Throws when the wiki directory is missing or, on write, the tree
 * has uncommitted changes.
 */
export async function anchorCitations(
  wikiDirInput: string,
  options: AnchorOptions,
): Promise<AnchorReport> {
  const wikiDir = resolve(wikiDirInput);

  if (options.write) {
    await assertCleanTree(wikiDir, "anchor-citations");
  }

  const files = await listWikiPages(wikiDir);
  const hubs = await loadSourceHubIndex(wikiDir);
  const chaptersByHub = new Map<string, ReadonlySet<string>>();

  for (const [name, fields] of hubs.fields) {
    if (fields.type === "source") {
      chaptersByHub.set(name, new Set(chapterSet(name, fields)));
    }
  }

  const isSource = (page: string): boolean =>
    hubs.fields.get(page)?.type === "source";

  const report = {
    rewrites: [] as AnchorRewrite[],
    skipped: [] as AnchorSkip[],
    headings: [] as AnchorHeading[],
  };
  const written = new Map<string, string>();

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");
    let next = rewritePage(text, file, chaptersByHub, isSource, report);
    const name = stem(file);

    if (isSource(name)) {
      const insertion = insertChapterHeadings(next, [
        ...(chaptersByHub.get(name) ?? []),
      ]);

      for (const chapter of insertion.added) {
        report.headings.push({ page: file, chapter });
      }

      for (const chapter of insertion.skipped) {
        report.skipped.push({
          page: file,
          entry: `[[${name}#${chapter}]]`,
          reason:
            "generated heading does not resolve in the hub body (unclosed code fence or unrepresentative chapter name)",
        });
      }

      next = insertion.text;
    }

    if (next !== text) {
      written.set(file, next);
    }
  }

  if (
    options.write &&
    (report.rewrites.length > 0 || report.headings.length > 0)
  ) {
    for (const [file, text] of written) {
      await writeFile(join(wikiDir, file), text);
    }

    await appendLogEntry(wikiDir, report, options.date);
  }

  return report;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: anchor-citations [-h | --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]

Migrate aliased hub chapter citations to anchored, navigable ones:
every "[[hub|Chapter]]" entry in a sources list whose alias names a
chapter of that hub is rewritten to "[[hub#Chapter]]", and every hub
body gains one generated heading ("## Chapter") per cited chapter —
byte-identical to the anchor, so irregular chapter names resolve.
Only sources list items inside a frontmatter block are rewritten;
body text and wiki/log.md stay untouched.

  <wiki-dir>     Wiki root to scan. Default: the repo's own wiki/.
  --write        Perform the migration. Default: dry run — print every
                 planned change, write nothing.
  --date <date>  Date on the wiki/log.md audit entry. Default: today.
  -h, --help     Print this help and exit; no side effects.

What it writes (a --write run with at least one change):
  - the rewritten pages (their sources lists) and the hub pages that
    gained headings;
  - an audit entry in wiki/log.md: "## [<date>]
    anchor-citations-migration | N pages" with one line per rewrite
    ("entry -> anchored wikilink") and per heading (+ "## Chapter");
  - a summary to stdout: every rewrite (green), every inserted
    heading (green), every skipped alias or heading with its reason
    (yellow, needs judgment — the script never guesses), and the
    totals.

Safety: --write refuses a tree with uncommitted changes (the git
diff is the review surface; git restore is the revert); outside a
git repo it warns and proceeds. Idempotent: anchored entries and
existing headings are never touched, so a re-run writes nothing.
Exit 0 after a run (skips are reported, not failed); exit 1 on bad
arguments, a missing wiki directory, or a dirty tree. NO_COLOR
disables color.`;

/** anchor-citations entry point: `anchor-citations [-h | --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const write = args.includes("--write");
  const { date, consumed } = readDateFlag(args);
  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (arg === "--write" || consumed.has(index)) {
      continue;
    }

    positional.push(arg);
  }

  if (
    positional.length > 1 ||
    (positional.length > 0 && positional[0]?.startsWith("--")) ||
    !isIsoDate(date)
  ) {
    console.error(colors().red("anchor-citations: bad arguments (see --help)"));
    process.exitCode = 1;

    return;
  }

  const wikiDir = positional[0] ?? join(repoRoot, "wiki");

  try {
    const report = await anchorCitations(wikiDir, { write, date });

    for (const rewrite of report.rewrites) {
      console.log(
        colors().green(
          `wiki/${rewrite.page}: "${rewrite.entry}" -> "${rewrite.replacement}"`,
        ),
      );
    }

    for (const heading of report.headings) {
      console.log(
        colors().green(`wiki/${heading.page}: + "## ${heading.chapter}"`),
      );
    }

    for (const skip of report.skipped) {
      console.error(
        colors().yellow(
          `needs judgment: wiki/${skip.page}: "${skip.entry}" (${skip.reason})`,
        ),
      );
    }

    const dry = write
      ? ""
      : " — dry run, nothing written; re-run with --write to apply";

    console.log(
      `anchor-citations: ${report.rewrites.length} rewrite${report.rewrites.length === 1 ? "" : "s"}, ${report.headings.length} heading${report.headings.length === 1 ? "" : "s"}, ${report.skipped.length} skipped${dry}`,
    );
  } catch (error) {
    console.error(colors().red(`anchor-citations: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/anchor-citations.ts` runs */
refuseDirectExecution(import.meta.url, "anchor-citations");
