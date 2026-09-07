/**
 * The wiki-promote CLI (issue #341, split from promote.ts so the
 * promotion module carries no argv parsing): the help text, the
 * flag derivation on the shared shell, and the main() entry point.
 * The promotion itself lives in promote.ts.
 */

import { homedir } from "node:os";
import { cliFail, errorMessage, terminalColors } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { runContext } from "../cli/run-context.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";
import { resolveWikiInstance, wikiArgError } from "../sync/instance.ts";
import { promoteSandboxNote } from "./promote.ts";

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: wiki-promote [-h | --help] [--wiki, -w <name>] [--raw-dir <dir>] <slug> --sources "<source page>" [--sources "<source page>"...]

Walk one sandbox note into the main wiki — the sandbox's only
exit, the human's deliberate act. Deterministic code, no agent,
zero tokens: the note's body lands byte-exact as a main page under
its type directory, its sandbox stamps (via:, expires:) and any
agent-written sources are dropped, and the human-approved sources
are written in — the note earns provenance only from the vault
projection, never from sandbox lineage.

The promotion is one unit with one commit (promote: <slug>): the
page lands under wiki/<type-directory>/<slug>.md, index.md gains
its entry under the type's section, log.md gains its audit entry,
and the sandbox copy is deleted — a failure anywhere rolls all of
it back and nothing is promoted.

Review first: read wiki/sandbox/<slug>.md (k-wiki read, or any
editor), then promote with exactly the sources you approve.

Refusals (exit 1, nothing written):
  - a dirty data repo (commit or revert first)
  - no sandbox note for the slug (already promoted, reaped, or
    never proposed)
  - an expired note (dead by definition; re-derive it as a new
    proposal)
  - a note whose type is not a wiki page type (concept, entity,
    source, query, comparison)
  - a slug colliding with an existing main page (renaming is the
    human's explicit act: re-propose under the new slug, then
    promote)
  - sources that do not trace to raw/: every --sources entry must
    name an existing type: source page whose origin exists under
    the raw projection (a bracketed "[[name]]" entry is accepted;
    an anchored "[[hub#Chapter]]" entry validates its hub)
  - a promoted page that would violate the one-way citation wall
    (a body link to a sandbox peer)

Switches and arguments:
  <slug>               The sandbox note's slug — wiki/sandbox/<slug>.md.
  --sources <name>     One approved source page name; repeat the
                       flag for several (order preserved). At least
                       one is required. Bracketed and anchored
                       forms are accepted.
  --wiki, -w <name>    Select the wiki instance: an alias in the
                       checkout's sync.json instances map first,
                       then a sync-<name>.json stem in the checkout
                       root; the resolved config's data repo is
                       promoted into. Default: the default instance.
  --raw-dir <dir>      raw/ directory of the data repo to promote
                       in; its parent is the data repo root.
                       Default: <dataRoot>/raw from the resolved
                       instance's sync config; an explicit flag
                       overrides it.
  -h, --help           Print this help and exit; no side effects.

What it writes: one data-repo commit (promote: <slug>) adding
wiki/<type-directory>/<slug>.md with the index.md and log.md
entries and deleting wiki/sandbox/<slug>.md. Prints "Promoted:
<path> (commit <hash>)" on stdout; progress goes to stderr (dim).
Errors print red, prefixed "wiki-promote:", and exit 1. NO_COLOR is
honored. This is a human-door verb: k-wiki wiki-promote from inside
the checkout, or the standalone bin/libexec/wiki-promote launcher;
it is not available on the agent door.`;

/** Print one CLI usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("wiki-promote", message);
}

/** The collected --sources values, undefined entries refused. */
function sourcesFrom(
  repeated: ReadonlyMap<string, readonly (string | undefined)[]>,
): string[] | undefined {
  const values = repeated.get("--sources") ?? [];

  if (values.some((value) => value === undefined || value.trim() === "")) {
    return undefined;
  }

  return values as string[];
}

/** wiki-promote entry point: `wiki-promote [-h | --help] [--wiki, -w <name>] [--raw-dir <dir>] <slug> --sources "<source page>" [--sources "<source page>"...]`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    value: ["--raw-dir", "--wiki"],
    repeat: ["--sources"],
    alias: new Map([["-w", "--wiki"]]),
    positionals: {
      max: 1,
      error: (arg, count) =>
        `expected exactly one <slug> argument, got ${count} (first extra: ${JSON.stringify(arg)})`,
    },
  });

  if (parsed.error !== undefined) {
    fail(parsed.error);

    return;
  }

  const wikiError = wikiArgError(parsed.values);

  if (wikiError !== undefined) {
    fail(wikiError);

    return;
  }

  const sources = sourcesFrom(parsed.repeated);

  if (sources === undefined) {
    fail("every --sources entry needs a source page name");

    return;
  }

  const slug = parsed.positional[0];

  if (slug === undefined) {
    fail('a slug is required: wiki-promote <slug> --sources "<source page>"');

    return;
  }

  if (sources.length === 0) {
    fail(
      'at least one --sources "<source page>" entry is required — promotion is how a note earns provenance; supply the source pages you approve',
    );

    return;
  }

  try {
    const instance = await resolveWikiInstance({
      checkout: repoRoot,
      name: parsed.values.get("--wiki"),
      home: homedir(),
    });
    const rawDir = parsed.values.get("--raw-dir") ?? instance.rawDir;
    const run = runContext({
      rawDir,
      onProgress: (message) => {
        console.error(terminalColors().dim(message));
      },
    });
    const result = await promoteSandboxNote({ run, slug, sources });

    console.log(
      terminalColors().bold(
        `Promoted: ${result.pagePath} (commit ${result.commit.slice(0, 8)})`,
      ),
    );
  } catch (error) {
    cliFail("wiki-promote", errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/query/promote.ts` runs */
refuseDirectExecution(import.meta.url, "wiki-promote");
