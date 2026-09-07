/**
 * The k-wiki verb table (issue #337): the full human-door command
 * vocabulary — one row per verb, 1:1 with the `bin/` and
 * `bin/libexec/` launcher basenames (the read verbs and `propose`
 * are k-wiki's own) — with the mandatory class per verb (decision
 * 11): `read` (both doors), `write-note` (agent-door gated
 * writes — `propose`, the sandbox write, issue #340), and
 * `operator` (human door only; redirection is incoherent for
 * pipeline verbs). The tiers are the #287 grouping the bare help
 * prints, porcelain first. The bare help itself is assembled from
 * this table, so help and dispatch cannot drift. A drift guard in
 * tests/cli/verb-table.test.ts fails CI on a launcher without its
 * verb row and on a write-note verb not wired to its gate.
 */

import { main as anchorCitations } from "../../scripts/anchor-citations.ts";
import { main as backfillOrigin } from "../../scripts/backfill-origin.ts";
import { main as checkCitations } from "../../scripts/check-citations.ts";
import { main as checkCrosslinks } from "../../scripts/check-crosslinks.ts";
import { main as checkFidelity } from "../../scripts/check-fidelity.ts";
import { main as checkLinks } from "../../scripts/check-links.ts";
import { main as checkProvenance } from "../../scripts/check-provenance.ts";
import { main as linkSources } from "../../scripts/link-sources.ts";
import { main as openOrigin } from "../../scripts/open-origin.ts";
import { main as dashboard } from "../dashboard/generate.ts";
import { main as checkRawCli } from "../health/check-raw.ts";
import { main as wikiIngest } from "../ingest/wiki-ingest-cli.ts";
import { main as wikiPromote } from "../query/wiki-promote.ts";
import { main as wikiQuery } from "../query/wiki-query.ts";
import { runProposeVerb as propose } from "../sandbox/propose.ts";
import { main as scheduledRun } from "../schedule/scheduled-run.ts";
import { main as setupMetaSync } from "../schedule/setup-meta-sync.ts";
import { main as setupSchedule } from "../schedule/setup-schedule.ts";
import { main as syncRepo } from "../sync/sync-repo.ts";
import { main as syncVault } from "../sync/sync-vault.ts";
import { main as wikiSync } from "../sync/wiki-sync.ts";
import { main as initDataRepo } from "./init-data-repo.ts";

/** The authority class a verb carries (decision 11): `read` verbs
 *  answer on both doors; `write-note` verbs are the agent door's
 *  gated writes (the class exists from day one — the first,
 *  `propose`, lands with the sandbox family); `operator` verbs are
 *  pipeline verbs, human door only — redirection is incoherent for
 *  them. */
export type VerbClass = "read" | "write-note" | "operator";

/** The #287 tier a verb belongs to — the bare-help grouping. */
export type VerbTier = "porcelain" | "operator" | "libexec";

/** One verb table row: name 1:1 with its launcher basename (the
 *  read verbs are k-wiki's own), its class and tier, whether it
 *  takes `-w`/`--wiki`, its help lines, and its dispatch target. */
export interface VerbSpec {
  readonly name: string;
  readonly klass: VerbClass;
  readonly tier: VerbTier;
  /** Accepts `-w`/`--wiki <name>` — identical in both positions. */
  readonly wiki: boolean;
  /** Help lines: the first follows the verb name, the rest indent. */
  readonly lines: readonly string[];
  /** The gate a write-note verb is wired to (decision 11): the
   *  agent-door write path. Undefined for every other class. */
  readonly gate?: "sandbox";
  /** The dispatch main (operator and write-note verbs — the
   *  write-note main is the gate's caller); read verbs run through
   *  runAgentVerbs and carry none. */
  readonly main?: (args: readonly string[]) => Promise<void>;
}

/** The verb table — the full human-door vocabulary, grouped by
 *  tier. A new launcher lands with its row in the same change (the
 *  drift guard in tests/cli/k-wiki.test.ts fails otherwise). */
export const VERBS: readonly VerbSpec[] = [
  {
    name: "query",
    klass: "read",
    tier: "porcelain",
    wiki: true,
    lines: [
      "ask the bound wiki one question (the only LLM verb;",
      "answer-only: a wiki/ change during the run reverts and fails)",
    ],
  },
  {
    name: "status",
    klass: "read",
    tier: "porcelain",
    wiki: true,
    lines: ["print the resolved binding, paths, and last change"],
  },
  {
    name: "list",
    klass: "read",
    tier: "porcelain",
    wiki: true,
    lines: [
      "one 'slug — title' line per page, grouped by type;",
      "filter: concept|entity|source|query|comparison",
    ],
  },
  {
    name: "read",
    klass: "read",
    tier: "porcelain",
    wiki: true,
    lines: ["print one page verbatim, resolved by file name"],
  },
  {
    name: "health",
    klass: "read",
    tier: "porcelain",
    wiki: true,
    lines: ["projection coherence + freshness check (read-only)"],
  },
  {
    name: "propose",
    klass: "write-note",
    tier: "porcelain",
    wiki: true,
    gate: "sandbox",
    lines: [
      "file one candidate note under wiki/sandbox/ — the gated",
      "agent write; a human promotes it later",
    ],
    main: propose,
  },
  {
    name: "wiki-sync",
    klass: "operator",
    tier: "porcelain",
    wiki: false,
    lines: ["run the whole cycle and print the digest"],
    main: wikiSync,
  },
  {
    name: "wiki-query",
    klass: "operator",
    tier: "porcelain",
    wiki: true,
    lines: [
      "ask one question headless; --file-last files the",
      "reviewed answer (stage 2, the human step)",
    ],
    main: wikiQuery,
  },
  {
    name: "init-data-repo",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["create and seed the data repo (once; idempotent)"],
    main: initDataRepo,
  },
  {
    name: "sync-vault",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["project every vault note into raw/ (deterministic)"],
    main: syncVault,
  },
  {
    name: "sync-repo",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["project a source repository verbatim into raw/ (meta)"],
    main: syncRepo,
  },
  {
    name: "wiki-ingest",
    klass: "operator",
    tier: "operator",
    wiki: true,
    lines: ["run the wiki agent over changed sources; write the digest"],
    main: wikiIngest,
  },
  {
    name: "dashboard",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["regenerate the static KPI dashboard (read-only)"],
    main: dashboard,
  },
  {
    name: "scheduled-run",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["run one unattended cycle (the launchd command)"],
    main: scheduledRun,
  },
  {
    name: "setup-schedule",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["register the launchd schedule"],
    main: setupSchedule,
  },
  {
    name: "setup-meta-sync",
    klass: "operator",
    tier: "operator",
    wiki: false,
    lines: ["install the meta wiki's post-merge auto-sync hooks"],
    main: setupMetaSync,
  },
  {
    name: "check-raw",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["coherence (and staleness) of a raw/ projection"],
    main: checkRawCli,
  },
  {
    name: "check-links",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["every [[wikilink]] and heading anchor resolves"],
    main: checkLinks,
  },
  {
    name: "check-crosslinks",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["one-way cross-wiki link discipline"],
    main: checkCrosslinks,
  },
  {
    name: "check-citations",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: [
      "one-way wall between the wiki and its wiki/sandbox/",
      "namespace: links, embeds, sources, stamps",
    ],
    main: checkCitations,
  },
  {
    name: "check-provenance",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["every sources entry and origin is alive"],
    main: checkProvenance,
  },
  {
    name: "check-fidelity",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["quoted tokens trace to origins; titles match names"],
    main: checkFidelity,
  },
  {
    name: "backfill-origin",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["write origin on source pages lacking it; dry run first"],
    main: backfillOrigin,
  },
  {
    name: "link-sources",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["migrate path-form sources entries to hub wikilinks"],
    main: linkSources,
  },
  {
    name: "anchor-citations",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["migrate aliased hub citations to chapter anchors"],
    main: anchorCitations,
  },
  {
    name: "open-origin",
    klass: "operator",
    tier: "libexec",
    wiki: false,
    lines: ["emit an obsidian://open URI for a hub's origin"],
    main: openOrigin,
  },
  {
    name: "wiki-promote",
    klass: "operator",
    tier: "libexec",
    wiki: true,
    lines: [
      "walk a sandbox note into the main wiki — one",
      "unit, one commit, human-approved sources",
    ],
    main: wikiPromote,
  },
];

/** The verb names, in table order (the full human-door table). */
export const VERB_NAMES = VERBS.map((verb) => verb.name);

/** The agent-door whitelist (decision 11): every verb whose class
 *  is not operator — the read verbs plus the write-note `propose`;
 *  another gated write-note verb joins by its class. Drift-guarded
 *  against the k-wiki skill by tests/cli/k-wiki-skill.test.ts. */
export const AGENT_COMMANDS: readonly string[] = VERBS.filter(
  (verb) => verb.klass !== "operator",
).map((verb) => verb.name);

/** The porcelain tier's names — the bare-help spotlight. */
export const PORCELAIN_VERBS: readonly string[] = VERBS.filter(
  (verb) => verb.tier === "porcelain",
).map((verb) => verb.name);

/** The tier headings of the bare help (the #287 tiers, porcelain
 *  first — the simple-first rule). */
const TIER_SECTIONS: readonly {
  readonly tier: VerbTier;
  readonly heading: string;
}[] = [
  { tier: "porcelain", heading: "Daily (porcelain):" },
  { tier: "operator", heading: "Occasional operator:" },
  {
    tier: "libexec",
    heading:
      "Maintenance (plumbing — standalone under bin/libexec/ by design, not for backward compatibility; scripts and CI call them directly, each also answers k-wiki <verb> -h):",
  },
];

/** The column width of one tier's verb names, for help alignment. */
function nameWidth(tier: VerbTier): number {
  return Math.max(
    ...VERBS.filter((verb) => verb.tier === tier).map(
      (verb) => verb.name.length,
    ),
  );
}

/** One tier's help block: every verb name padded, first line on the
 *  name row, the rest indented to the same column. */
function tierBlock({
  tier,
  heading,
}: {
  readonly tier: VerbTier;
  readonly heading: string;
}): string[] {
  const width = nameWidth(tier);
  const rows = VERBS.filter((verb) => verb.tier === tier).map((verb) => {
    const [first, ...rest] = verb.lines;

    return [
      `  ${verb.name.padEnd(width)}  ${first ?? ""}`,
      ...rest.map((line) => `${" ".repeat(width + 4)}${line}`),
    ].join("\n");
  });

  return [heading, ...rows, ""];
}

/** Help text: every verb (tiered, porcelain first — simple-first),
 *  the base path, both doors, the global flags, the binding file,
 *  and the agent contract (AGENTS.md CLI rule: every switch,
 *  argument, and default). */
export const HELP = [
  "Usage: k-wiki [-h | --help] | k-wiki <verb> [<args>]",
  "       k-wiki <verb> -h | --help    one verb's own help",
  "",
  "The one front door for every wiki operation: one command",
  "vocabulary (the verbs are 1:1 with the bin/ and bin/libexec/",
  "launcher names) dispatched by import — the same library the",
  "standalone launchers run, never a spawned process. Which verbs",
  "answer depends on the door, decided by checkout resolution:",
  "",
  "  human door — run inside the checkout (the cwd itself is the",
  "    checkout): every verb below; a flag-less run uses the",
  "    checkout's root sync.json — the default instance,",
  "    structural, never configured.",
  "  agent door — run from a bound project (.k-wiki.json found",
  "    walking up, the --checkout flag, or the K_WIKI_CHECKOUT env",
  "    var): the read-only verbs only; operator verbs are refused",
  "    with both escapes named. Every run prints its door and",
  "    instance (dim, stderr) so wrong-door and wrong-corpus calls",
  "    are visible.",
  "",
  "The base path, start to finish (human door, inside the checkout):",
  "  k-wiki init-data-repo             once: seed the data repo",
  "  k-wiki wiki-sync                  after every vault edit — the whole cycle",
  '  k-wiki query "<question>"         ask the built wiki (any door)',
  "  k-wiki list, k-wiki read <slug>   browse, deterministic and free",
  "  k-wiki wiki-query --file-last     file a reviewed answer (human step)",
  "",
  ...TIER_SECTIONS.flatMap(tierBlock),
  "Every verb above also answers k-wiki <verb> -h (or --help) with",
  "its own scoped help — usage, switches, defaults, what it writes,",
  "and exit semantics.",
  "",
  "Global flags (before or after the verb; the verb-first form is",
  "canonical — k-wiki query -w meta):",
  "  -w, --wiki <name>    Select the wiki instance — an alias in",
  "                       sync.json's instances map first, then a",
  "                       sync-<name>.json stem in the checkout root —",
  "                       overriding the binding's wiki key. Taken by",
  `                       ${VERBS.filter((verb) => verb.wiki)
    .map((verb) => verb.name)
    .join(", ")};`,
  "                       identical in both positions.",
  "  -h, --help           With no verb (or an unknown one) this",
  "                       help; before or after a known verb, that",
  "                       verb's own help.",
  "",
  "Verb-specific flags come after the verb only — a verb flag",
  "before the verb is a usage error; no flag changes meaning by",
  "position. Read-verb and propose switches (after the verb):",
  "  --checkout <path>    k-wiki checkout for this run (read and",
  "                       propose verbs).",
  "  --timeout <secs>     Kill the agent run after this many seconds",
  "                       and fail it (query and propose). Default:",
  "                       1800.",
  "  --fail-on-stale      Make a stale projection fail health (exit 1).",
  "",
  "Binding file .k-wiki.json (at the bound project's root):",
  '  { "checkout": "~/k-wiki", "wiki": "meta", "settings": "settings-meta.yml" }',
  "  checkout — a k-wiki checkout whose sync.json resolves the data",
  "    repo; its prompts/, outputs/, and settings live there too.",
  "  wiki — optional instance name inside the checkout: resolved",
  "    through the checkout's registry — an alias in sync.json's",
  "    instances map first, then a free stem sync-<name>.json in the",
  "    checkout root — and every derived path follows the resolved",
  "    config: its dataRoot is the data repo queried, and the saved",
  "    answer goes to outputs-<stem>/ (outputs/ and settings.yml for",
  "    the default instance, whose stem is sync.json). The -w/--wiki",
  "    flag overrides this key. An unknown name fails listing every",
  "    known name. Default: absent — the default instance.",
  "  settings — optional non-default settings file inside the",
  "    checkout; overrides the instance's derived settings file.",
  "  Gitignore the file in personal projects; commit it in team",
  "  projects.",
  "",
  "Checkout resolution order (first hit wins, every verb):",
  "  1. --checkout <path>   this run's checkout (a ~ path is expanded)",
  "  2. K_WIKI_CHECKOUT     environment variable naming a checkout",
  "  3. .k-wiki.json        nearest binding found walking up from the",
  "                         cwd, stopping at the home directory or",
  "                         the filesystem root",
  "  4. the cwd itself      the human door: run from inside the",
  "                         checkout",
  "",
  "What it writes: query writes <checkout>/outputs/last-query.md and",
  "prints the answer; the other read verbs write nothing; operator",
  "verbs write what their own help documents (k-wiki <verb> -h).",
  'Errors print red, prefixed "k-wiki:", and exit 1. Progress, the',
  "door and instance lines, and the filing hint go to stderr;",
  "NO_COLOR is honored. Human alias, optional:",
  "alias k-wiki='node ~/k-wiki/bin/k-wiki'",
  "",
  "If you are an AI agent, follow these instructions:",
  '  - Run: k-wiki query "<question>" — zero flags inside a bound',
  "    project.",
  "  - The answer is stdout, nothing else. Progress goes to stderr;",
  "    ignore it.",
  "  - Exit 0 always carries an answer. If the wiki cannot answer,",
  "    the answer says so and suggests sources — report that, do",
  "    not retry.",
  "  - Exit 1 means the run failed and nothing was saved; the error",
  "    on stderr names the cause. Retry only if the cause is",
  "    transient.",
  "  - You cannot file the answer anywhere; filing is a human step",
  "    (k-wiki wiki-query --file-last, run by the human inside the",
  "    checkout). Do not attempt wiki writes.",
  "  - k-wiki status shows which wiki you are bound to and how fresh",
  "    it is (last change); run it before querying an unfamiliar",
  "    project.",
  "  - k-wiki list [type] and k-wiki read <slug> browse the wiki",
  "    deterministically (no tokens); k-wiki health checks the",
  "    projection before you trust answers from it.",
  "  - Operator verbs (wiki-sync, wiki-ingest, and the rest of the",
  "    table) are not available on the agent door — a binding",
  "    resolves there and the refusal names both escapes. Ask the",
  "    human.",
].join("\n");
