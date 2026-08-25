import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
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

/** The body after a closed frontmatter block; the full text when the
 *  page opens with no frontmatter. The closing fence matches
 *  `parsePageFields` (whitespace-trimmed) so one page parses one way. */
function bodyAfterFrontmatter(text: string): string {
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    return text;
  }

  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );

  return end === -1 ? text : lines.slice(end + 1).join("\n");
}

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

/** Extract the machine-checkable artifacts from a page body: tilde
 *  paths, dotted config keys, long and short CLI flags, and `npm run`
 *  commands. Sorted and de-duplicated for deterministic output. */
export function extractArtifacts(body: string): string[] {
  const tokens = new Set<string>();

  for (const match of body.matchAll(/~\/[A-Za-z0-9_./-]+/g)) {
    tokens.add((match[0] ?? "").replace(/[./-]+$/, ""));
  }

  for (const match of body.matchAll(
    /\b[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9]*)+\b/g,
  )) {
    const token = match[0] ?? "";

    if (isConfigKey(token)) {
      tokens.add(token);
    }
  }

  for (const match of body.matchAll(/--[A-Za-z][A-Za-z0-9-]*/g)) {
    tokens.add(match[0] ?? "");
  }

  for (const match of body.matchAll(/(?<![\w-])-[A-Za-z]\b/g)) {
    tokens.add(match[0] ?? "");
  }

  for (const match of body.matchAll(/npm run [A-Za-z0-9:_-]+/g)) {
    tokens.add(match[0] ?? "");
  }

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
  let quotes = 0;
  let titles = 0;
  let skipped = 0;

  for (const file of files) {
    const text = await readFile(join(wikiDir, file), "utf8");
    const fields = parsePageFields(text);
    const page = relative(resolve(wikiDir, ".."), join(wikiDir, file));
    const stem = basename(file, ".md");

    if (fields.title !== undefined && !STRUCTURAL_PAGES.has(stem)) {
      if (kebab(fields.title) === stem) {
        titles++;
      } else {
        problems.push(
          `${page} -> title ${JSON.stringify(fields.title)} does not kebab to ${stem}`,
        );
      }
    }

    if (fields.type !== "source" || fields.origin === undefined) {
      if (fields.type === "source") {
        skipped++;
      }

      continue;
    }

    let originText: string | undefined;

    try {
      originText = await readFile(
        join(rawDir, normalizeRawPath(fields.origin)),
        "utf8",
      );
    } catch {
      // A dead origin is check-provenance's problem; nothing to
      // compare against here.
      continue;
    }

    for (const token of extractArtifacts(bodyAfterFrontmatter(text))) {
      quotes++;

      if (!appearsInOrigin(token, originText)) {
        problems.push(`${page} -> \`${token}\` not in origin ${fields.origin}`);
      }
    }
  }

  return { problems, quotes, titles, skipped, pages: files.length };
}
