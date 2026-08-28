import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  bodyAfterFrontmatter,
  kebab,
  listWikiPages,
  normalizeRawPath,
  parsePageFields,
} from "./pages.ts";
import { assertRawDir } from "./provenance.ts";

/**
 * Citation-fidelity core (issue #125): the deterministic tier of the
 * fidelity stack. Every machine-checkable token a `type: source` page
 * quotes — tilde paths, dotted config keys, CLI flags, `npm run`
 * commands — must appear in the page's `origin` file, and every
 * non-structural page's `title` must kebab-case to its file name. The
 * scripts/check-fidelity CLI renders it; the wiki-sync verification
 * stage (issue #138) runs it every cycle. Relational misquotes (right
 * tokens, wrong containment) stay with the lint prompt (tier 2) and
 * §19 review.
 */

export interface FidelityReport {
  /** One `wiki/<page> -> …` line per fidelity problem. */
  readonly problems: readonly string[];
  /** Quoted artifacts checked against origin files. */
  readonly quotes: number;
  /** Titles checked against file names. */
  readonly titles: number;
  /** `type: source` pages whose frontmatter lacks `origin`. */
  readonly skipped: number;
  /** Markdown pages scanned under the wiki root. */
  readonly pages: number;
}

/** Structural pages whose file names the wiki contract mandates;
 *  descriptive titles never kebab to them. */
const STRUCTURAL_PAGES = new Set(["index", "overview", "log"]);

/** Trailing segments that mark a dotted token as a reference, not a
 *  config key: file extensions (`sync.json`) and hostname TLDs
 *  (`dev.to`, `example.com`) — check-provenance owns path existence,
 *  and domains are provenance, not configuration. */
const TRAILING_STOPWORDS = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "yml",
  "yaml",
  "toml",
  "ini",
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "sh",
  "lock",
  "html",
  "css",
  "pdf",
  "png",
  "jpg",
  "com",
  "org",
  "net",
  "io",
  "dev",
  "to",
  "co",
  "ai",
  "app",
  "me",
  "so",
  "xyz",
  "info",
  "site",
]);

/** A dotted token is a config key when every segment is at least two
 *  characters and the trailing segment is not a stopword (`e.g` and
 *  `sync.json` are not config keys; `push.pushOption` is). */
function isConfigKey(token: string): boolean {
  const segments = token.split(".");

  return (
    segments.every((segment) => segment.length >= 2) &&
    !TRAILING_STOPWORDS.has(segments[segments.length - 1] ?? "")
  );
}

/** A tilde path contributes without its trailing punctuation. */
function tildePathToken(token: string): string {
  return token.replace(/[./-]+$/, "");
}

/** A dotted token contributes only when it is a config key. */
function configKeyToken(token: string): string | undefined {
  return isConfigKey(token) ? token : undefined;
}

/** Collect every regex match as a token, mapped through `transform`
 *  (identity by default); a transform returning undefined drops the
 *  token. */
function collectTokens(
  body: string,
  pattern: RegExp,
  tokens: Set<string>,
  transform: (match: string) => string | undefined = (match) => match,
): void {
  for (const match of body.matchAll(pattern)) {
    const token = transform(match[0] ?? "");

    if (token !== undefined) {
      tokens.add(token);
    }
  }
}

/** Extract the machine-checkable artifacts from a page body: tilde
 *  paths, dotted config keys, long and short CLI flags, and `npm run`
 *  commands. Sorted and de-duplicated for deterministic output. */
export function extractArtifacts(body: string): string[] {
  const tokens = new Set<string>();

  collectTokens(body, /~\/[A-Za-z0-9_./-]+/g, tokens, tildePathToken);
  collectTokens(
    body,
    /\b[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9]*)+\b/g,
    tokens,
    configKeyToken,
  );
  collectTokens(body, /--[A-Za-z][A-Za-z0-9-]*/g, tokens);
  collectTokens(body, /(?<![\w-])-[A-Za-z]\b/g, tokens);
  collectTokens(body, /npm run [A-Za-z0-9:_-]+/g, tokens);

  return [...tokens].sort();
}

function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A token is quoted faithfully when the origin contains it as a whole
 *  token: never as the strict prefix of a longer name (`~/.gitconfig`
 *  does not live in `~/.gitconfig-k-wiki`), but a subdirectory
 *  continuation (`/`) is containment, not a longer name. */
function appearsInOrigin(token: string, originText: string): boolean {
  return new RegExp(`${escapeRegExp(token)}(?![\\w-])(?!\\.[\\w-])`).test(
    originText,
  );
}

/** Running fidelity counters threaded through the per-page checks. */
interface FidelityCounters {
  quotes: number;
  titles: number;
  skipped: number;
}

/** Check a non-structural page's `title` kebab-cases to its file
 *  stem. */
function checkTitle(
  page: string,
  stem: string,
  title: string | undefined,
  problems: string[],
  counters: FidelityCounters,
): void {
  if (title === undefined || STRUCTURAL_PAGES.has(stem)) {
    return;
  }

  if (kebab(title) === stem) {
    counters.titles++;
  } else {
    problems.push(
      `${page} -> title ${JSON.stringify(title)} does not kebab to ${stem}`,
    );
  }
}

/** A source page's origin text, or undefined when unreadable — a
 *  dead origin is check-provenance's problem, so its page skips
 *  quote checking. */
async function readOriginText(
  rawDir: string,
  origin: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(rawDir, normalizeRawPath(origin)), "utf8");
  } catch {
    return undefined;
  }
}

/** Check every artifact quoted in a page body appears in its
 *  origin. */
function checkQuotes(
  page: string,
  text: string,
  origin: string,
  originText: string,
  problems: string[],
  counters: FidelityCounters,
): void {
  for (const token of extractArtifacts(bodyAfterFrontmatter(text))) {
    counters.quotes++;

    if (!appearsInOrigin(token, originText)) {
      problems.push(`${page} -> \`${token}\` not in origin ${origin}`);
    }
  }
}

/** Run every fidelity check for one wiki page. */
async function checkPageFidelity(
  wikiDir: string,
  rawDir: string,
  file: string,
  problems: string[],
  counters: FidelityCounters,
): Promise<void> {
  const text = await readFile(join(wikiDir, file), "utf8");
  const fields = parsePageFields(text);
  const page = relative(resolve(wikiDir, ".."), join(wikiDir, file));

  checkTitle(page, basename(file, ".md"), fields.title, problems, counters);

  if (fields.type !== "source" || fields.origin === undefined) {
    if (fields.type === "source") {
      counters.skipped++;
    }

    return;
  }

  const originText = await readOriginText(rawDir, fields.origin);

  if (originText === undefined) {
    return;
  }

  checkQuotes(page, text, fields.origin, originText, problems, counters);
}

/**
 * Check every wiki page under `wikiDirInput` against the raw
 * projection at `rawDirInput`, reporting problems with paths relative
 * to the wiki root's parent directory. Source pages with a readable
 * `origin` have their quoted artifacts verified against the origin
 * file; a missing origin file is check-provenance's problem, so its
 * page skips quote checking (the title check still runs). Agent
 * contract files (AGENTS.md) are not wiki pages and are skipped.
 * Throws when either directory is missing.
 */
export async function checkWikiFidelity(
  wikiDirInput: string,
  rawDirInput: string,
): Promise<FidelityReport> {
  const wikiDir = resolve(wikiDirInput);
  const rawDir = resolve(rawDirInput);

  // listWikiPages asserts the wiki directory itself; only the raw
  // side needs its own check here.
  const files = await listWikiPages(wikiDir);

  await assertRawDir(rawDir);
  const problems: string[] = [];
  const counters: FidelityCounters = { quotes: 0, titles: 0, skipped: 0 };

  for (const file of files) {
    await checkPageFidelity(wikiDir, rawDir, file, problems, counters);
  }

  return {
    problems,
    quotes: counters.quotes,
    titles: counters.titles,
    skipped: counters.skipped,
    pages: files.length,
  };
}

/** The report's summary sentence — quote tokens traced to origins and
 *  titles matched — shared by the check-fidelity CLI's ok line and
 *  the wiki-sync digest (issue #138), so the two surfaces cannot
 *  drift apart. */
export function summarizeFidelity(report: FidelityReport): string {
  const tokens = `${report.quotes} ${report.quotes === 1 ? "token traces" : "tokens trace"} to origins`;
  const titles = `${report.titles} ${report.titles === 1 ? "title matches" : "titles match"}`;

  return `${tokens}, ${titles} across ${report.pages} ${report.pages === 1 ? "page" : "pages"}`;
}
