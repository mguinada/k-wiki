/**
 * Deterministic wiki-page reading, shared by the expunge seed
 * (wiki-ingest) and the dead-provenance check (scripts/): which pages
 * exist, and the frontmatter fields the pipeline reads — `title`,
 * `type`, `updated`, `status`, `origin`, `sources`, and `tags`. The one
 * wiki walker (issue #338): the sandbox root never lists, so listings,
 * coverage, dashboards, and checkers never count a sandbox page.
 * Agent-written frontmatter is tolerant input: a page whose fields
 * cannot be read simply contributes nothing to the deterministic
 * layer.
 */

import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { assertDirectory, listFiles, statIfExists } from "../cli/shared.ts";
import { SANDBOX_ROOT } from "../sandbox/stamps.ts";
import { wikilinkBody, wikilinkBodyTarget } from "./wiki-links.ts";

/** The frontmatter fields the pipeline reads from a wiki page. */
export interface PageFields {
  /** The page title scalar, as written. */
  readonly title: string | undefined;
  /** The `created` date scalar, as written. */
  readonly created: string | undefined;
  /** The page type scalar (e.g. `source`), as written. */
  readonly type: string | undefined;
  /** The `updated` date scalar, as written. */
  readonly updated: string | undefined;
  /** The `status` scalar (e.g. `needs-review`), as written. */
  readonly status: string | undefined;
  /** The raw projection path backing a source page, as written. */
  readonly origin: string | undefined;
  /** `sources` list entries as written (wikilinks still bracketed). */
  readonly sources: readonly string[];
  /** `tags` list entries as written, unquoted. */
  readonly tags: readonly string[];
}

/** The frontmatter fields the wiki contract (§9) requires on every
 *  page (wiki/AGENTS.md "Obsidian Frontmatter"); `sources` is added
 *  per page type by the guardrails, so it stays out of this list. */
export const REQUIRED_PAGE_FIELDS = [
  "title",
  "type",
  "created",
  "updated",
  "tags",
] as const;

/** Kebab-case slug: lowercased, every non-alphanumeric run collapsed
 *  to one hyphen, leading and trailing hyphens trimmed. */
export function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** Longest page-name slug; questions and titles can be long, file
 *  names should not be. */
const MAX_SLUG = 80;

/** Kebab-case page-name slug from a page's title or question: kebab,
 *  capped at MAX_SLUG, a trailing hyphen left by the cut trimmed.
 *  The one derivation shared by query filing (`slugForQuestion`) and
 *  the fidelity title rule — a filed page re-derives to its own file
 *  name, however long the question was (issue #377). */
export function pageSlug(text: string): string {
  return kebab(text).slice(0, MAX_SLUG).replace(/-+$/, "");
}

/** The frontmatter block's opening and closing fence line. */
export const FRONTMATTER_FENCE = "---";

const EMPTY_FIELDS: PageFields = {
  title: undefined,
  created: undefined,
  type: undefined,
  updated: undefined,
  status: undefined,
  origin: undefined,
  sources: [],
  tags: [],
};

/** Unquote one frontmatter scalar or list-item value: only a value
 *  wrapped in a pair of matching single or double quotes is stripped;
 *  a lone quote stays as written (issue #243). Shared by the
 *  migration scripts' line-based rewrites. */
export function unquote(value: string): string {
  const quote = value[0];

  return value.length > 1 &&
    (quote === '"' || quote === "'") &&
    value[value.length - 1] === quote
    ? value.slice(1, -1)
    : value;
}

/** Index of the closing frontmatter fence — trim-tolerant — in a
 *  page's lines, or -1 when the block never closes. */
export function closingFence(lines: readonly string[]): number {
  return lines.findIndex((line, index) => index > 0 && line.trim() === "---");
}

/** The text after a closed frontmatter block; the full text when the
 *  note opens with no frontmatter or the fence never closes. */
export function bodyAfterFrontmatter(text: string): string {
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    return text;
  }

  const end = closingFence(lines);

  return end === -1 ? text : lines.slice(end + 1).join("\n");
}

/** Whether a `sources` entry is a wikilink (bracketed) or a raw path. */
export function isWikilinkEntry(entry: string): boolean {
  return entry.startsWith("[[") && entry.endsWith("]]");
}

/** The page-name part of a bracketed `sources` entry; empty when malformed. */
export function wikilinkTarget(entry: string): string {
  return wikilinkBodyTarget(wikilinkBody(entry));
}

/** `raw/notes/…` with an optional `raw/` prefix removed. */
export function normalizeRawPath(path: string): string {
  return path.replace(/^raw\//, "");
}

/** The scalar value of a frontmatter key: unquoted and trimmed;
 *  undefined when absent or empty. */
function scalar(value: string | undefined): string | undefined {
  return value !== undefined && value !== ""
    ? unquote(value.trim())
    : undefined;
}

/** Page fields under construction while parsing, plus the list mode
 *  the `sources` and `tags` keys switch on and every other key
 *  switches off. */
interface MutablePageFields {
  title: string | undefined;
  created: string | undefined;
  type: string | undefined;
  updated: string | undefined;
  status: string | undefined;
  origin: string | undefined;
  sources: string[];
  tags: string[];
  inSources: boolean;
  inTags: boolean;
}

/** Apply a `key: value` line to `fields`, returning whether the line
 *  is a key line at all; unknown keys still switch list mode off. */
function applyKeyLine(line: string, fields: MutablePageFields): boolean {
  const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);

  if (key === null || key[1] === undefined) {
    return false;
  }

  fields.inSources = key[1] === "sources";
  fields.inTags = key[1] === "tags";

  if (key[1] === "title") {
    fields.title = scalar(key[2]);
  }

  if (key[1] === "created") {
    fields.created = scalar(key[2]);
  }

  if (key[1] === "type") {
    fields.type = scalar(key[2]);
  }

  if (key[1] === "updated") {
    fields.updated = scalar(key[2]);
  }

  if (key[1] === "status") {
    fields.status = scalar(key[2]);
  }

  if (key[1] === "origin") {
    fields.origin = scalar(key[2]);
  }

  return true;
}

/** Add one `- item` line to a list field (`sources`, `tags`) while
 *  inside that key's list. */
function applySourcesItem(line: string, fields: MutablePageFields): void {
  if (!fields.inSources && !fields.inTags) {
    return;
  }

  const item = /^\s+-\s+(.+)$/.exec(line)?.[1];

  if (item === undefined) {
    return;
  }

  const value = unquote(item.trim());

  if (fields.inSources) {
    fields.sources.push(value);
  } else {
    fields.tags.push(value);
  }
}

/** Fold the lines after the opening fence into fields until the
 *  closing fence; EMPTY_FIELDS when the block never closes. */
function parseFrontmatterBody(lines: readonly string[]): PageFields {
  const fields: MutablePageFields = {
    title: undefined,
    created: undefined,
    type: undefined,
    updated: undefined,
    status: undefined,
    origin: undefined,
    sources: [],
    tags: [],
    inSources: false,
    inTags: false,
  };

  for (const line of lines) {
    if (line.trim() === FRONTMATTER_FENCE) {
      return {
        title: fields.title,
        created: fields.created,
        type: fields.type,
        updated: fields.updated,
        status: fields.status,
        origin: fields.origin,
        sources: fields.sources,
        tags: fields.tags,
      };
    }

    if (!applyKeyLine(line, fields)) {
      applySourcesItem(line, fields);
    }
  }

  return EMPTY_FIELDS;
}

/** Parse `title`, `created`, `type`, `updated`, `status`, `origin`,
 * `sources`, and `tags` from a wiki page's YAML frontmatter: top-level
 * scalars and two lists of single-line items, nothing more. Returns
 * empty fields when there is no closed frontmatter block. */
export function parsePageFields(text: string): PageFields {
  const lines = text.split("\n");

  if (lines[0] !== FRONTMATTER_FENCE) {
    return EMPTY_FIELDS;
  }

  return parseFrontmatterBody(lines.slice(1));
}

/** Operating-contract files: never wiki pages (issue #74 adds the
 *  meta contract template that lives in the code repo's skeleton). */
export const CONTRACT_FILES = new Set(["AGENTS.md", "AGENTS.meta.md"]);

/** The sandbox root (issue #338): never walked — sandbox notes are
 *  disposable agent scratch, not reviewed wiki content. */
const SKIP_ROOT_DIRS = new Set([SANDBOX_ROOT]);

/**
 * List every wiki page under `dir`: markdown files, excluding the
 * operating contracts (AGENTS.md and its meta template) and the
 * sandbox root (issue #338 — sandbox notes are disposable agent
 * scratch; they never list, count, or resolve), sorted, POSIX-style
 * relative paths. Throws naming the directory when it does not
 * exist.
 */
export async function listWikiPages(dir: string): Promise<string[]> {
  await assertDirectory("wiki directory", dir);

  return (await listFiles(dir, "", { skipRootDirs: SKIP_ROOT_DIRS }))
    .filter(
      (file) => file.endsWith(".md") && !CONTRACT_FILES.has(basename(file)),
    )
    .sort();
}

/**
 * List the sandbox namespace's own pages (issue #339): wiki-relative
 * `sandbox/…` markdown paths, sorted; an empty list when the
 * namespace is absent. The citation-wall surfaces (check-citations,
 * check-links' sandbox scope, check-crosslinks' sandbox rule) are
 * the callers — every listing walker keeps excluding the root
 * (issue #338), so the wall reads the namespace through this door
 * instead.
 */
export async function listSandboxPages(dir: string): Promise<string[]> {
  const sandboxDir = join(resolve(dir), SANDBOX_ROOT);

  if ((await statIfExists(sandboxDir)) === undefined) {
    return [];
  }

  return (await listFiles(sandboxDir, "", { extension: ".md" }))
    .map((file) => `${SANDBOX_ROOT}/${file}`)
    .filter((file) => !CONTRACT_FILES.has(basename(file)))
    .sort();
}

/** Read one page's fields; missing file returns empty fields. */
export async function readPageFields(path: string): Promise<PageFields> {
  try {
    return parsePageFields(await readFile(path, "utf8"));
  } catch {
    return EMPTY_FIELDS;
  }
}

/** A wiki page's report path: relative to the wiki root's parent —
 *  the convention every checker's problem lines use. */
export function pageReportPath(wikiDir: string, file: string): string {
  return relative(resolve(wikiDir, ".."), join(wikiDir, file));
}
