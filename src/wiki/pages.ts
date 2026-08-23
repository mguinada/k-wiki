import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildPageIndex, wikilinkBodyTarget } from "../wiki-links.ts";

export { buildPageIndex };

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
  /** The page type scalar (e.g. `source`), as written. */
  readonly type: string | undefined;
  /** The raw projection path backing a source page, as written. */
  readonly origin: string | undefined;
  /** `sources` list entries as written (wikilinks still bracketed). */
  readonly sources: readonly string[];
}

const FRONTMATTER_FENCE = "---";

function unquote(value: string): string {
  const quote = value[0];

  return quote === '"' || quote === "'" ? value.slice(1, -1) : value;
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

/**
 * Parse `type`, `origin`, and `sources` from a wiki page's YAML
 * frontmatter: top-level scalars and one list of single-line items,
 * nothing more. Returns empty fields when there is no closed
 * frontmatter block.
 */
export function parsePageFields(text: string): PageFields {
  const lines = text.split("\n");

  if (lines[0] !== FRONTMATTER_FENCE) {
    return { type: undefined, origin: undefined, sources: [] };
  }

  let type: string | undefined;
  let origin: string | undefined;
  const sources: string[] = [];
  let inSources = false;

  for (const line of lines.slice(1)) {
    if (line.trim() === FRONTMATTER_FENCE) {
      return { type, origin, sources };
    }

    const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);

    if (key !== null && key[1] !== undefined) {
      inSources = key[1] === "sources";

      if (key[1] === "type") {
        type = scalar(key[2]);
      }

      if (key[1] === "origin") {
        origin = scalar(key[2]);
      }

      continue;
    }

    if (!inSources) {
      continue;
    }

    const item = /^\s+-\s+(.+)$/.exec(line)?.[1];

    if (item === undefined) {
      continue;
    }

    sources.push(unquote(item.trim()));
  }

  return { type: undefined, origin: undefined, sources: [] };
}

/** Recursively list every wiki-relative markdown path under `dir`. */
async function listFiles(
  dir: string,
  prefix = "",
  files: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await listFiles(join(dir, entry.name), rel, files);
    } else {
      files.push(rel);
    }
  }

  return files;
}

/**
 * List every wiki page under `dir`: markdown files, excluding the
 * operating contract (AGENTS.md), sorted, POSIX-style relative paths.
 * Throws naming the directory when it does not exist.
 */
export async function listWikiPages(dir: string): Promise<string[]> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    throw new Error(`wiki directory does not exist: ${dir}`);
  }

  if (!isDirectory) {
    throw new Error(`wiki directory is not a directory: ${dir}`);
  }

  return (await listFiles(dir))
    .filter((file) => file.endsWith(".md") && basename(file) !== "AGENTS.md")
    .sort();
}

/** Read one page's fields; missing file returns empty fields. */
export async function readPageFields(path: string): Promise<PageFields> {
  try {
    return parsePageFields(await readFile(path, "utf8"));
  } catch {
    return { type: undefined, origin: undefined, sources: [] };
  }
}
