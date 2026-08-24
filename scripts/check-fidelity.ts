import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { isMainModule, refuseTestWorker } from "../src/cli/is-main.ts";
import {
  kebab,
  listWikiPages,
  normalizeRawPath,
  parsePageFields,
} from "../src/wiki/pages.ts";
import { assertRawDir, printBackfillWarning } from "./check-provenance.ts";

/**
 * Citation-fidelity checker (issue #125): the deterministic tier of
 * the fidelity stack. Every machine-checkable token a `type: source`
 * page quotes — tilde paths, dotted config keys, CLI flags, `npm run`
 * commands — must appear in the page's `origin` file, and every
 * non-structural page's `title` must kebab-case to its file name.
 * Prints one `wiki/<page> -> …` line per problem and exits 1; exits 0
 * when the wiki is faithful. Relational misquotes (right tokens, wrong
 * containment) stay with the lint prompt (tier 2) and §19 review.
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Colors at the render boundary: green = ok, yellow = warning, red =
 *  problem/error; NO_COLOR yields plain text. */
function colors() {
  return createColors(!process.env.NO_COLOR);
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

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: check-fidelity [-h | --help] [<wiki-dir> [<raw-dir>]]

Check citation fidelity (issue #125): every machine-checkable token a
\`type: source\` page quotes in its body — tilde paths (\`~/…\`),
dotted config keys (\`push.pushOption\` style, file names excluded),
long and short CLI flags, and \`npm run\` commands — appears in the
page's \`origin\` file under the raw projection, and every page's
\`title\` kebab-cases to its file name (\`index\`, \`overview\`, and
\`log\` are exempt; their file names are mandated by the wiki
contract). Relational misquotes (right tokens, wrong containment)
are not detectable here — the lint prompt and diff review own them.

  <wiki-dir>    Wiki root to scan. Default: the repo's own wiki/.
  <raw-dir>     Raw projection to read origins from. Default: the
                sibling \`raw/\` of the wiki directory.
  -h, --help    Print this help and exit; no side effects.

Writes nothing. Prints one \`wiki/<page> -> …\` line per problem (red)
to stderr and exits 1; prints an ok summary (green) and exits 0 when
the wiki is faithful (an empty wiki is ok). Source pages whose origin
file is missing skip quote checking (check-provenance reports that).
When \`type: source\` pages lack \`origin\`, a yellow warning block
below the ok summary names the exact backfill-origin commands to run,
dry run first — a signal, not a gate; the exit code stays 0. NO_COLOR
disables color.`;

/** check-fidelity entry point: `check-fidelity [-h | --help] [<wiki-dir> [<raw-dir>]]` (defaults: repo wiki/, sibling raw/). */
export async function main(): Promise<void> {
  refuseTestWorker("check-fidelity");

  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  if (args.length > 2) {
    console.error(
      colors().red("check-fidelity: expected at most two arguments"),
    );
    process.exitCode = 1;

    return;
  }

  const wikiDir = args[0] ?? join(repoRoot, "wiki");
  const rawDir = args[1] ?? join(dirname(wikiDir), "raw");

  try {
    const report = await checkWikiFidelity(wikiDir, rawDir);

    if (report.problems.length === 0) {
      const quotePart = `${report.quotes} ${report.quotes === 1 ? "token traces" : "tokens trace"} to origins`;
      const titlePart = `${report.titles} ${report.titles === 1 ? "title matches" : "titles match"}`;
      const pages = `${report.pages} ${report.pages === 1 ? "page" : "pages"}`;

      console.log(
        colors().green(`ok: ${quotePart}, ${titlePart} across ${pages}`),
      );

      if (report.skipped > 0) {
        printBackfillWarning(report.skipped, wikiDir, rawDir);
      }

      return;
    }

    for (const line of report.problems) {
      console.error(colors().red(line));
    }

    process.exitCode = 1;
  } catch (error) {
    console.error(
      colors().red(
        `check-fidelity: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under `node scripts/check-fidelity.ts` */
if (isMainModule(import.meta.url)) {
  await main();
}
