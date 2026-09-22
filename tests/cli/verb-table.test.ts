import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHelp,
  type VerbSpec,
  verbTable,
} from "../../src/cli/verb-table.ts";

/**
 * The verb-table drift guards (issue #337, decision 11): every
 * verb carries a class and a tier, every runtime launcher has its
 * 1:1 verb, the agent whitelist derives from the classes, and the
 * bare help lists every verb tiered porcelain-first. A new
 * launcher without its row — or a write-note verb without its
 * gate wiring — fails here.
 */

const binRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
);

/** Every runtime launcher basename under bin/ and bin/libexec/. */
async function launcherNames(): Promise<string[]> {
  const top = (await readdir(binRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const nested = await readdir(join(binRoot, "libexec"), {
    withFileTypes: true,
  });

  return [...top, ...nested.map((entry) => entry.name)].filter(
    (name) => name !== "k-wiki",
  );
}

/** The read-class verb names — k-wiki's own, no launcher. */
const READ_VERBS = ["query", "status", "list", "read", "health"];

describe("k-wiki verb table", () => {
  it("gives every verb a class of read, write-note, operator, or shell", () => {
    const classes = new Set(["read", "write-note", "operator", "shell"]);

    for (const verb of verbTable()) {
      expect(classes.has(verb.klass)).toBe(true);
    }
  });

  it("gives every verb a tier of porcelain, operator, or libexec", () => {
    const tiers = new Set(["porcelain", "operator", "libexec"]);

    for (const verb of verbTable()) {
      expect(tiers.has(verb.tier)).toBe(true);
    }
  });

  it("lists every runtime launcher 1:1 as an operator verb", async () => {
    const launchers = (await launcherNames()).sort();
    const dispatched = verbTable()
      .filter((verb) => verb.klass === "operator")
      .map((verb) => verb.name)
      .sort();

    expect(dispatched).toEqual(launchers);
  });

  it("keeps every write-note verb k-wiki's own and gated", () => {
    const writeNotes = verbTable()
      .filter((verb) => verb.klass === "write-note")
      .map((verb) => verb.name);

    expect(writeNotes).toEqual(["propose"]);
  });

  it("keeps every non-read verb wired to a dispatch main", () => {
    const unwired = verbTable().filter(
      (verb) => verb.klass !== "read" && verb.main === undefined,
    );

    expect(unwired.map((verb) => verb.name)).toEqual([]);
  });

  it("wires every write-note main to the sandbox domain (the gate's caller)", async () => {
    const propose = verbTable().find((verb) => verb.name === "propose");

    expect(propose?.klass).toBe("write-note");
    expect(propose?.main).toBeDefined();
  });

  it("keeps every read verb off the launcher mains", () => {
    const wired = verbTable().filter(
      (verb) => verb.klass === "read" && verb.main !== undefined,
    );

    expect(wired.map((verb) => verb.name)).toEqual([]);
  });

  it("wires every write-note verb to the sandbox gate", () => {
    const writeNotes = verbTable().filter(
      (verb: VerbSpec) => verb.klass === "write-note",
    );

    expect(
      writeNotes
        .filter((verb) => verb.gate !== "sandbox")
        .map((verb) => verb.name),
    ).toEqual([]);
  });

  it("gates no read or operator verb", () => {
    expect(
      verbTable()
        .filter(
          (verb) => verb.klass !== "write-note" && verb.gate !== undefined,
        )
        .map((verb) => verb.name),
    ).toEqual([]);
  });

  it("derives the agent whitelist from the verb classes", () => {
    const agentCommands = verbTable()
      .filter((verb) => verb.klass === "read" || verb.klass === "write-note")
      .map((verb) => verb.name);

    expect(agentCommands).toEqual([...READ_VERBS, "propose"]);
  });

  it("keeps every verb inside the porcelain spotlight list", () => {
    const porcelainVerbs = verbTable()
      .filter((verb) => verb.tier === "porcelain")
      .map((verb) => verb.name);

    expect(porcelainVerbs).toEqual([
      "query",
      "status",
      "list",
      "read",
      "health",
      "propose",
      "wiki-sync",
      "wiki-query",
    ]);
  });

  it("groups the bare help porcelain tier first", () => {
    const tiers = [
      "Daily (porcelain):",
      "Occasional operator:",
      "Maintenance (plumbing",
    ];

    const positions = tiers.map((heading) => buildHelp().indexOf(heading));

    expect(positions.every((pos) => pos !== -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names every verb of every tier in the bare help", () => {
    for (const name of verbTable().map((verb) => verb.name)) {
      expect(buildHelp()).toContain(`\n  ${name}`);
    }
  });

  it("documents the -w verbs in the global flag entry", () => {
    for (const verb of verbTable().filter((entry) => entry.wiki)) {
      expect(buildHelp()).toContain(verb.name);
    }
  });

  it("renders the bare help exactly (the shipped help contract)", () => {
    expect(
      buildHelp(),
    ).toBe(`Usage: k-wiki [-h | --help] | k-wiki <verb> [<args>]
       k-wiki <verb> -h | --help    one verb's own help

The one front door for every wiki operation: one command
vocabulary (the verbs are 1:1 with the bin/ and bin/libexec/
launcher names) dispatched by import — the same library the
standalone launchers run, never a spawned process. Which verbs
answer depends on the door, decided by checkout resolution:

  human door — run inside the checkout (the cwd itself is the
    checkout): every verb below; a flag-less run uses the
    checkout's root sync.json — the default instance,
    structural, never configured.
  agent door — run from a bound project (.k-wiki.json found
    walking up, the --checkout flag, or the K_WIKI_CHECKOUT env
    var): the read-only verbs only; operator verbs are refused
    with both escapes named. Every run but the shell verbs
    (k-wiki completion resolves no door) prints its door and
    instance (dim, stderr) so wrong-door and wrong-corpus calls are visible.

The base path, start to finish (human door, inside the checkout):
  k-wiki init-data-repo             once: seed the data repo
  k-wiki wiki-sync                  after every vault edit — the whole cycle
  k-wiki query "<question>"         ask the built wiki (any door)
  k-wiki list, k-wiki read <slug>   browse, deterministic and free
  k-wiki wiki-query --file-last     file a reviewed answer (human step)

Daily (porcelain):
  query       ask the bound wiki one question (the only LLM verb;
              answer-only: a wiki/ change during the run reverts and fails)
  status      print the resolved binding, paths, and last change
  list        one 'slug — title' line per page, grouped by type;
              filter: concept|entity|source|query|comparison
  read        print one page verbatim, resolved by file name
  health      projection coherence + freshness check (read-only)
  propose     file one candidate note under wiki/sandbox/ — the gated
              agent write; a human promotes it later
  wiki-sync   run the whole cycle and print the digest
  wiki-query  ask one question headless; --file-last files the
              reviewed answer (stage 2, the human step)

Occasional operator:
  init-data-repo   create and seed the data repo (once; idempotent)
  sync-vault       project every vault note into raw/ (deterministic)
  sync-repo        project a source repository verbatim into raw/ (meta)
  wiki-ingest      run the wiki agent over changed sources; write the digest
  wiki-lint        run the quality-lint agent alone; report to the data
                   repo's outputs/ (the retry door for a timed-out or skipped lint)
  dashboard        regenerate the static KPI dashboard (read-only)
  scheduled-run    run one unattended cycle (the launchd command)
  setup-schedule   register the launchd schedule
  setup-meta-sync  install the meta wiki's post-merge auto-sync hooks
  completion       emit the zsh completion script for this front door

Maintenance (plumbing — standalone under bin/libexec/ by design, not for backward compatibility; scripts and CI call them directly, each also answers k-wiki <verb> -h):
  check-raw         coherence (and staleness) of a raw/ projection
  check-links       every [[wikilink]] and heading anchor resolves
  check-crosslinks  one-way cross-wiki link discipline
  check-citations   one-way wall between the wiki and its wiki/sandbox/
                    namespace: links, embeds, sources, stamps
  check-provenance  every sources entry and origin is alive
  check-fidelity    quoted tokens trace to origins; titles match names
  backfill-origin   write origin on source pages lacking it; dry run first
  link-sources      migrate path-form sources entries to hub wikilinks
  anchor-citations  migrate aliased hub citations to chapter anchors
  invert-log        invert log.md to newest-first; lossless, one-way
  open-origin       emit an obsidian://open URI for a hub's origin
  wiki-promote      walk a sandbox note into the main wiki — one
                    unit, one commit, human-approved sources
  sync-watchdog     heartbeat watchdog — alert when the scheduled cycle's
                    stamp goes stale, missing, or unreadable

Every verb above also answers k-wiki <verb> -h (or --help) with
its own scoped help — usage, switches, defaults, what it writes,
and exit semantics.

Global flags (before or after the verb; the verb-first form is
canonical — k-wiki query -w meta):
  -w, --wiki <name>    Select the wiki instance — an alias in
                       sync.json's instances map first, then a
                       sync-<name>.json stem in the checkout root —
                       overriding the binding's wiki key. Taken by
                       query, status, list, read, health, propose, wiki-query, wiki-ingest, wiki-lint, wiki-promote;
                       identical in both positions.
  -h, --help           With no verb (or an unknown one) this
                       help; before or after a known verb, that
                       verb's own help.

Verb-specific flags come after the verb only — a verb flag
before the verb is a usage error; no flag changes meaning by
position. Read-verb and propose switches (after the verb):
  --checkout <path>    k-wiki checkout for this run (read and
                       propose verbs).
  --timeout <secs>     Kill the agent run after this many seconds
                       and fail it (query and propose). Default:
                       1800.
  --fail-on-stale      Make a stale projection fail health (exit 1).

Binding file .k-wiki.json (at the bound project's root):
  { "checkout": "~/k-wiki", "wiki": "meta", "settings": "settings-meta.yml" }
  checkout — a k-wiki checkout whose sync.json resolves the data
    repo; its prompts/, outputs/, and settings live there too.
  wiki — optional instance name inside the checkout: resolved
    through the checkout's registry — an alias in sync.json's
    instances map first, then a free stem sync-<name>.json in the
    checkout root — and every derived path follows the resolved
    config: its dataRoot is the data repo queried, and the saved
    answer goes to outputs-<stem>/ (outputs/ and settings.yml for
    the default instance, whose stem is sync.json). The -w/--wiki
    flag overrides this key. An unknown name fails listing every
    known name. Default: absent — the default instance.
  settings — optional non-default settings file inside the
    checkout; overrides the instance's derived settings file.
  Gitignore the file in personal projects; commit it in team
  projects.

Checkout resolution order (first hit wins, every verb):
  1. --checkout <path>   this run's checkout (a ~ path is expanded)
  2. K_WIKI_CHECKOUT     environment variable naming a checkout
  3. .k-wiki.json        nearest binding found walking up from the
                         cwd, stopping at the home directory or
                         the filesystem root
  4. the cwd itself      the human door: run from inside the
                         checkout

What it writes: query writes <checkout>/outputs/last-query.md and
prints the answer; the other read verbs write nothing; operator
verbs write what their own help documents (k-wiki <verb> -h).
Errors print red, prefixed "k-wiki:", and exit 1. Progress, the
door and instance lines, and the filing hint go to stderr;
NO_COLOR is honored. Human alias, optional:
alias k-wiki='node ~/k-wiki/bin/k-wiki'

If you are an AI agent, follow these instructions:
  - Run: k-wiki query "<question>" — zero flags inside a bound
    project.
  - The answer is stdout, nothing else. Progress goes to stderr;
    ignore it.
  - Exit 0 always carries an answer. If the wiki cannot answer,
    the answer says so and suggests sources — report that, do
    not retry.
  - Exit 1 means the run failed and nothing was saved; the error
    on stderr names the cause. Retry only if the cause is
    transient.
  - You cannot file the answer anywhere; filing is a human step
    (k-wiki wiki-query --file-last, run by the human inside the
    checkout). Do not attempt wiki writes.
  - k-wiki status shows which wiki you are bound to and how fresh
    it is (last change); run it before querying an unfamiliar
    project.
  - k-wiki list [type] and k-wiki read <slug> browse the wiki
    deterministically (no tokens); k-wiki health checks the
    projection before you trust answers from it.
  - Operator verbs (wiki-sync, wiki-ingest, and the rest of the
    table) are not available on the agent door — a binding
    resolves there and the refusal names both escapes. Ask the
    human.`);
  });
});
