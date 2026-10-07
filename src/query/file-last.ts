/**
 * wiki-query stage 2 (issue #72): deterministic filing of the saved
 * stage-1 answer. No LLM is involved — TypeScript reads
 * `outputs/last-query.md`, templates the answer byte-exactly into
 * `wiki/queries/<slug>.md`, and appends the `index.md` and `log.md`
 * entries. Stage 1's answer is the single source; this module only
 * wraps it. A drift warning fires when the data repo's `raw/` or
 * `wiki/` moved after the saved timestamp. The one-unit
 * write-with-rollback machinery and the index-entry insertion are
 * the shared filing shape wiki-promote copies verbatim (issue #341,
 * decision 7).
 */

import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { parseStatus, runGit } from "../data/git.ts";
import {
  listWikiPages,
  MAX_QUERY_ATTEMPT,
  pageSlug,
  queryAttemptSuffix,
  readPageFields,
} from "../wiki/pages.ts";
import { buildPageIndex, extractWikilinks } from "../wiki/wiki-links.ts";
import { prependWikiLog } from "../wiki/wiki-log.ts";
import { commitFiling } from "./commit-push.ts";
import {
  looksPartitionedWeb,
  parseWebArtifactBody,
  renderWebArtifactBody,
  type WebArtifactSections,
} from "./web-artifact.ts";

/** What stage 1 persisted to outputs/last-query.md. */
export interface QueryArtifact {
  /** The question as asked, verbatim. */
  readonly question: string;
  /** When the answer was saved, ISO 8601. */
  readonly timestamp: string;
  /** The wikilink page names the answer cites, sorted. */
  readonly pages: readonly string[];
  /** The answer, byte-exact. For a `--web` artifact: the core
   *  answer only — the enrichment is partitioned after it and never
   *  enters the filed page. */
  readonly answer: string;
  /** The run mode of a `--web` artifact (`query (--web)`). */
  readonly mode?: string;
  /** Web reference count of a `--web` artifact. */
  readonly webSources?: number;
  /** Web retrieval timestamp of a `--web` artifact, ISO 8601. */
  readonly webRetrieved?: string;
  /** A degraded `--web` run's warning line, persisted as a header
   *  value and excluded from the answer (never filed). */
  readonly webWarning?: string;
  /** A degraded `--web` run's concrete failure reason (the gate,
   *  the offending URLs, counts), persisted beside the generic
   *  `webWarning` header and excluded from the answer. */
  readonly webFailureReason?: string;
  /** The machine-owned web sections of a `--web` artifact, in
   *  artifact order, each including its heading. */
  readonly web?: WebArtifactSections;
}

const BAD_ARTIFACT = "not a wiki-query artifact";

/** The strict-parse failure for every malformed artifact. */
function headerError(why: string): Error {
  return new Error(`${BAD_ARTIFACT}: ${why}`);
}
/** The frontmatter block's close index; throws for a missing or
 *  unterminated block. */
function frontmatterRange(lines: readonly string[]): number {
  if (lines[0] !== "---") {
    throw headerError("no frontmatter block");
  }

  const close = lines.indexOf("---", 1);

  if (close === -1) {
    throw headerError("unterminated frontmatter block");
  }

  return close;
}

/** The validated core headers every artifact shape needs. */
interface CoreHeaders {
  question: string;
  timestamp: string;
  pages: readonly string[];
}

/** Validate the three headers every shape requires. */
function coreHeaders(bag: HeaderBag): CoreHeaders {
  if (
    bag.question === undefined ||
    bag.timestamp === undefined ||
    bag.pages === undefined
  ) {
    throw headerError("missing question, timestamp, or pages header");
  }

  if (Number.isNaN(Date.parse(bag.timestamp))) {
    throw headerError(
      `timestamp ${JSON.stringify(bag.timestamp)} is not a date`,
    );
  }

  return { question: bag.question, timestamp: bag.timestamp, pages: bag.pages };
}

/** The body text after the frontmatter block: one leading blank and
 *  one trailing newline stripped, exactly as the writer emitted. */
function bodyAfter(lines: readonly string[], close: number): string {
  return lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "");
}

/** The partitioned `--web` artifact: validate its extra headers and
 *  assemble the typed result. */
function webArtifact(
  core: CoreHeaders,
  bag: HeaderBag,
  parsed: { answer: string; web: WebArtifactSections },
): QueryArtifact {
  if (
    bag.mode === undefined ||
    bag.webSources === undefined ||
    bag.webRetrieved === undefined ||
    Number.isNaN(Date.parse(bag.webRetrieved))
  ) {
    throw headerError(
      "partitioned web body needs the mode, webSources, and webRetrieved headers",
    );
  }

  return {
    ...core,
    answer: parsed.answer,
    mode: bag.mode,
    webSources: bag.webSources,
    webRetrieved: bag.webRetrieved,
    web: parsed.web,
  };
}

/** The plain or degraded body: the answer alone — the degraded
 *  run's warning and concrete failure reason travel in their
 *  headers, so machinery markers and answer text can never collide. */
function plainArtifact(
  core: CoreHeaders,
  body: string,
  webWarning: string | undefined,
  webFailureReason: string | undefined,
): QueryArtifact {
  return {
    ...core,
    answer: body,
    ...(webWarning !== undefined && { webWarning }),
    ...(webFailureReason !== undefined && { webFailureReason }),
  };
}

/**
 * Render the artifact: a frontmatter block (single-line JSON values,
 * so any question round-trips; the degraded `--web` warning is a
 * header value, never body text) and the body — the partitioned
 * `--web` structure with its extra header keys, else the plain
 * answer.
 */
export function renderQueryArtifact(artifact: QueryArtifact): string {
  return [
    "---",
    `question: ${JSON.stringify(artifact.question)}`,
    ...(artifact.mode === undefined
      ? []
      : [`mode: ${JSON.stringify(artifact.mode)}`]),
    `timestamp: ${JSON.stringify(artifact.timestamp)}`,
    `pages: ${JSON.stringify(artifact.pages)}`,
    ...(artifact.webSources === undefined
      ? []
      : [`webSources: ${artifact.webSources}`]),
    ...(artifact.webRetrieved === undefined
      ? []
      : [`webRetrieved: ${JSON.stringify(artifact.webRetrieved)}`]),
    ...(artifact.webWarning === undefined
      ? []
      : [`webWarning: ${JSON.stringify(artifact.webWarning)}`]),
    ...(artifact.webFailureReason === undefined
      ? []
      : [`webFailureReason: ${JSON.stringify(artifact.webFailureReason)}`]),
    "---",
    "",
    artifactBody(artifact),
    "",
  ].join("\n");
}

/** The artifact body: the partitioned `--web` shape, else the
 *  answer alone — the degraded warning travels in the header. */
export function artifactBody(artifact: QueryArtifact): string {
  const web = artifact.web;

  if (web !== undefined) {
    return renderWebArtifactBody(artifact.answer, web);
  }

  return artifact.answer;
}

/** One frontmatter header line split into its key and JSON value. */
function parseHeaderLine(line: string): { key: string; value: string } {
  const match =
    /^(question|mode|timestamp|pages|webSources|webRetrieved|webWarning|webFailureReason): (.+)$/.exec(
      line,
    );

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

/** The header values found in a frontmatter block, as written. */
interface HeaderBag {
  question?: string;
  mode?: string;
  timestamp?: string;
  pages?: readonly string[];
  webSources?: number;
  webRetrieved?: string;
  webWarning?: string;
  webFailureReason?: string;
}

type HeaderBagKey = keyof HeaderBag;

const HEADER_KEYS: readonly HeaderBagKey[] = [
  "question",
  "mode",
  "timestamp",
  "pages",
  "webSources",
  "webRetrieved",
  "webWarning",
  "webFailureReason",
];

/** Assign one header line's parsed value into the bag when the key
 *  is known and the value fits the key's type; anything else is
 *  skipped (the required-fields check reports what is missing). */
function assignHeader(bag: HeaderBag, key: string, value: unknown): void {
  if (!(HEADER_KEYS as readonly string[]).includes(key)) {
    return;
  }

  const bagKey = key as HeaderBagKey;

  if (
    bagKey === "pages" &&
    Array.isArray(value) &&
    value.every((page) => typeof page === "string")
  ) {
    bag.pages = value;

    return;
  }

  if (bagKey === "webSources" && typeof value === "number") {
    bag.webSources = value;

    return;
  }

  if (
    bagKey !== "pages" &&
    bagKey !== "webSources" &&
    typeof value === "string"
  ) {
    bag[bagKey] = value;
  }
}

/** The header values found in the frontmatter block, if any. */
function readHeaders(lines: readonly string[]): HeaderBag {
  const bag: HeaderBag = {};

  for (const line of lines) {
    const { key, value } = parseHeaderLine(line);

    assignHeader(bag, key, parseHeaderValue(line, value));
  }

  return bag;
}

/**
 * Parse the artifact text. Strict: exactly the header keys with
 * JSON values, a closed frontmatter block, and one of two body
 * shapes — the plain answer, or the partitioned `--web` structure
 * (all three web sections required; a degraded run's warning and
 * failure reason are the `webWarning`/`webFailureReason` headers).
 * Everything else is `not a wiki-query artifact`.
 */
export function parseQueryArtifact(text: string): QueryArtifact {
  const lines = text.split("\n");
  const close = frontmatterRange(lines);
  const bag = readHeaders(lines.slice(1, close));
  const core = coreHeaders(bag);
  const body = bodyAfter(lines, close);
  const bodyLines = body.split("\n");
  const web = parseWebArtifactBody(bodyLines);

  if (web !== undefined) {
    return webArtifact(core, bag, web);
  }

  if (looksPartitionedWeb(bodyLines)) {
    throw headerError("malformed partitioned web body");
  }

  return plainArtifact(core, body, bag.webWarning, bag.webFailureReason);
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

/** Kebab-case slug from the question; `query` when nothing survives. */
export function slugForQuestion(question: string): string {
  const slug = pageSlug(question);

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

/** The first free `wiki/queries/<slug>.md` name; the shared collision
 *  convention (`queryAttemptSuffix`, issue #383) suffixes -2, -3, …
 *  on collision. */
async function queryPagePath(
  wikiDir: string,
  question: string,
): Promise<string> {
  const slug = slugForQuestion(question);

  for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPT; attempt += 1) {
    const name = `${slug}${queryAttemptSuffix(attempt)}.md`;

    if (!(await exists(join(wikiDir, "queries", name)))) {
      return `wiki/queries/${name}`;
    }
  }

  throw new Error(
    `cannot file the query: ${MAX_QUERY_ATTEMPT} pages already share the slug ${JSON.stringify(slug)}`,
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
 * Insert the entry directly under the section's `## <name>` heading
 * (default `Queries`); append the section when the index has none —
 * a missing index is created with its heading, like the log. Both
 * deterministic. wiki-promote passes the promoted page's type
 * section; the query filing keeps the default.
 */
export function appendIndexEntry(
  indexText: string,
  entry: string,
  section = "Queries",
): string {
  const lines = indexText.split("\n");
  const heading = lines.indexOf(`## ${section}`);

  if (heading !== -1) {
    lines.splice(heading + 1, 0, entry);

    return lines.join("\n");
  }

  if (indexText === "") {
    return `# Wiki Index\n\n## Queries\n\n${entry}\n`;
  }

  const prefix = indexText.endsWith("\n") ? indexText : `${indexText}\n`;

  return `${prefix}\n## ${section}\n\n${entry}\n`;
}

/** The log.md entry heading (guide §12 format). */
export function logEntry(question: string, date: string): string {
  return `## [${date}] query | ${oneLine(question)}`;
}

/** One wiki file's pre-run state: its bytes when readable, `absent`
 *  when no entry exists, `unreadable` when an entry exists but its
 *  bytes cannot be read. Shared with wiki-promote's rollback. */
export type TargetPreState =
  | { readonly kind: "bytes"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/** One rollback target: its path and captured pre-run state.
 *  Shared with wiki-promote. */
export interface FilingTarget {
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

/** The pre-run state of one wiki file, captured for a rollback
 *  (issue #245's one-unit shape; shared with wiki-promote). */
export async function readPreState(path: string): Promise<TargetPreState> {
  try {
    return { kind: "bytes", text: await readFile(path, "utf8") };
  } catch {
    const info = await lstat(path).catch(() => undefined);

    return info === undefined ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** The captured bytes of a target, or the empty string when none
 *  were readable. Shared with wiki-promote. */
export function textOrEmpty(state: TargetPreState): string {
  return state.kind === "bytes" ? state.text : "";
}

/** Delete the regular file a failed unit write created; any other
 *  entry (a directory, a symlink) is left untouched, and so is a
 *  path that stayed absent. Shared with wiki-promote. */
export async function rmIfCreated(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);

  if (info?.isFile() === true) {
    await rm(path, { force: true });
  }
}

/** Restore one target after a failed write: rewrite the captured
 *  bytes, delete the regular file the failed write created when
 *  nothing existed before, and leave an unreadable entry untouched.
 *  Shared with wiki-promote. */
export async function restoreTarget(target: FilingTarget): Promise<void> {
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
  /** Commit the three filed files atomically (issue #436);
   *  default true — committing is what filing means. */
  readonly commit?: boolean;
}

export interface FileLastResult {
  /** The filed page, data-repo relative (`wiki/queries/<slug>.md`). */
  readonly pagePath: string;
  /** The drift warning, when the wiki moved since the answer. */
  readonly warning: string | undefined;
  /** The filed page's slug (the commit message names it). */
  readonly slug: string;
  /** The filing commit's OID; undefined when the commit was
   *  skipped (`commit: false`). */
  readonly commit: string | undefined;
}

/**
 * File the saved answer: read the artifact, warn on drift, claim a
 * free slug, template the page, update index.md and log.md, and
 * commit the three files atomically (message `query: file <slug>`;
 * skipped under `commit: false`). Zero LLM involvement; every input
 * comes from the artifact and the wiki.
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
      prependWikiLog(textOrEmpty(log.state), logEntry(artifact.question, date)),
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

  const commitDisabled = options.commit === false;
  const oid = commitDisabled
    ? undefined
    : await commitFiling({
        dataRoot: options.dataRoot,
        pagePath,
        slug,
        env,
      });

  return { pagePath, warning, slug, commit: oid };
}
