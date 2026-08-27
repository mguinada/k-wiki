import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  type PageFields,
  parsePageFields,
} from "./pages.ts";

/**
 * The source-hub coverage index (issue #126): which raw paths a
 * `type: source` page covers, so every consumer of the `sources`
 * contract — the link-sources migration, the ingest guardrails, and
 * check-provenance — applies one rule, not three. A path is covered
 * when it is a hub's `origin` (priority 1) or cited in a hub's own
 * `sources` list (priority 2, the multi-part-hub case). A path
 * covered by two different hubs is ambiguous: reported, never
 * guessed. The index also exposes every page's parsed fields by page
 * name, the resolution surface for wikilink `sources` entries.
 */

export interface SourceHubIndex {
  /** Every wiki page's fields, by page name (file stem). */
  readonly fields: ReadonlyMap<string, PageFields>;
  /** Normalized raw path → covering hub page name (`origin` match). */
  readonly byOrigin: ReadonlyMap<string, string>;
  /** Normalized raw path → covering hub page name (hub `sources`
   *  citation match). */
  readonly byCitation: ReadonlyMap<string, string>;
  /** Raw paths covered by more than one hub: never guessed. */
  readonly ambiguous: ReadonlySet<string>;
}

/** The page-name stem of a wiki-relative path. */
function stem(file: string): string {
  return basename(file, ".md");
}

/** The alias a hub-sources citation rewrites to: the parent
 *  directory name of the cited path (`…/04. Rate Limiter/Readme.md`
 *  → `04. Rate Limiter`); undefined when the path has no directory
 *  part. */
export function citationAlias(path: string): string | undefined {
  const parent = path.split("/").at(-2);

  return parent === undefined || parent === "" ? undefined : parent;
}

/** Add one coverage entry; a second, different hub makes the path
 *  ambiguous and removes it from the map. */
function cover(
  map: Map<string, string>,
  ambiguous: Set<string>,
  path: string,
  hub: string,
): void {
  const prior = map.get(path);

  if (prior === hub) {
    return;
  }

  if (prior === undefined && !ambiguous.has(path)) {
    map.set(path, hub);

    return;
  }

  ambiguous.add(path);
  map.delete(path);
}

/** Build the index over every page under `wikiDir`; unreadable
 *  frontmatter contributes nothing, matching the shared parser.
 *  Throws when the wiki directory is missing, via `listWikiPages`. */
export async function loadSourceHubIndex(
  wikiDir: string,
): Promise<SourceHubIndex> {
  const files = await listWikiPages(wikiDir);
  const fields = new Map<string, PageFields>();
  const byOrigin = new Map<string, string>();
  const byCitation = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const file of files) {
    const parsed = parsePageFields(await readFile(join(wikiDir, file), "utf8"));

    fields.set(stem(file), parsed);

    if (parsed.type !== "source") {
      continue;
    }

    if (parsed.origin !== undefined) {
      cover(byOrigin, ambiguous, normalizeRawPath(parsed.origin), stem(file));
    }

    for (const entry of parsed.sources) {
      if (!isWikilinkEntry(entry)) {
        cover(byCitation, ambiguous, normalizeRawPath(entry), stem(file));
      }
    }
  }

  return { fields, byOrigin, byCitation, ambiguous };
}
