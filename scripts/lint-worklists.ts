import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { parseArgs } from "../src/cli/shell.ts";
import {
  computeWikiWorklists,
  renderWorklists,
} from "../src/wiki/worklists.ts";

/**
 * The deterministic lint pre-pass as a CLI (issue #359, phase B):
 * print the worklists the lint prompt embeds — orphan,
 * single-source, sources→non-source, frontmatter, tag, index, and
 * duplicate-title candidates — so the generator's output is
 * inspectable without an agent run. Read-only: nothing is written,
 * no agent runs. The core lives in src/wiki/worklists.ts; the cycle
 * calls it in-process through src/sync/lint-stage.ts.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: lint-worklists [-h | --help] [<wiki-dir>]

Print the deterministic lint pre-pass worklists: the
candidate lists the lint prompt embeds so the agent judges, never
scans. One pass over the wiki tree produces them; every entry is a
candidate with its evidence, never a verdict.

  -h, --help    Print this help and exit; no side effects.
  <wiki-dir>    The wiki directory to scan. Default: the repo's
                own wiki/.

Sections:
  - Orphan candidates — pages with no inbound links
  - Single-source pages — exactly one sources entry
  - Sources → non-source edges — entries citing a missing or
    non-source page
  - Frontmatter field misses — required fields missing or empty
  - Tag inventory — every page's tags, as written
  - Pages missing from index.md — content pages the index never
    lists
  - Duplicate-title candidates — titles kebab-casing to one slug
  - Dangling index entries — index links with no target page

Writes nothing. Exits 0 with the report on stdout, 1 on a usage
error or an unreadable wiki directory. The sandbox namespace is
never listed (the shared walker excludes it).`;

/** lint-worklists entry point: `lint-worklists [-h | --help] [<wiki-dir>]`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    positionals: {
      max: 1,
      error: (arg) =>
        `unexpected argument ${JSON.stringify(arg)} — lint-worklists takes at most one <wiki-dir>`,
    },
  });

  if (parsed.error !== undefined) {
    cliFail("lint-worklists", parsed.error);

    return;
  }

  const wikiDir = parsed.positional[0] ?? join(repoRoot, "wiki");

  try {
    console.log(renderWorklists(await computeWikiWorklists(wikiDir)));
  } catch (error) {
    console.error(colors().red(`lint-worklists: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/lint-worklists.ts` runs */
refuseDirectExecution(import.meta.url, "lint-worklists", "bin/libexec");
