import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stem } from "../wiki-links.ts";
import {
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  type PageFields,
  parsePageFields,
  wikilinkTarget,
} from "./pages.ts";

/**
 * The source-hub coverage index (issue #126): which raw paths a
 * `type: source` page covers, so every consumer of the `sources`
 * contract — the link-sources migration, the ingest guardrails, and
 * check-provenance — applies one rule, not three. A path is covered
 * when it is a hub's `origin` (priority 1) or cited in a hub's own
 * `sources` list (priority 2, the multi-part-hub case). The citation
 * form survives the migration itself: a hub's own sources migrate
 * to aliased self-wikilinks (`[[hub|Chapter]]`), and each such
 * self-citation still covers its chapter directory — the reverse of
 * the alias rule. A path covered by two different hubs is ambiguous:
 * reported, never guessed. The index also exposes every page's parsed
 * fields by page name, the resolution surface for wikilink `sources`
 * entries.
 */

export interface SourceHubIndex {
  /** Every wiki page's fields, by page name (file stem). */
  readonly fields: ReadonlyMap<string, PageFields>;
  /** Normalized raw path → covering hub page name (`origin` match). */
  readonly byOrigin: ReadonlyMap<string, string>;
  /** Normalized raw path → covering hub page name (hub `sources`
   *  citation match). */
  readonly byCitation: ReadonlyMap<string, string>;
  /** A hub's aliased self-citations (`[[hub|Chapter]]`), the
   *  migrated form of its own chapter citations: each still covers
   *  the chapter directory `<originDir>/<alias>/`, so citation
   *  coverage survives the migration. */
  readonly selfCitations: readonly SelfCitation[];
  /** Raw paths covered by more than one hub: never guessed. */
  readonly ambiguous: ReadonlySet<string>;
}

/** One derived-coverage rule of a migrated multi-part hub: the hub
 *  covers every path whose parent directory is
 *  `<originDir>/<alias>` — the reverse of `citationAlias`. */
export interface SelfCitation {
  readonly hub: string;
  readonly originDir: string;
  readonly alias: string;
}

/** The alias a hub-sources citation rewrites to: the parent
 *  directory name of the cited path (`…/04. Rate Limiter/Readme.md`
 *  → `04. Rate Limiter`); undefined when the path has no directory
 *  part. */
export function citationAlias(path: string): string | undefined {
  const parent = path.split("/").at(-2);

  return parent === undefined || parent === "" ? undefined : parent;
}

/** The wikilink a covered raw path cites as — plain `[[hub]]` for an
 *  origin match, aliased `[[hub|Chapter]]` for a citation match —
 *  or the reason the path cannot be mapped. One definition shared by
 *  the link-sources migration (which performs the rewrite), the
 *  guardrails (which demand it), and check-provenance (which flag
 *  it), so the three cannot drift apart. */
export function wikilinkFor(
  path: string,
  hubs: SourceHubIndex,
): { wikilink: string } | { reason: string } {
  const normalized = normalizeRawPath(path);
  const originHub = hubs.byOrigin.get(normalized);

  if (originHub !== undefined) {
    return { wikilink: `[[${originHub}]]` };
  }

  const citationHub = hubs.byCitation.get(normalized);

  if (citationHub !== undefined) {
    const alias = citationAlias(normalized);

    return {
      wikilink:
        alias === undefined
          ? `[[${citationHub}]]`
          : `[[${citationHub}|${alias}]]`,
    };
  }

  if (hubs.ambiguous.has(normalized)) {
    return { reason: "covered by more than one hub" };
  }

  const derived = derivedHubs(normalized, hubs);

  if (derived.length === 1 && derived[0] !== undefined) {
    return { wikilink: `[[${derived[0]}|${citationAlias(normalized)}]]` };
  }

  return {
    reason:
      derived.length > 1
        ? "covered by more than one hub"
        : "no hub covers this path",
  };
}

/** Hubs whose self-citations cover the path: its parent directory
 *  equals `<originDir>/<alias>`. */
function derivedHubs(normalized: string, hubs: SourceHubIndex): string[] {
  const parent = normalized.split("/").slice(0, -1).join("/");

  return [
    ...new Set(
      hubs.selfCitations
        .filter((rule) => parent === `${rule.originDir}/${rule.alias}`)
        .map((rule) => rule.hub),
    ),
  ];
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

/** The alias part of a wikilink entry (`[[hub|Chapter]]` →
 *  `Chapter`); undefined when the entry carries none. */
function wikilinkAlias(entry: string): string | undefined {
  const alias = entry.slice(2, -2).split("|")[1]?.trim();

  return alias === undefined || alias === "" ? undefined : alias;
}

/** The derived-coverage rule one self-citation certifies, or none:
 *  only an aliased wikilink to the hub itself, in a hub that has an
 *  origin with a directory part, anchors a chapter directory. */
function selfCitationRule(
  entry: string,
  origin: string | undefined,
  hub: string,
): SelfCitation | undefined {
  if (origin === undefined || wikilinkTarget(entry) !== hub) {
    return undefined;
  }

  const alias = wikilinkAlias(entry);
  const originDir = dirname(normalizeRawPath(origin));

  if (alias === undefined || originDir === "." || originDir === "/") {
    return undefined;
  }

  return { hub, originDir, alias };
}

/** True when a no-origin source hub's own raw path entry is an
 *  aliased self-citation whose coverage cannot be re-derived after
 *  a rewrite: rewriting it to `[[hub|Chapter]]` would silently drop
 *  the chapter path from `byOrigin`, `byCitation`, and `selfCitations`
 *  alike (the migration/check-provenance guard for issue #126). */
export function isUnmigratableSelfCitation(
  hubName: string,
  entry: string,
  hubs: SourceHubIndex,
): boolean {
  const hubFields = hubs.fields.get(hubName);

  if (hubFields?.type !== "source" || hubFields.origin !== undefined) {
    return false;
  }

  const mapped = wikilinkFor(entry, hubs);

  if (!("wikilink" in mapped)) {
    return false;
  }

  return (
    wikilinkTarget(mapped.wikilink) === hubName &&
    wikilinkAlias(mapped.wikilink) !== undefined
  );
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
  const selfCitations: SelfCitation[] = [];
  const ambiguous = new Set<string>();

  for (const file of files) {
    const parsed = parsePageFields(await readFile(join(wikiDir, file), "utf8"));

    fields.set(stem(file), parsed);

    if (parsed.type !== "source") {
      continue;
    }

    const name = stem(file);

    if (parsed.origin !== undefined) {
      cover(byOrigin, ambiguous, normalizeRawPath(parsed.origin), name);
    }

    for (const entry of parsed.sources) {
      if (!isWikilinkEntry(entry)) {
        cover(byCitation, ambiguous, normalizeRawPath(entry), name);

        continue;
      }

      const rule = selfCitationRule(entry, parsed.origin, name);

      if (rule !== undefined) {
        selfCitations.push(rule);
      }
    }
  }

  return { fields, byOrigin, byCitation, selfCitations, ambiguous };
}
