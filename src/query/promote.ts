/**
 * wiki-promote (issue #341, family 7 of the #289 epic): the
 * sandbox's only exit — the human's deliberate act of walking one
 * sandbox note into the main wiki with real provenance. The
 * `--file-last` shape verbatim (decision 7): a deterministic
 * template, the human supplies and approves `sources` (never
 * auto-derived, and each entry must re-derive from the raw/
 * projection — an existing `type: source` page with a live `origin`
 * — or the promotion is refused: the note earns provenance only
 * from the vault projection, never from sandbox lineage), page +
 * `index.md` + `log.md` as one unit with rollback, and a dirty tree
 * refused before anything starts. The sandbox-specific unit (edge
 * 1): page-in, sandbox-copy-deleted, one `promote: <slug>` commit;
 * an already-promoted slug has no note left and refuses. Born
 * libexec (decision 14): launcher `bin/libexec/wiki-promote`, verb
 * `k-wiki wiki-promote`, the CLI shell in wiki-promote.ts, the core
 * here beside the filing shape it copies — off-PATH is deliberate
 * friction on the authority act.
 * The promoted page must also clear the one-way citation wall: the
 * wall audit runs over the working tree before the commit, so a
 * promotion can never land what the next cycle's standing lint
 * would revert.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import type { RunContext } from "../cli/run-context.ts";
import { statIfExists } from "../cli/shared.ts";
import { porcelainStatus, runGit } from "../data/git.ts";
import { checkCitationWall } from "../sandbox/citations.ts";
import { readExpiresStamp } from "../sandbox/reaper.ts";
import { slugError } from "../sandbox/sandbox-run.ts";
import { sandboxNotePath } from "../sandbox/stamps.ts";
import {
  appendWikiLog,
  listWikiPages,
  normalizeRawPath,
  parsePageFields,
  readPageFields,
} from "../wiki/pages.ts";
import { buildPageIndex } from "../wiki/wiki-links.ts";
import {
  appendIndexEntry,
  type FilingTarget,
  indexEntryFor,
  readPreState,
  restoreTarget,
  rmIfCreated,
  textOrEmpty,
} from "./file-last.ts";

/** A page type's wiki directory and index section (guide §6/§11). */
const TYPE_DIRS: Readonly<Record<string, string>> = {
  concept: "concepts",
  entity: "entities",
  source: "sources",
  query: "queries",
  comparison: "comparisons",
};

/** A plain date-level stamp, the wiki's `YYYY-MM-DD` convention. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The human's sources entry as the template writes it: brackets
 *  stripped when supplied, anchors kept as typed. */
export function normalizeSourceEntry(entry: string): string {
  return entry.startsWith("[[") && entry.endsWith("]]")
    ? entry.slice(2, -2)
    : entry;
}

/** Drop the sandbox-mechanical frontmatter (the `via:`/`expires:`
 *  stamps, the agent-written `sources` block, the stale `updated`)
 *  while keeping every other line — then append the promotion date
 *  and the human-approved sources. */
function keepFrontmatterLines(block: readonly string[]): string[] {
  const kept: string[] = [];
  let inSources = false;

  for (const line of block) {
    if (/^(via|expires):/.test(line)) {
      continue;
    }

    if (/^sources:/.test(line)) {
      inSources = true;

      continue;
    }

    if (/^updated:/.test(line)) {
      continue;
    }

    if (inSources && /^\s+-\s/.test(line)) {
      continue;
    }

    inSources = false;
    kept.push(line);
  }

  return kept;
}

/** The promoted page: the note's own frontmatter minus its sandbox
 *  lineage, plus the promotion date and the human-approved sources,
 *  with the body byte-exact. */
export function templatePromotedPage(
  text: string,
  sources: readonly string[],
  date: string,
): string {
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    throw new Error("the sandbox note carries no frontmatter block");
  }

  const close = lines.indexOf("---", 1);

  if (close === -1) {
    throw new Error("the sandbox note's frontmatter block never closes");
  }

  return [
    "---",
    ...keepFrontmatterLines(lines.slice(1, close)),
    `updated: ${date}`,
    "sources:",
    ...sources.map((source) => `  - ${JSON.stringify(`[[${source}]]`)}`),
    "---",
    ...lines.slice(close + 1),
  ].join("\n");
}

/** The `wiki/log.md` audit entry one promotion appends (guide §12
 *  header format): what moved where, and the approved sources. */
export function promoteLogEntry(input: {
  readonly date: string;
  readonly title: string;
  readonly notePath: string;
  readonly pagePath: string;
  readonly sources: readonly string[];
}): string {
  const cited = input.sources.map((source) => `[[${source}]]`).join(", ");

  return [
    `## [${input.date}] promote | ${input.title}`,
    "",
    `Promoted ${input.notePath} to ${input.pagePath}; sources: ${cited}.`,
    "",
  ].join("\n");
}

/** Why one approved source does not trace to the raw projection;
 *  undefined when it does. */
async function sourceTraceError(
  wikiDir: string,
  rawDir: string,
  index: ReadonlyMap<string, string>,
  entry: string,
): Promise<string | undefined> {
  const name = entry.split("#")[0] ?? entry;
  const file = index.get(name);

  if (file === undefined) {
    return `no wiki page named "${name}" — sources must name existing source pages`;
  }

  const fields = await readPageFields(join(wikiDir, file));

  if (fields.type !== "source") {
    return `"${name}" is not a source page (type: ${fields.type ?? "absent"})`;
  }

  if (fields.origin === undefined) {
    return `"${name}" carries no origin — cannot trace it to the raw projection`;
  }

  const origin = join(rawDir, normalizeRawPath(fields.origin));

  return (await statIfExists(origin)) === undefined
    ? `"${name}"'s origin ${fields.origin} does not trace to raw/`
    : undefined;
}

/** Everything the validated refusal set approved: the plan the
 *  write, wall, and commit steps share. */
interface PromotionPlan {
  readonly run: RunContext;
  readonly slug: string;
  readonly sources: readonly string[];
  readonly date: string;
  readonly notePath: string;
  readonly pagePath: string;
  readonly noteText: string;
  readonly title: string;
  readonly section: string;
}

/** The pre-refusal state both refusal helpers read. */
interface NoteInput {
  readonly run: RunContext;
  readonly slug: string;
  readonly sources: readonly string[];
}

/** The dirty-tree refusal (decision 7): the one-commit unit must
 *  not absorb edits that predate the promotion. */
async function assertCleanTree(run: RunContext): Promise<void> {
  const status = await porcelainStatus(run.dataRoot, run.env);
  const paths = status.flatMap((entry) => [entry.path, entry.origin ?? []]);

  if (status.length > 0) {
    throw new Error(
      `promotion refused — the data repo is dirty (commit or revert first; the one-commit unit must not absorb unrelated edits): ${[...new Set(paths)].join(", ")}`,
    );
  }
}

/** The note refusals: the slug shape, the note's existence (an
 *  already-promoted slug has nothing to promote), its expiry
 *  (dead notes stay dead), and its type (the page must land in a
 *  typed directory). Returns the read note and its fields. */
async function readPromotableNote(input: NoteInput): Promise<{
  notePath: string;
  noteText: string;
  type: string;
  title: string;
}> {
  const shapeError = slugError(input.slug);

  if (shapeError !== undefined) {
    throw new Error(shapeError);
  }

  const notePath = sandboxNotePath(input.slug);
  const noteFile = join(input.run.dataRoot, notePath);

  if ((await statIfExists(noteFile)) === undefined) {
    throw new Error(
      `nothing to promote — ${notePath} does not exist (already promoted, reaped, or never proposed)`,
    );
  }

  const noteText = await readFile(noteFile, "utf8");
  const fields = parsePageFields(noteText);
  const expires = readExpiresStamp(noteText);
  const today = input.run.now().toISOString().slice(0, 10);

  if (expires !== undefined && ISO_DATE.test(expires) && expires < today) {
    throw new Error(
      `promotion refused — ${notePath} expired ${expires}; an expired note is dead by definition (re-derive it as a new proposal)`,
    );
  }

  if (!(fields.type !== undefined && fields.type in TYPE_DIRS)) {
    throw new Error(
      `promotion refused — the note's type ${JSON.stringify(fields.type)} is not a wiki page type (${Object.keys(TYPE_DIRS).join(", ")}); the promoted page must land in a typed directory`,
    );
  }

  return {
    notePath,
    noteText,
    type: fields.type,
    title: fields.title ?? input.slug,
  };
}

/** The provenance refusals: at least one approved source, every
 *  entry tracing to an existing `type: source` page with a live
 *  `origin` under raw/, and no main page already owning the slug
 *  (edge 2: renaming is the human's explicit act). */
async function traceSources(
  input: NoteInput,
  type: string,
): Promise<{ sources: readonly string[]; pagePath: string }> {
  const sources = [...new Set(input.sources.map(normalizeSourceEntry))];

  if (sources.length === 0) {
    throw new Error(
      "promotion refused — at least one source is required: promotion is how a note earns provenance",
    );
  }

  const index = buildPageIndex(await listWikiPages(input.run.wikiDir));

  if (index.has(input.slug)) {
    throw new Error(
      `promotion refused — a main page named "${input.slug}" already exists (${index.get(input.slug)}); renaming is the human's explicit act (re-propose under the new slug, then promote)`,
    );
  }

  const errors: string[] = [];

  for (const entry of sources) {
    const error = await sourceTraceError(
      input.run.wikiDir,
      input.run.rawDir,
      index,
      entry,
    );

    if (error !== undefined) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `promotion refused — sources do not trace to raw/: ${errors.join("; ")}`,
    );
  }

  return { sources, pagePath: `wiki/${TYPE_DIRS[type]}/${input.slug}.md` };
}

/** The unit's write step: the page, the index entry under the
 *  type's section, the log audit entry, and the sandbox copy's
 *  deletion — all before the wall check and the commit. */
async function writeUnit(plan: PromotionPlan, targets: PromotionTargets) {
  const wikiDir = plan.run.wikiDir;
  const pageFile = join(plan.run.dataRoot, plan.pagePath);

  await mkdir(dirname(pageFile), { recursive: true });
  await writeFile(
    pageFile,
    templatePromotedPage(plan.noteText, plan.sources, plan.date),
    "utf8",
  );
  await writeFile(
    join(wikiDir, "index.md"),
    appendIndexEntry(
      textOrEmpty(targets.index.state),
      indexEntryFor(plan.slug, plan.title),
      plan.section,
    ),
    "utf8",
  );
  await writeFile(
    join(wikiDir, "log.md"),
    appendWikiLog(
      textOrEmpty(targets.log.state),
      promoteLogEntry({
        date: plan.date,
        title: plan.title,
        notePath: plan.notePath,
        pagePath: plan.pagePath,
        sources: plan.sources,
      }),
    ),
    "utf8",
  );
  await rm(join(plan.run.dataRoot, plan.notePath));
}

/** The wall refusal: the promoted page itself must hold the
 *  one-way citation wall (a body link to a sandbox peer is a
 *  main→sandbox violation the next cycle would revert). */
async function assertWallHolds(plan: PromotionPlan): Promise<void> {
  const report = await checkCitationWall(plan.run.wikiDir);
  const own = report.problems.filter(
    (problem) =>
      problem.startsWith(`${plan.pagePath}:`) ||
      problem.startsWith(`${plan.pagePath} `),
  );

  if (own.length > 0) {
    throw new Error(
      `promotion refused — the promoted page violates the one-way citation wall: ${own.join("; ")}`,
    );
  }
}

/** The commit step: stage exactly the unit's four paths and leave
 *  one `promote: <slug>` commit. Returns the commit hash. */
async function commitPromotion(plan: PromotionPlan): Promise<string> {
  const { dataRoot, env } = plan.run;
  const paths = [plan.pagePath, "wiki/index.md", "wiki/log.md", plan.notePath];

  await runGit(dataRoot, ["add", "-A", "--", ...paths], env);
  await runGit(
    dataRoot,
    ["commit", "--quiet", "-m", `promote: ${plan.slug}`, "--", ...paths],
    env,
  );

  const { stdout } = await runGit(dataRoot, ["rev-parse", "HEAD"], env);

  return stdout.trim();
}

/** Roll a failed promotion back to its pre-run state: unstage the
 *  unit's paths, delete the created page, and restore index.md,
 *  log.md, and the deleted sandbox note. */
async function rollbackPromotion(
  plan: PromotionPlan,
  targets: PromotionTargets,
): Promise<void> {
  const paths = [plan.pagePath, "wiki/index.md", "wiki/log.md", plan.notePath];

  await runGit(
    plan.run.dataRoot,
    ["reset", "--quiet", "--", ...paths],
    plan.run.env,
  ).catch(() => {});
  await rmIfCreated(join(plan.run.dataRoot, plan.pagePath));
  await restoreTarget(targets.index);
  await restoreTarget(targets.log);
  await restoreTarget(targets.note);
}

/** The three pre-run states a rollback restores: index.md, log.md,
 *  and the sandbox note the unit deletes. */
interface PromotionTargets {
  readonly index: FilingTarget;
  readonly log: FilingTarget;
  readonly note: FilingTarget;
}

/** The promotion's input: the run context (built once at the CLI
 *  boundary from the instance's raw dir), the sandbox note's slug,
 *  and the human-approved sources, as typed. */
export interface PromoteOptions {
  readonly run: RunContext;
  readonly slug: string;
  readonly sources: readonly string[];
}

/** What one promotion did: where the page landed, and the commit. */
export interface PromoteResult {
  readonly pagePath: string;
  readonly commit: string;
}

/**
 * Promote one sandbox note into the main wiki: refuse (dirty tree,
 * dead or missing note, bad type, slug collision, untraceable
 * sources), then land page + index + log + note deletion as one
 * unit — wall-checked before the single `promote: <slug>` commit,
 * rolled back whole on any failure.
 */
export async function promoteSandboxNote(
  options: PromoteOptions,
): Promise<PromoteResult> {
  const note = await readPromotableNote(options);

  await assertCleanTree(options.run);

  const traced = await traceSources(options, note.type);
  const dir = TYPE_DIRS[note.type] ?? "";
  const plan: PromotionPlan = {
    run: options.run,
    slug: options.slug,
    sources: traced.sources,
    date: options.run.now().toISOString().slice(0, 10),
    notePath: note.notePath,
    pagePath: traced.pagePath,
    noteText: note.noteText,
    title: note.title,
    section: dir.charAt(0).toUpperCase() + dir.slice(1),
  };
  const indexPath = join(options.run.wikiDir, "index.md");
  const logPath = join(options.run.wikiDir, "log.md");
  const noteFile = join(options.run.dataRoot, note.notePath);
  const targets: PromotionTargets = {
    index: { path: indexPath, state: await readPreState(indexPath) },
    log: { path: logPath, state: await readPreState(logPath) },
    note: { path: noteFile, state: await readPreState(noteFile) },
  };

  try {
    await writeUnit(plan, targets);
    await assertWallHolds(plan);

    const commit = await commitPromotion(plan);

    options.run.onProgress(
      `wiki-promote: committed ${commit.slice(0, 8)} (promote: ${options.slug})`,
    );

    return { pagePath: plan.pagePath, commit };
  } catch (error) {
    await rollbackPromotion(plan, targets);
    options.run.onProgress(
      "wiki-promote: promotion failed — rolled back the page, index.md, log.md, and the sandbox note; nothing was promoted",
    );

    throw new Error(
      `promotion failed — rolled back, nothing was promoted: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
