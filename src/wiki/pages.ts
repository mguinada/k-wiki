import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { assertDirectory, listFiles } from "../cli/shared.ts";
import { wikilinkBodyTarget } from "./wiki-links.ts";
/**
 * Deterministic wiki-page reading, shared by the expunge seed
 * (wiki-ingest) and the dead-provenance check (scripts/): which pages
 * exist, and the frontmatter fields the pipeline treats as
 * machine-readable provenance — `type`, `origin`, and `sources`.
 * Agent-written frontmatter is tolerant input: a page whose fields
 * cannot be read simply contributes nothing to the deterministic
 * layer.
 */

/** The frontmatter fields the pipeline reads from a wiki page. */
export interface PageFields {
  /** The page title scalar, as written. */
  readonly title: string | undefined;
  /** The page type scalar (e.g. `source`), as written. */
  readonly type: string | undefined;
  /** The raw projection path backing a source page, as written. */
  readonly origin: string | undefined;
  /** `sources` list entries as written (wikilinks still bracketed). */
  readonly sources: readonly string[];
}

/** Kebab-case slug: lowercased, every non-alphanumeric run collapsed
 *  to one hyphen, leading and trailing hyphens trimmed. */
export function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** The frontmatter block's opening and closing fence line. */
export const FRONTMATTER_FENCE = "---";

const EMPTY_FIELDS: PageFields = {
  title: undefined,
  type: undefined,
  origin: undefined,
  sources: [],
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
  return wikilinkBodyTarget(entry.slice(2, -2));
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
 *  the `sources` key switches on and every other key switches off. */
interface MutablePageFields {
  title: string | undefined;
  type: string | undefined;
  origin: string | undefined;
  sources: string[];
  inSources: boolean;
}

/** Apply a `key: value` line to `fields`, returning whether the line
 *  is a key line at all; unknown keys still switch list mode off. */
function applyKeyLine(line: string, fields: MutablePageFields): boolean {
  const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);

  if (key === null || key[1] === undefined) {
    return false;
  }

  fields.inSources = key[1] === "sources";

  if (key[1] === "title") {
    fields.title = scalar(key[2]);
  }

  if (key[1] === "type") {
    fields.type = scalar(key[2]);
  }

  if (key[1] === "origin") {
    fields.origin = scalar(key[2]);
  }

  return true;
}

/** Add one `- item` line to `sources` while inside the sources
 *  list. */
function applySourcesItem(line: string, fields: MutablePageFields): void {
  if (!fields.inSources) {
    return;
  }

  const item = /^\s+-\s+(.+)$/.exec(line)?.[1];

  if (item === undefined) {
    return;
  }

  fields.sources.push(unquote(item.trim()));
}

/** Fold the lines after the opening fence into fields until the
 *  closing fence; EMPTY_FIELDS when the block never closes. */
function parseFrontmatterBody(lines: readonly string[]): PageFields {
  const fields: MutablePageFields = {
    title: undefined,
    type: undefined,
    origin: undefined,
    sources: [],
    inSources: false,
  };

  for (const line of lines) {
    if (line.trim() === FRONTMATTER_FENCE) {
      return {
        title: fields.title,
        type: fields.type,
        origin: fields.origin,
        sources: fields.sources,
      };
    }

    if (!applyKeyLine(line, fields)) {
      applySourcesItem(line, fields);
    }
  }

  return EMPTY_FIELDS;
}

/** Parse `title`, `type`, `origin`, and `sources` from a wiki page's
 *  YAML frontmatter: top-level scalars and one list of single-line
 *  items, nothing more. Returns empty fields when there is no closed
 *  frontmatter block. */
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

/**
 * List every wiki page under `dir`: markdown files, excluding the
 * operating contracts (AGENTS.md and its meta template), sorted,
 * POSIX-style relative paths. Throws naming the directory when it
 * does not exist.
 */
export async function listWikiPages(dir: string): Promise<string[]> {
  await assertDirectory("wiki directory", dir);

  return (await listFiles(dir))
    .filter(
      (file) => file.endsWith(".md") && !CONTRACT_FILES.has(basename(file)),
    )
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

/** Append one audit entry to wiki/log.md content: the standing
 *  `# Wiki Log` header is created when the log is absent, and a
 *  blank line separates entries (guide §12). */
export function appendWikiLog(prior: string, entry: string): string {
  const prefix =
    prior === "" ? "# Wiki Log\n" : prior.endsWith("\n") ? prior : `${prior}\n`;

  return `${prefix}\n${entry}\n`;
}
