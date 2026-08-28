import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isIsoDate, readDateFlag } from "../src/cli/flag-args.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { assertCleanTree } from "../src/data/git.ts";
import {
  appendWikiLog,
  closingFence,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  parsePageFields,
} from "../src/wiki/pages.ts";

/**
 * Deterministic origin backfill (guide §14a, issue #88): every
 * `type: source` page whose frontmatter lacks `origin`, whose
 * `sources` cites exactly one path that exists under `raw/`, and
 * whose title corroborates that note's name, gets
 * `origin: raw/<path>` written and `updated` bumped. Anything less
 * certain is skipped and reported for judgment — the script never
 * guesses a pairing. Safety envelope: dry-run mode writes nothing;
 * a real run refuses a wiki tree with uncommitted changes (the git
 * diff is the review surface, `git restore` the revert); every
 * backfilled pair is appended to `wiki/log.md` as an audit trail.
 * Idempotent: pages that already carry `origin` are untouched.
 */

/** One page the script could not pair deterministically. */
export interface NeedsJudgment {
  /** Wiki-relative page path. */
  readonly page: string;
  /** Why: "N verifiable raw paths" or a title-corroboration failure. */
  readonly reason: string;
}

/** One backfilled pairing, the audit unit for stdout and log.md. */
export interface BackfilledPair {
  readonly page: string;
  readonly origin: string;
}

export interface BackfillReport {
  readonly backfilled: readonly BackfilledPair[];
  readonly needsJudgment: readonly NeedsJudgment[];
  /** `type: source` pages skipped because they already carry `origin`. */
  readonly untouched: number;
}

export interface BackfillOptions {
  /** The date written into each bumped `updated` field. */
  readonly date: string;
  /** Compute and report the pairs without writing any file. */
  readonly dryRun?: boolean | undefined;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Colors at the render boundary; NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "or",
  "to",
  "in",
  "on",
  "with",
  "from",
  "by",
  "is",
]);

/** Lowercased significant tokens (≥3 chars, no stopwords) of a title or file name. */
function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\(source\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

/**
 * The title-corroboration gate: the page title and the note file name
 * must share at least two significant tokens, or one long (≥7 chars)
 * token. Both sides come from the same convention (source-page titles
 * restate their note's name), so a legitimate pair passes easily; a
 * page citing an unrelated note fails and lands in needs-judgment.
 */
function corroboratesTitle(pageTitle: string, noteName: string): boolean {
  const note = significantTokens(noteName.replace(/\.md$/, ""));
  const shared = [...significantTokens(pageTitle)].filter((token) =>
    note.has(token),
  );

  return shared.length >= 2 || shared.some((token) => token.length >= 7);
}

/**
 * Insert `origin` as the last frontmatter line and bump `updated` —
 * only within the frontmatter block; a body line starting with
 * `updated:` is left alone. An existing empty-value `origin:` line is
 * replaced in place, so a re-run sees exactly one origin line and
 * stays idempotent.
 */
function rewrite(text: string, rawPath: string, date: string): string {
  const lines = text.split("\n");
  const closing = closingFence(lines);
  const emptyOrigin = lines.findIndex(
    (line, index) => index >= 1 && index < closing && /^origin:\s*$/.test(line),
  );

  if (emptyOrigin === -1) {
    lines.splice(closing, 0, `origin: raw/${rawPath}`);
  } else {
    lines[emptyOrigin] = `origin: raw/${rawPath}`;
  }

  const updated = lines.findIndex(
    (line, index) =>
      index >= 1 && index <= closing && line.startsWith("updated:"),
  );

  if (updated !== -1) {
    lines[updated] = `updated: ${date}`;
  }

  return lines.join("\n");
}

/** True when the path exists; false on any stat error. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

/** Assert a directory exists; name it in the thrown error otherwise. */
async function assertDirectory(dir: string, label: string): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    throw new Error(`${label} directory does not exist: ${dir}`);
  }

  if (!isDirectory) {
    throw new Error(`${label} directory is not a directory: ${dir}`);
  }
}

/**
 * Append the audit entry to `wiki/log.md` in the contract's format
 * (`## [date] origin-backfill | N pages` plus one pair per line),
 * creating the log with its standard header when absent.
 */
async function appendLogEntry(
  wikiDir: string,
  pairs: readonly BackfilledPair[],
  date: string,
): Promise<void> {
  const logPath = join(wikiDir, "log.md");
  let prior = "";

  try {
    prior = await readFile(logPath, "utf8");
  } catch {
    prior = "";
  }

  const count = pairs.length;
  const entry = [
    `## [${date}] origin-backfill | ${count} page${count === 1 ? "" : "s"}`,
    "",
    ...pairs.map((pair) => `- wiki/${pair.page} -> ${pair.origin}`),
  ].join("\n");

  await writeFile(logPath, appendWikiLog(prior, entry));
}

/**
 * Backfill `origin` on every deterministic-pairable source page under
 * `wikiDirInput`, resolving candidate paths against `rawDirInput`.
 * Throws when either directory is missing.
 */
export async function backfillOrigins(
  wikiDirInput: string,
  rawDirInput: string,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const wikiDir = resolve(wikiDirInput);
  const rawDir = resolve(rawDirInput);

  await assertDirectory(wikiDir, "wiki");
  await assertDirectory(rawDir, "raw");

  const files = await listWikiPages(wikiDir);
  const backfilled: BackfilledPair[] = [];
  const needsJudgment: NeedsJudgment[] = [];
  let untouched = 0;

  for (const file of files.sort()) {
    const pagePath = join(wikiDir, file);
    const text = await readFile(pagePath, "utf8");
    const fields = parsePageFields(text);

    if (fields.type !== "source") {
      continue;
    }

    if (fields.origin !== undefined) {
      untouched++;

      continue;
    }

    const verifiable: string[] = [];

    for (const entry of fields.sources) {
      if (
        !isWikilinkEntry(entry) &&
        (await exists(join(rawDir, normalizeRawPath(entry))))
      ) {
        verifiable.push(normalizeRawPath(entry));
      }
    }

    if (verifiable.length !== 1) {
      needsJudgment.push({
        page: file,
        reason: `${verifiable.length} verifiable raw paths`,
      });

      continue;
    }

    const rawPath = verifiable[0] ?? "";

    if (!corroboratesTitle(fields.title ?? "", basename(rawPath))) {
      needsJudgment.push({
        page: file,
        reason: `title does not corroborate note name ${JSON.stringify(basename(rawPath))}`,
      });

      continue;
    }

    if (options.dryRun !== true) {
      await writeFile(pagePath, rewrite(text, rawPath, options.date));
    }

    backfilled.push({ page: file, origin: `raw/${rawPath}` });
  }

  if (options.dryRun !== true && backfilled.length > 0) {
    await appendLogEntry(wikiDir, backfilled, options.date);
  }

  return { backfilled, needsJudgment, untouched };
}

/** The git safety gate, shared with link-sources: a real (non-dry)
 *  run refuses a wiki tree with uncommitted changes — the review
 *  surface is a clean git diff and the revert is `git restore`.
 *  Outside a git repo there is no safety net: warn and proceed. The
 *  shared helper resolves the repo root from the wiki dir first,
 *  because runGit confines repository discovery to its dir argument
 *  (the live-run lesson recorded in src/data/git.ts). */
async function assertCleanWiki(
  wikiDir: string,
  dryRun: boolean,
): Promise<void> {
  if (!dryRun) {
    await assertCleanTree(wikiDir, "backfill-origin");
  }
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: backfill-origin [-h | --help] [--dry-run] [--date <YYYY-MM-DD>] [<wiki-dir> [<raw-dir>]]

Backfill the deterministic origin field (guide 14a) on every
type: source page whose frontmatter lacks it. A page is backfilled
only when it passes every gate:

  1. its sources cite exactly one path that exists under raw/;
  2. its title corroborates that note's file name (shared tokens).

Anything else — zero or several verifiable paths, wikilink-only
sources, title mismatch — is skipped and reported for manual or
agent pairing. The script never guesses a pairing.

  <wiki-dir>     Wiki root to scan. Default: the repo's own wiki/.
  <raw-dir>      Raw projection to resolve paths against. Default:
                 the sibling raw/ of the wiki directory.
  --date <date>  Date written into each bumped updated field.
                 Default: today.
  --dry-run      Report every pairing decision and write nothing —
                 not the pages, not the log entry.
  -h, --help     Print this help and exit; no side effects.

What it writes (a real run only):
  - origin (and updated) frontmatter lines on the paired pages;
  - an audit entry in wiki/log.md: "## [<date>] origin-backfill |
    N pages" with one "<page> -> <origin>" line per pairing;
  - a summary to stdout: backfilled pairs, pages needing judgment
    with their reason, untouched count.

Safety: a real run refuses a wiki tree with uncommitted changes
(the git diff is the review surface; git restore is the revert);
outside a git repo it warns and proceeds. Idempotent: a page that
already carries origin is untouched, so a re-run writes nothing.
Exit 0 after a run (skips are reported, not failed); exit 1 when a
directory is missing or the wiki tree is dirty. NO_COLOR disables
color.`;

/** backfill-origin entry point: `backfill-origin [-h | --help] [--dry-run] [--date <YYYY-MM-DD>] [<wiki-dir> [<raw-dir>]]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const dryRun = args.includes("--dry-run");
  const { date, consumed } = readDateFlag(args);
  const positional: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (arg === "--dry-run" || consumed.has(index)) {
      continue;
    }

    positional.push(arg);
  }

  if (
    positional.length > 2 ||
    (positional.length > 0 && positional.some((arg) => arg.startsWith("--"))) ||
    !isIsoDate(date)
  ) {
    console.error(colors().red("backfill-origin: bad arguments (see --help)"));
    process.exitCode = 1;

    return;
  }

  const wikiDir = positional[0] ?? join(repoRoot, "wiki");
  const rawDir = positional[1] ?? join(dirname(wikiDir), "raw");

  try {
    await assertCleanWiki(wikiDir, dryRun);

    const report = await backfillOrigins(wikiDir, rawDir, {
      date,
      dryRun,
    });

    for (const pair of report.backfilled) {
      console.log(colors().green(`wiki/${pair.page} -> ${pair.origin}`));
    }

    for (const skip of report.needsJudgment) {
      console.error(
        colors().yellow(`needs judgment: wiki/${skip.page} (${skip.reason})`),
      );
    }

    const dry = dryRun ? ", dry run — nothing written" : "";

    console.log(
      `backfill: ${report.backfilled.length} backfilled, ${report.needsJudgment.length} need judgment, ${report.untouched} already had origin${dry}`,
    );
  } catch (error) {
    console.error(
      colors().red(
        `backfill-origin: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/backfill-origin.ts` runs */
refuseDirectExecution(import.meta.url, "backfill-origin");
