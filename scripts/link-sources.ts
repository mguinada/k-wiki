import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { assertCleanTree } from "../src/data/git.ts";
import {
  closingFence,
  isWikilinkEntry,
  listWikiPages,
  unquote,
} from "../src/wiki/pages.ts";
import {
  isUnmigratableSelfCitation,
  loadSourceHubIndex,
  wikilinkFor,
} from "../src/wiki/source-hubs.ts";
import { stem } from "../src/wiki-links.ts";

/**
 * One-shot `sources` wikilink migration (issue #126, Part A): every
 * raw-path `sources` entry that a `type: source` hub covers is
 * rewritten to a clickable wikilink — plain `[[hub]]` when the path
 * is the hub's origin, aliased `[[hub|Chapter]]` when the hub's own
 * `sources` list cites the path (the multi-part-hub case; the alias
 * is the cited path's parent directory name). A no-origin hub's own
 * chapter citation is an exception: its aliased self-wikilink cannot
 * be re-derived without an origin anchor, so that entry is skipped
 * and reported, never rewritten, rather than silently drop the
 * chapter's coverage. Coverage and ambiguity
 * come from the shared hub index (src/wiki/source-hubs.ts), so the
 * migration, the guardrails, and check-provenance apply one rule.
 * Safety envelope modeled on backfill-origin (issue #88): dry-run by
 * default, `--write` refuses a tree with uncommitted changes, the
 * audit trail lands in `wiki/log.md`, and already-wikilink entries
 * are untouched (idempotent). Uncovered or ambiguous entries are
 * skipped and reported — never guessed.
 */

/** One performed (or planned) rewrite, the audit unit. */
export interface SourceRewrite {
  /** Wiki-relative page path. */
  readonly page: string;
  /** The entry as written (path form). */
  readonly entry: string;
  /** The wikilink that replaces it. */
  readonly replacement: string;
}

/** One path entry the script could not map deterministically. */
export interface SkippedEntry {
  readonly page: string;
  readonly entry: string;
  /** "no hub covers this path" or "covered by more than one hub". */
  readonly reason: string;
}

export interface LinkReport {
  readonly rewrites: readonly SourceRewrite[];
  readonly skipped: readonly SkippedEntry[];
  /** Wikilink entries found and left untouched. */
  readonly alreadyLinked: number;
}

export interface LinkOptions {
  /** Perform the rewrite; default (false) computes and reports only. */
  readonly write: boolean;
  /** The date on the `wiki/log.md` audit entry. */
  readonly date: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Colors at the render boundary; NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** Rewrite every coverable path item of one page's `sources` list,
 *  in place, only inside the frontmatter block; body text, other
 *  frontmatter lines, and wikilink entries stay byte-identical. */
function rewritePage(
  text: string,
  page: string,
  hubs: Awaited<ReturnType<typeof loadSourceHubIndex>>,
  report: {
    rewrites: SourceRewrite[];
    skipped: SkippedEntry[];
    alreadyLinked: number;
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

    if (isWikilinkEntry(entry)) {
      report.alreadyLinked += 1;

      continue;
    }

    const mapped = wikilinkFor(entry, hubs);

    if ("reason" in mapped) {
      report.skipped.push({ page, entry, reason: mapped.reason });

      continue;
    }

    if (isUnmigratableSelfCitation(stem(page), entry, hubs)) {
      report.skipped.push({
        page,
        entry,
        reason: "hub has no origin to anchor its own chapter coverage",
      });

      continue;
    }

    rewritten[i] = `${item[1] ?? ""}"${mapped.wikilink}"`;
    report.rewrites.push({ page, entry, replacement: mapped.wikilink });
  }

  return rewritten.join("\n");
}

/** Append the audit entry to `wiki/log.md` — the contract's log
 *  format, one line per rewrite — creating the log with its standard
 *  header when absent. */
async function appendLogEntry(
  wikiDir: string,
  rewrites: readonly SourceRewrite[],
  date: string,
): Promise<void> {
  const logPath = join(wikiDir, "log.md");
  let prior = "";

  try {
    prior = await readFile(logPath, "utf8");
  } catch {
    prior = "# Wiki Log\n";
  }

  const pages = new Set(rewrites.map((rewrite) => rewrite.page)).size;
  const entry = [
    "",
    `## [${date}] sources-wikilink-migration | ${pages} page${pages === 1 ? "" : "s"}`,
    "",
    ...rewrites.map(
      (rewrite) =>
        `- wiki/${rewrite.page}: "${rewrite.entry}" -> "${rewrite.replacement}"`,
    ),
  ].join("\n");

  await writeFile(
    logPath,
    `${prior}${prior.endsWith("\n") ? "" : "\n"}${entry}\n`,
  );
}

/**
 * Plan (and with `write`, perform) the wikilink migration of every
 * raw-path `sources` entry a hub covers, under `wikiDirInput`.
 * Throws when the wiki directory is missing or, on write, the tree
 * has uncommitted changes.
 */
export async function linkSources(
  wikiDirInput: string,
  options: LinkOptions,
): Promise<LinkReport> {
  const wikiDir = resolve(wikiDirInput);

  if (options.write) {
    await assertCleanTree(wikiDir, "link-sources");
  }

  const files = await listWikiPages(wikiDir);
  const hubs = await loadSourceHubIndex(wikiDir);
  const report = { rewrites: [], skipped: [], alreadyLinked: 0 };
  const rewritten = new Map<string, string>();

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");
    const next = rewritePage(text, file, hubs, report);

    if (next !== text) {
      rewritten.set(file, next);
    }
  }

  if (options.write && report.rewrites.length > 0) {
    for (const [file, text] of rewritten) {
      await writeFile(join(wikiDir, file), text);
    }

    await appendLogEntry(wikiDir, report.rewrites, options.date);
  }

  return report;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: link-sources [-h | --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]

Migrate legacy raw-path \`sources\` entries to clickable wikilinks
(issue #126): every path a \`type: source\` hub covers is rewritten —
to "[[hub]]" when the path is the hub's origin, to
"[[hub|Chapter]]" (the cited path's parent directory name) when the
hub's own \`sources\` list cites the path. Wikilink entries are left
untouched; only \`sources\` list items inside the frontmatter block
are rewritten.

  <wiki-dir>     Wiki root to scan. Default: the repo's own wiki/.
  --write        Perform the rewrite. Default: dry run — print every
                 planned rewrite, write nothing.
  --date <date>  Date on the wiki/log.md audit entry. Default: today.
  -h, --help     Print this help and exit; no side effects.

What it writes (a --write run with at least one rewrite):
  - the rewritten pages (their \`sources\` lists only);
  - an audit entry in wiki/log.md: "## [<date>]
    sources-wikilink-migration | N pages" with one "<entry> ->
    <wikilink>" line per rewrite;
  - a summary to stdout: every rewrite (green), every skipped entry
    with its reason (yellow, needs judgment — the script never
    guesses), and the totals.

Safety: --write refuses a tree with uncommitted changes (the git
diff is the review surface; git restore is the revert); outside a
git repo it warns and proceeds. Idempotent: wikilink entries are
never touched, so a re-run writes nothing. Exit 0 after a run
(skips are reported, not failed); exit 1 on bad arguments, a
missing wiki directory, or a dirty tree. NO_COLOR disables color.`;

/** link-sources entry point: `link-sources [-h | --help] [--write] [--date <YYYY-MM-DD>] [<wiki-dir>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const write = args.includes("--write");
  const dateIndex = args.indexOf("--date");
  const date =
    dateIndex === -1
      ? new Date().toISOString().slice(0, 10)
      : args[dateIndex + 1];
  const consumed = new Set<number>(
    dateIndex === -1 ? [] : [dateIndex, dateIndex + 1],
  );
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
    date === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    console.error(colors().red("link-sources: bad arguments (see --help)"));
    process.exitCode = 1;

    return;
  }

  const wikiDir = positional[0] ?? join(repoRoot, "wiki");

  try {
    const report = await linkSources(wikiDir, { write, date });

    for (const rewrite of report.rewrites) {
      console.log(
        colors().green(
          `wiki/${rewrite.page}: "${rewrite.entry}" -> "${rewrite.replacement}"`,
        ),
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
      `link-sources: ${report.rewrites.length} rewrite${report.rewrites.length === 1 ? "" : "s"}, ${report.skipped.length} skipped, ${report.alreadyLinked} already wikilinks${dry}`,
    );
  } catch (error) {
    console.error(
      colors().red(
        `link-sources: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/link-sources.ts` runs */
refuseDirectExecution(import.meta.url, "link-sources");
