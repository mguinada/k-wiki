import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  buildPageIndex,
  isWikilinkEntry,
  listWikiPages,
  normalizeRawPath,
  readPageFields,
  wikilinkTarget,
} from "./pages.ts";
import { loadSourceHubIndex, wikilinkFor } from "./source-hubs.ts";

/**
 * Dead-provenance core (issue #65): the deterministic backstop that
 * catches any purge miss — and any sync/wiki drift of any kind. Every
 * `sources` wikilink on every wiki page must resolve to an existing
 * `type: source` page, and every `origin` raw path must exist under
 * `raw/`. A path-form `sources` entry (issue #126) must be backed by a
 * raw file AND must not be a path a `type: source` hub covers — a
 * covered path has a clickable wikilink, and citing the raw path
 * instead is dead-provenance drift. Coverage follows the shared hub
 * index (src/wiki/source-hubs.ts), the one rule the migration and the
 * guardrails also apply. The scripts/check-provenance CLI renders it;
 * the wiki-sync verification stage (issue #138) runs it every cycle.
 */

export interface ProvenanceReport {
  /** One `wiki/<page> -> …` line per dead-provenance problem. */
  readonly problems: readonly string[];
  /** `sources` wikilinks checked across all scanned pages. */
  readonly sources: number;
  /** `origin` fields checked. */
  readonly origins: number;
  /** `type: source` pages whose frontmatter lacks `origin`. */
  readonly missingOrigins: number;
  /** Markdown pages scanned under the wiki root. */
  readonly pages: number;
}

/** The raw projection must be a directory; named on failure. Shared
 *  with the fidelity core (issue #125). */
export async function assertRawDir(rawDir: string): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(rawDir)).isDirectory();
  } catch {
    throw new Error(`raw directory does not exist: ${rawDir}`);
  }

  if (!isDirectory) {
    throw new Error(`raw directory is not a directory: ${rawDir}`);
  }
}

/**
 * Check every wiki page under `wikiDirInput` against the raw projection
 * at `rawDirInput`, reporting problems with paths relative to the wiki
 * root's parent directory. A `sources` entry must be alive: a wikilink
 * entry resolves to an existing wiki page, a path entry to an existing
 * file under `raw/`; an `origin` must exist under `raw/`. Agent
 * contract files (AGENTS.md) are not wiki pages and are skipped.
 * Throws when either directory is missing.
 */
export async function checkWikiProvenance(
  wikiDirInput: string,
  rawDirInput: string,
): Promise<ProvenanceReport> {
  const wikiDir = resolve(wikiDirInput);
  const rawDir = resolve(rawDirInput);

  // listWikiPages asserts the wiki directory itself; only the raw
  // side needs its own check here.
  const files = await listWikiPages(wikiDir);

  await assertRawDir(rawDir);
  const index = buildPageIndex(files);
  const hubs = await loadSourceHubIndex(wikiDir);
  const problems: string[] = [];
  let sources = 0;
  let origins = 0;
  let missingOrigins = 0;

  for (const file of files) {
    const fields = await readPageFields(join(wikiDir, file));
    const page = relative(resolve(wikiDir, ".."), join(wikiDir, file));

    if (fields.type === "source" && fields.origin === undefined) {
      missingOrigins++;
    }

    for (const entry of fields.sources) {
      sources++;

      if (isWikilinkEntry(entry)) {
        const target = wikilinkTarget(entry);

        if (!index.has(target)) {
          problems.push(`${page} -> ${entry} (missing source page)`);

          continue;
        }

        if (hubs.fields.get(target)?.type !== "source") {
          problems.push(
            `${page} -> ${entry} (does not cite a type: source page)`,
          );
        }

        continue;
      }

      try {
        await stat(join(rawDir, normalizeRawPath(entry)));
      } catch {
        problems.push(`${page} -> sources ${entry} (missing under raw/)`);

        continue;
      }

      const mapped = wikilinkFor(entry, hubs);

      if ("wikilink" in mapped) {
        problems.push(
          `${page} -> sources ${entry} (path has hub ${mapped.wikilink} — use the wikilink)`,
        );
      }
    }

    if (fields.origin !== undefined) {
      origins++;

      try {
        await stat(join(rawDir, normalizeRawPath(fields.origin)));
      } catch {
        problems.push(
          `${page} -> origin ${fields.origin} (missing under raw/)`,
        );
      }
    }
  }

  return { problems, sources, origins, missingOrigins, pages: files.length };
}

/** The report's summary sentence — source links resolved and origins
 *  verified — shared by the check-provenance CLI's ok line and the
 *  wiki-sync digest (issue #138), so the two surfaces cannot drift
 *  apart. */
export function summarizeProvenance(report: ProvenanceReport): string {
  const links = `${report.sources} ${report.sources === 1 ? "source link resolves" : "source links resolve"}`;
  const origins = `${report.origins} ${report.origins === 1 ? "origin exists" : "origins exist"}`;

  return `${links}, ${origins} across ${report.pages} ${report.pages === 1 ? "page" : "pages"}`;
}
