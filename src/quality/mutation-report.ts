import { readFileSync } from "node:fs";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";
import {
  type Ledger,
  ledgerBlockLine,
  ledgerFromBody,
  ledgerLines,
  mergeLedger,
} from "./mutation-ledger.ts";
import { parseReport } from "./mutation-survivors.ts";

// Renders the rolling survivor-issue body from a Stryker JSON report
// (issue #208): the merged ledger's actionable-mutant list in the
// exact format `npm run mutation:survivors` prints, plus links to
// the source run and its HTML report artifact, plus the hidden
// ledger block the next filing merges on top of (issue #261 — the
// body is a merge-body ledger, never a replace-body snapshot).

/** Links into the CI run the report came from. */
export interface ReportMeta {
  readonly runUrl?: string | undefined;
  readonly htmlUrl?: string | undefined;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-report <report.json> [--prior-body <path>]
       [--absence-kills] [--run-url <url>] [--html-url <url>]
       [-h | --help]

Render the rolling survivor-issue body from a Stryker
JSON report — the merged actionable-mutant ledger, in the
same format npm run mutation:survivors prints, plus the run and
HTML-report links when given, plus a hidden HTML-comment JSON block
carrying the full ledger for the next merge.

  <report.json>   Path to a Stryker reports/mutation/mutation.json.

  --prior-body <path>
                  The rolling issue's current body. The fresh report
                  merges into its ledger: actionable verdicts upsert,
                  verified kills (Killed, Timeout) drop, entries the
                  report never generated stay (out of the run's
                  scope). Default: absent — an empty ledger, so a
                  fresh filing starts from the report alone.

  --absence-kills
                  The run covered all of src/ (a full dispatched
                  run): an entry absent from the report is dead and
                  drops. Default: absent entries stay — the windowed
                  nightly's partial scope must not wipe the ledger.

  --run-url <url> Link to the CI run the report came from. Default:
                  omitted — the body drops the line.

  --html-url <url>
                  Link to the run's HTML report artifact. Default:
                  omitted — the body drops the line.

  -h, --help      Print this help and exit; no side effects.

Writes the Markdown body to stdout. Exit 0 after rendering (even
with survivors — mutation testing is advisory and this renderer
must stay unusable as a gate); exit 1 when the report is missing,
unreadable, or not a Stryker report.`;

/** The rolling-issue body for one ledger. */
export function renderIssueBody(ledger: Ledger, meta: ReportMeta = {}): string {
  const lines = ledgerLines(ledger);

  const links = [
    meta.runUrl === undefined ? null : `- Source run: ${meta.runUrl}`,
    meta.htmlUrl === undefined
      ? null
      : `- HTML report artifact: ${meta.htmlUrl}`,
  ].filter((line): line is string => line !== null);

  const head = [
    "Mutation testing: actionable survivors — auto-filed from CI",
    "(issue #208). Advisory signal, never a gate. Kill survivors via",
    "the mutation-triage skill, or record equivalents in the PR body.",
  ];

  const lead = links.length === 0 ? [] : ["", ...links, ""];

  const list =
    lines.length === 0
      ? ["No actionable mutants — nothing survived, nothing uncovered."]
      : [
          `Actionable mutants (${lines.length}) — kill or record as equivalent:`,
          "",
          "```",
          ...lines,
          "```",
        ];

  return [...head, ...lead, ...list, "", ledgerBlockLine(ledger), ""].join(
    "\n",
  );
}

interface Options {
  reportPath: string;
  priorBodyPath?: string | undefined;
  absenceKills: boolean;
  runUrl?: string | undefined;
  htmlUrl?: string | undefined;
}

/** Parse argv through the shared CLI shell — unknown options are
 *  rejected, never read as the report path — keeping the link flags'
 *  own value message; throws on a missing positional. */
function reportOptions(argv: readonly string[]): Options {
  const parsed = parseArgs(argv, {
    value: ["--prior-body", "--run-url", "--html-url"],
    boolean: ["--absence-kills"],
    positionals: { max: 1, error: (arg) => `unexpected argument: ${arg}` },
  });

  if (parsed.error !== undefined) {
    throw new Error(parsed.error);
  }

  for (const flag of ["--prior-body", "--run-url", "--html-url"] as const) {
    if (parsed.values.has(flag) && parsed.values.get(flag) === undefined) {
      throw new Error(`${flag} requires a value`);
    }
  }

  const reportPath = parsed.positional[0];

  if (reportPath === undefined) {
    throw new Error("missing <report.json> — see --help");
  }

  return {
    reportPath,
    priorBodyPath: parsed.values.get("--prior-body"),
    absenceKills: parsed.flags.has("--absence-kills"),
    runUrl: parsed.values.get("--run-url"),
    htmlUrl: parsed.values.get("--html-url"),
  };
}

/** The prior body's text, "" when none was given; exits through the
 *  caller's error path when a given path cannot be read. */
function readPriorBody(path: string | undefined): string | undefined {
  if (path === undefined) {
    return "";
  }

  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  let options: Options;

  try {
    options = reportOptions(argv);
  } catch (cause) {
    console.error(errorMessage(cause));
    process.exitCode = 1;

    return;
  }

  let text: string;

  try {
    text = readFileSync(options.reportPath, "utf8");
  } catch {
    console.error(`cannot read the report at ${options.reportPath}`);
    process.exitCode = 1;

    return;
  }

  const priorBody = readPriorBody(options.priorBodyPath);

  if (priorBody === undefined) {
    console.error(`cannot read the prior body at ${options.priorBodyPath}`);
    process.exitCode = 1;

    return;
  }

  try {
    const merged = mergeLedger(ledgerFromBody(priorBody), parseReport(text), {
      absenceKills: options.absenceKills,
    });

    console.log(
      renderIssueBody(merged, {
        runUrl: options.runUrl,
        htmlUrl: options.htmlUrl,
      }),
    );
  } catch (cause) {
    console.error(
      cause instanceof Error && cause.message.includes("unexpected shape")
        ? `the report at ${options.reportPath} has an unexpected shape — ${cause.message}`
        : `cannot render the report at ${options.reportPath}`,
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/quality/mutation-report.ts` runs */
refuseDirectExecution(import.meta.url, "mutation-report", "dev");
