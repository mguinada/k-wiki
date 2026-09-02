import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { parseStatus, runGit } from "../data/git.ts";
import {
  appendWikiLog,
  kebab,
  listWikiPages,
  readPageFields,
} from "../wiki/pages.ts";
import { buildPageIndex, extractWikilinks } from "../wiki/wiki-links.ts";

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

/** The strict-parse failure for every malformed artifact. */
function headerError(why: string): Error {
  return new Error(`${BAD_ARTIFACT}: ${why}`);
}

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

/** One frontmatter header line split into its key and JSON value. */
function parseHeaderLine(line: string): { key: string; value: string } {
  const match = /^(question|timestamp|pages): (.+)$/.exec(line);

  if (match === null) {
    throw headerError(`malformed header line ${JSON.stringify(line)}`);
  }

  return { key: match[1] ?? "", value: match[2] ?? "" };
}

/** The header line's JSON value; malformed JSON is a malformed line. */
function parseHeaderValue(line: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw headerError(`malformed header line ${JSON.stringify(line)}`);
  }
}

/** The three header values found in the frontmatter block, if any. */
function readHeaders(lines: readonly string[]): {
  question: string | undefined;
  timestamp: string | undefined;
  pages: readonly string[] | undefined;
} {
  let question: string | undefined;
  let timestamp: string | undefined;
  let pages: readonly string[] | undefined;

  for (const line of lines) {
    const { key, value } = parseHeaderLine(line);
    const parsed = parseHeaderValue(line, value);

    if (key === "question" && typeof parsed === "string") {
      question = parsed;
    } else if (key === "timestamp" && typeof parsed === "string") {
      timestamp = parsed;
    } else if (
      key === "pages" &&
      Array.isArray(parsed) &&
      parsed.every((page) => typeof page === "string")
    ) {
      pages = parsed;
    }
  }

  return { question, timestamp, pages };
}

/**
 * Parse the artifact text. Strict: exactly the three header keys with
 * JSON values, a closed frontmatter block, and the answer as the body
 * (one blank line stripped after the block, one trailing newline
 * stripped). Everything else is `not a wiki-query artifact`.
 */
export function parseQueryArtifact(text: string): QueryArtifact {
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    throw headerError("no frontmatter block");
  }

  const close = lines.indexOf("---", 1);

  if (close === -1) {
    throw headerError("unterminated frontmatter block");
  }

  const { question, timestamp, pages } = readHeaders(lines.slice(1, close));

  if (
    question === undefined ||
    timestamp === undefined ||
    pages === undefined
  ) {
    throw headerError("missing question, timestamp, or pages header");
  }

  if (Number.isNaN(Date.parse(timestamp))) {
    throw headerError(`timestamp ${JSON.stringify(timestamp)} is not a date`);
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
  const slug = kebab(question).slice(0, MAX_SLUG).replace(/-+$/, "");

  return slug === "" ? "query" : slug;
}

/** True when any directory entry exists at the path — a symlink
 *  counts even when it dangles or loops, so the slug it names is
 *  never claimed; keeps this module's IO non-blocking. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

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

/** One filing target's pre-run state: its bytes when a readable
 *  file existed, `absent` when no directory entry existed, and
 *  `unreadable` when an entry existed but its bytes could not be
 *  read — never deleted, since its content was never captured. */
type TargetPreState =
  | { readonly kind: "bytes"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

interface FilingTarget {
  readonly path: string;
  readonly state: TargetPreState;
}

/** The pre-run state of the three files a filing writes, captured
 *  before the first write so a failure can roll all of them back
 *  (issue #245: a half-filed wiki — page without index entry — is
 *  never left behind). */
interface FilingPreState {
  readonly pageFile: string;
  readonly index: FilingTarget;
  readonly log: FilingTarget;
}

/** A wiki file's pre-run state: its bytes when readable, `absent`
 *  when no entry exists, `unreadable` when an entry exists but its
 *  bytes cannot be read. */
async function readPreState(path: string): Promise<TargetPreState> {
  try {
    return { kind: "bytes", text: await readFile(path, "utf8") };
  } catch {
    const info = await lstat(path).catch(() => undefined);

    return info === undefined ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** The filing's input for a target: its captured bytes, or the
 *  empty string when none were readable. */
function textOrEmpty(state: TargetPreState): string {
  return state.kind === "bytes" ? state.text : "";
}

/** Delete the regular file a failed filing created; any other entry
 *  (a directory, a symlink) is left untouched, and so is a path that
 *  stayed absent. */
async function rmIfCreated(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);

  if (info?.isFile() === true) {
    await rm(path, { force: true });
  }
}

/** Restore one filing target after a failed write: rewrite the
 *  captured bytes, delete the regular file the failed filing created
 *  when nothing existed before, and leave an unreadable entry
 *  untouched. */
async function restoreTarget(target: FilingTarget): Promise<void> {
  if (target.state.kind === "bytes") {
    await writeFile(target.path, target.state.text, "utf8");

    return;
  }

  if (target.state.kind === "absent") {
    await rmIfCreated(target.path);
  }
}

/** Roll a failed filing back to its pre-run state (issue #245): the
 *  query page — never present before, queryPagePath claims a free
 *  slug — is deleted, index.md and log.md are restored. */
async function rollbackFiling(pre: FilingPreState): Promise<void> {
  await rmIfCreated(pre.pageFile);
  await restoreTarget(pre.index);
  await restoreTarget(pre.log);
}

/** Warning when a commit touched raw/ or wiki/ after the save.
 *  Throws when git log fails — the caller aborts the whole check,
 *  matching the pre-extraction semantics. */
async function committedAfterSave(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  savedAt: number,
): Promise<string | undefined> {
  const { stdout } = await runGit(
    dataRoot,
    ["log", "-1", "--format=%cI", "--", "raw", "wiki"],
    env,
  );

  const last = stdout.trim();

  if (last === "") {
    return undefined;
  }

  const changedAt = Date.parse(last);

  if (
    !Number.isNaN(changedAt) &&
    !Number.isNaN(savedAt) &&
    changedAt > savedAt
  ) {
    return `warning: the data repo changed after the saved answer (${last} touched raw/ or wiki/); pages it cites may have moved`;
  }

  return undefined;
}

/** Warning when uncommitted changes under raw/ or wiki/ are newer than the save. */
async function uncommittedAfterSave(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  savedAt: number,
): Promise<string | undefined> {
  let stdout: string;

  try {
    ({ stdout } = await runGit(
      dataRoot,
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain",
        "-uall",
        "--",
        "raw",
        "wiki",
      ],
      env,
    ));
  } catch {
    return undefined;
  }

  for (const entry of parseStatus(stdout)) {
    for (const path of [entry.origin, entry.path]) {
      if (
        path === undefined ||
        !(path.startsWith("raw/") || path.startsWith("wiki/"))
      ) {
        continue;
      }

      let mtimeMs: number;

      try {
        ({ mtimeMs } = await stat(join(dataRoot, path)));
      } catch {
        continue;
      }

      if (mtimeMs > savedAt) {
        return `warning: the data repo changed after the saved answer (uncommitted changes under raw/ or wiki/); pages it cites may have moved`;
      }
    }
  }

  return undefined;
}

/**
 * The drift warning for a filing (issue #72): `raw/` or `wiki/` was
 * committed after the answer was saved, or carries uncommitted
 * changes whose worktree mtime post-dates the save (wiki-ingest
 * leaves the wiki dirty until wiki-sync commits), so pages the
 * answer cites may have moved. Undefined when git cannot report or
 * nothing moved.
 */
export async function driftWarning(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  savedTimestamp: string,
): Promise<string | undefined> {
  const savedAt = Date.parse(savedTimestamp);

  let committed: string | undefined;

  try {
    committed = await committedAfterSave(dataRoot, env, savedAt);
  } catch {
    return undefined;
  }

  if (committed !== undefined) {
    return committed;
  }

  if (Number.isNaN(savedAt)) {
    return undefined;
  }

  return uncommittedAfterSave(dataRoot, env, savedAt);
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
  const indexPath = join(wikiDir, "index.md");
  const logPath = join(wikiDir, "log.md");
  const pageFile = join(options.dataRoot, pagePath);
  const index: FilingTarget = {
    path: indexPath,
    state: await readPreState(indexPath),
  };
  const log: FilingTarget = {
    path: logPath,
    state: await readPreState(logPath),
  };

  await mkdir(join(wikiDir, "queries"), { recursive: true });

  try {
    await writeFile(
      pageFile,
      templateQueryPage(artifact, { created: date, updated: date, sources }),
      "utf8",
    );

    await writeFile(
      indexPath,
      appendIndexEntry(
        textOrEmpty(index.state),
        indexEntryFor(slug, artifact.question),
      ),
      "utf8",
    );

    await writeFile(
      logPath,
      appendWikiLog(textOrEmpty(log.state), logEntry(artifact.question, date)),
      "utf8",
    );
  } catch (cause) {
    await rollbackFiling({ pageFile, index, log });
    onProgress(
      "wiki-query: filing failed — rolled back the query page, index.md, and log.md; nothing was filed",
    );

    throw new Error(
      `filing failed — rolled back, no wiki file was changed: ${errorMessage(cause)}`,
      { cause },
    );
  }

  return { pagePath, warning };
}
