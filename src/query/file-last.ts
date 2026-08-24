import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runGit } from "../data/init-data-repo.ts";
import { listWikiPages, readPageFields } from "../wiki/pages.ts";
import { buildPageIndex, extractWikilinks } from "../wiki-links.ts";

/**
 * wiki-query stage 2 (issue #72): deterministic filing of the saved
 * stage-1 answer. No LLM is involved — TypeScript reads
 * `outputs/last-query.md`, templates the answer byte-exactly into
 * `wiki/queries/<slug>.md`, and appends the `index.md` and `log.md`
 * entries. Stage 1's answer is the single source; this module only
 * wraps it. A drift warning fires when the data repo's `raw/` or
 * `wiki/` moved after the saved timestamp — the answer cites pages
 * that may have changed.
 */

/** What stage 1 persisted to outputs/last-query.md. */
export interface QueryArtifact {
  /** The question as asked, verbatim. */
  readonly question: string;
  /** When the answer was saved, ISO 8601. */
  readonly timestamp: string;
  /** The wikilink page names the answer cites, sorted. */
  readonly pages: readonly string[];
  /** The answer, byte-exact. */
  readonly answer: string;
}

const BAD_ARTIFACT = "not a wiki-query artifact";

/**
 * Render the artifact: a frontmatter block (single-line JSON values,
 * so any question round-trips) and the answer as the body.
 */
export function renderQueryArtifact(artifact: QueryArtifact): string {
  return [
    "---",
    `question: ${JSON.stringify(artifact.question)}`,
    `timestamp: ${JSON.stringify(artifact.timestamp)}`,
    `pages: ${JSON.stringify(artifact.pages)}`,
    "---",
    "",
    artifact.answer,
    "",
  ].join("\n");
}

/**
 * Parse the artifact text. Strict: exactly the three header keys with
 * JSON values, a closed frontmatter block, and the answer as the body
 * (one blank line stripped after the block, one trailing newline
 * stripped). Everything else is `not a wiki-query artifact`.
 */
export function parseQueryArtifact(text: string): QueryArtifact {
  const lines = text.split("\n");
  const bad = (why: string): Error => new Error(`${BAD_ARTIFACT}: ${why}`);

  if (lines[0] !== "---") {
    throw bad("no frontmatter block");
  }

  const close = lines.indexOf("---", 1);

  if (close === -1) {
    throw bad("unterminated frontmatter block");
  }

  let question: string | undefined;
  let timestamp: string | undefined;
  let pages: readonly string[] | undefined;

  for (const line of lines.slice(1, close)) {
    const match = /^(question|timestamp|pages): (.+)$/.exec(line);

    if (match === null) {
      throw bad(`malformed header line ${JSON.stringify(line)}`);
    }

    try {
      const value = JSON.parse(match[2] ?? "");

      if (match[1] === "question" && typeof value === "string") {
        question = value;
      } else if (match[1] === "timestamp" && typeof value === "string") {
        timestamp = value;
      } else if (
        match[1] === "pages" &&
        Array.isArray(value) &&
        value.every((page) => typeof page === "string")
      ) {
        pages = value;
      }
    } catch {
      throw bad(`malformed header line ${JSON.stringify(line)}`);
    }
  }

  if (
    question === undefined ||
    timestamp === undefined ||
    pages === undefined
  ) {
    throw bad("missing question, timestamp, or pages header");
  }

  if (Number.isNaN(Date.parse(timestamp))) {
    throw bad(`timestamp ${JSON.stringify(timestamp)} is not a date`);
  }

  const answer = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "");

  return { question, timestamp, pages, answer };
}

/** Read and parse the artifact; missing file names the remedy. */
export async function readQueryArtifact(path: string): Promise<QueryArtifact> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `no saved answer at ${path} — run wiki-query "<question>" first`,
    );
  }

  return parseQueryArtifact(text);
}

/** Persist the artifact, creating the outputs directory. */
export async function writeQueryArtifact(
  path: string,
  artifact: QueryArtifact,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderQueryArtifact(artifact), "utf8");
}

/** The wikilink page names the answer cites, each once, sorted. */
export function citedPages(answer: string): string[] {
  return [
    ...new Set(extractWikilinks(answer).map((link) => link.target)),
  ].sort();
}

/**
 * The cited pages that exist and are `type: source` (wiki/AGENTS.md:
 * `sources` lists only source pages). Deterministic: page files and
 * their frontmatter, nothing interpreted.
 */
export async function citedSourcePages(
  wikiDir: string,
  pages: readonly string[],
): Promise<string[]> {
  if (pages.length === 0) {
    return [];
  }

  const index = buildPageIndex(await listWikiPages(wikiDir));
  const sources: string[] = [];

  for (const name of pages) {
    const file = index.get(name);

    if (file === undefined) {
      continue;
    }

    if ((await readPageFields(join(wikiDir, file))).type === "source") {
      sources.push(name);
    }
  }

  return sources.sort();
}

/** Longest slug; questions can be long, file names should not be. */
const MAX_SLUG = 80;

/** Kebab-case slug from the question; `query` when nothing survives. */
export function slugForQuestion(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");

  return slug === "" ? "query" : slug;
}

/** True when the path exists; keeps this module's IO non-blocking. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/** The first free `wiki/queries/<slug>.md` name; -2, -3, … on collision. */
async function queryPagePath(
  wikiDir: string,
  question: string,
): Promise<string> {
  const slug = slugForQuestion(question);

  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const name = `${slug}${attempt === 1 ? "" : `-${attempt}`}.md`;

    if (!(await exists(join(wikiDir, "queries", name)))) {
      return `wiki/queries/${name}`;
    }
  }

  throw new Error(
    `cannot file the query: 999 pages already share the slug ${JSON.stringify(slug)}`,
  );
}

/** One line: the question in headings, entries, and log headings. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Render the filed query page: guide §9 frontmatter, then the answer. */
export function templateQueryPage(
  artifact: QueryArtifact,
  options: { created: string; updated: string; sources: readonly string[] },
): string {
  return [
    "---",
    `title: ${JSON.stringify(oneLine(artifact.question))}`,
    "type: query",
    `question: ${JSON.stringify(artifact.question)}`,
    `created: ${options.created}`,
    `updated: ${options.updated}`,
    "tags:",
    "  - query",
    ...(options.sources.length === 0
      ? ["sources: []"]
      : [
          "sources:",
          ...options.sources.map(
            (source) => `  - ${JSON.stringify(`[[${source}]]`)}`,
          ),
        ]),
    "---",
    "",
    `# ${oneLine(artifact.question)}`,
    "",
    artifact.answer,
    "",
  ].join("\n");
}

/** The index.md one-line entry for a filed query page. */
export function indexEntryFor(slug: string, question: string): string {
  return `- [[${slug}]] — ${oneLine(question)}`;
}

/**
 * Insert the entry directly under the `## Queries` heading; append a
 * `## Queries` section when the index has none — a missing index is
 * created with its heading, like the log. Both deterministic.
 */
export function appendIndexEntry(indexText: string, entry: string): string {
  const lines = indexText.split("\n");
  const heading = lines.indexOf("## Queries");

  if (heading !== -1) {
    lines.splice(heading + 1, 0, entry);

    return lines.join("\n");
  }

  if (indexText === "") {
    return `# Wiki Index\n\n## Queries\n\n${entry}\n`;
  }

  const prefix = indexText.endsWith("\n") ? indexText : `${indexText}\n`;

  return `${prefix}\n## Queries\n\n${entry}\n`;
}

/** The log.md entry heading (guide §12 format). */
export function logEntry(question: string, date: string): string {
  return `## [${date}] query | ${oneLine(question)}`;
}

/** A file's text, or "" when the path is absent — the caller's
 *  default for a wiki (index/log) that does not exist yet. */
async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Append the log entry, creating the log with its heading if absent. */
function appendLogEntry(logText: string, entry: string): string {
  const prefix =
    logText === ""
      ? "# Wiki Log\n"
      : logText.endsWith("\n")
        ? logText
        : `${logText}\n`;

  return `${prefix}\n${entry}\n`;
}

/**
 * The drift warning for a filing (issue #72): `raw/` or `wiki/` was
 * committed after the answer was saved, so pages it cites may have
 * moved. Undefined when git cannot report or nothing moved.
 */
export async function driftWarning(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  savedTimestamp: string,
): Promise<string | undefined> {
  let stdout: string;

  try {
    ({ stdout } = await runGit(
      dataRoot,
      ["log", "-1", "--format=%cI", "--", "raw", "wiki"],
      env,
    ));
  } catch {
    return undefined;
  }

  const last = stdout.trim();

  if (last === "") {
    return undefined;
  }

  const changedAt = Date.parse(last);

  if (Number.isNaN(changedAt) || changedAt <= Date.parse(savedTimestamp)) {
    return undefined;
  }

  return `warning: the data repo changed after the saved answer (${last} touched raw/ or wiki/); pages it cites may have moved`;
}

export interface FileLastOptions {
  /** Path of outputs/last-query.md. */
  readonly artifactPath: string;
  /** The data repo root (raw/'s parent, wiki/'s parent). */
  readonly dataRoot: string;
  /** Environment for child processes; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock for the filing date; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Progress sink (uncolored messages); default: silent. */
  readonly onProgress?: (message: string) => void;
}

export interface FileLastResult {
  /** The filed page, data-repo relative (`wiki/queries/<slug>.md`). */
  readonly pagePath: string;
  /** The drift warning, when the wiki moved since the answer. */
  readonly warning: string | undefined;
}

/**
 * File the saved answer: read the artifact, warn on drift, claim a
 * free slug, template the page, and update index.md and log.md. Zero
 * LLM involvement; every input comes from the artifact and the wiki.
 */
export async function fileLastQuery(
  options: FileLastOptions,
): Promise<FileLastResult> {
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? (() => {});
  const artifact = await readQueryArtifact(options.artifactPath);
  const warning = await driftWarning(options.dataRoot, env, artifact.timestamp);

  if (warning !== undefined) {
    onProgress(warning);
  }

  const wikiDir = join(options.dataRoot, "wiki");
  const pagePath = await queryPagePath(wikiDir, artifact.question);
  const slug = basename(pagePath, ".md");
  const date = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const sources = await citedSourcePages(wikiDir, artifact.pages);

  await mkdir(join(wikiDir, "queries"), { recursive: true });
  await writeFile(
    join(options.dataRoot, pagePath),
    templateQueryPage(artifact, { created: date, updated: date, sources }),
    "utf8",
  );

  const indexText = await readTextIfExists(join(wikiDir, "index.md"));

  await writeFile(
    join(wikiDir, "index.md"),
    appendIndexEntry(indexText, indexEntryFor(slug, artifact.question)),
    "utf8",
  );

  const logText = await readTextIfExists(join(wikiDir, "log.md"));

  await writeFile(
    join(wikiDir, "log.md"),
    appendLogEntry(logText, logEntry(artifact.question, date)),
    "utf8",
  );

  return { pagePath, warning };
}
