/**
 * The read verbs' own --help texts (in-context verb help): one
 * contract per verb — usage line, switches with defaults, what it
 * writes, exit semantics — printed by the dispatcher for
 * `k-wiki <verb> -h|--help` and the reordered leading form. The
 * read verbs have no launcher, so their contract lives here, not
 * in a standalone help; the mirrored tests fail when a read verb
 * in the table lacks its scoped help.
 */

/** The instance-selection and checkout options every read verb
 *  takes — one authored block, interpolated into every verb's
 *  help so the five contracts cannot drift apart. */
const SHARED_OPTIONS = `  -w, --wiki <name>   Select the wiki instance — an alias in
                      sync.json's instances map first, then a
                      sync-<name>.json stem in the checkout root —
                      overriding the binding's wiki key. An unknown
                      name fails listing every known name.
  --checkout <path>   k-wiki checkout for this run (a ~ path
                      expands).`;

export const READ_VERB_HELP: Readonly<Record<string, string>> = {
  query: `Usage: k-wiki query [-h | --help] [-w, --wiki <name>] [--checkout <path>]
       [--timeout <secs>] "<question>"

Ask the bound wiki one question — the only LLM verb. The agent
reads the wiki's pages and writes one cited answer, printed to
stdout. The run is answer-only: a wiki/ change during the run
reverts and the run fails. Works on both doors.

Arguments:
  "<question>"   Exactly one question, quoted. An empty question
                 is a usage error.

Options:
${SHARED_OPTIONS}
  --timeout <secs>    Kill the agent run after this many seconds
                      and fail it. Default: 1800.
  -h, --help          This help; no side effects.

What it writes: the answer goes to stdout, progress to stderr;
the saved copy lands in the resolved instance's outputs directory
(outputs/last-query.md for the default instance,
outputs-<stem>/last-query.md for a named one). Filing the answer
into the wiki is a human step (k-wiki wiki-query --file-last, run
inside the checkout). Exit 0 always carries an answer — if the
wiki cannot answer, the answer says so; Exit 1 means the run
failed and nothing was saved. Errors print red, prefixed k-wiki:;
NO_COLOR is honored.`,
  status: `Usage: k-wiki status [-h | --help] [-w, --wiki <name>] [--checkout <path>]

Print the resolved binding: the checkout and where it came from
(the --checkout flag, the K_WIKI_CHECKOUT environment variable, a
.k-wiki.json binding, or the cwd itself), the instance, the sync
config, the settings file, the data repo, the outputs and wiki
directories, the index page, and the wiki's last change. Works on
both doors; run it before querying an unfamiliar project.

Options:
${SHARED_OPTIONS}
  -h, --help          This help; no side effects.

What it writes: nothing — the binding report goes to stdout.
Exit 0 prints the report; Exit 1 when resolution fails or an
instance is unknown, and the error names the cause. Errors print
red, prefixed k-wiki:; NO_COLOR is honored.`,
  list: `Usage: k-wiki list [-h | --help] [-w, --wiki <name>] [--checkout <path>] [<type>]

One "slug — title" line per wiki page, grouped by type, or
filtered to one type. Deterministic and free — no LLM run. Works
on both doors.

Arguments:
  <type>    Optional filter: concept|entity|source|query|comparison.
            An unknown type is a usage error; more than one
            argument is a usage error.

Options:
${SHARED_OPTIONS}
  -h, --help          This help; no side effects.

What it writes: nothing — the listing goes to stdout. Exit 0
lists the pages; Exit 1 for a usage error, a failed resolution,
or an unreadable wiki, and the error names the cause. Errors
print red, prefixed k-wiki:; NO_COLOR is honored.`,
  read: `Usage: k-wiki read [-h | --help] [-w, --wiki <name>] [--checkout <path>] <slug>

Print one wiki page verbatim, resolved by file name: the page
whose file name is <slug>.md, anywhere in the wiki tree.
Deterministic and free — no LLM run. Works on both doors.

Arguments:
  <slug>    Required, exactly one. An ambiguous name is a usage
            error listing the matches; an unknown name is a usage
            error listing near matches when any exist.

Options:
${SHARED_OPTIONS}
  -h, --help          This help; no side effects.

What it writes: nothing — the page goes to stdout. Exit 0 prints
the page; Exit 1 for a usage error, an unknown or ambiguous page,
or a failed resolution, and the error names the cause. Errors
print red, prefixed k-wiki:; NO_COLOR is honored.`,
  health: `Usage: k-wiki health [-h | --help] [-w, --wiki <name>] [--checkout <path>]
       [--fail-on-stale]

Check the bound instance's raw/ projection for coherence (every
manifest entry and projected note consistent) and freshness
(recent sync) — read-only, the same check check-raw runs. Works on
both doors; run it before trusting answers from a wiki.

Options:
${SHARED_OPTIONS}
  --fail-on-stale     Make a stale projection fail (Exit 1);
                      without the flag staleness is a warning and
                      exit stays 0.
  -h, --help          This help; no side effects.

What it writes: nothing — the summary goes to stdout, warnings
and problems to stderr. Exit 0 when coherent; Exit 1 when
incoherent, or stale with --fail-on-stale, or when resolution
fails, and the error names the cause. Errors print red, prefixed
k-wiki:; NO_COLOR is honored.`,
};
