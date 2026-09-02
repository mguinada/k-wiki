import { readFileSync } from "node:fs";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";
import { actionableLines, parseReport } from "./mutation-survivors.ts";

// Renders the rolling survivor-issue body from a Stryker JSON report
// (issue #208): the actionable-mutant list in the exact format
// `npm run mutation:survivors` prints, plus links to the source run
// and its HTML report artifact. The mutants-report workflow captures
// stdout into the body of the rolling GitHub issue.

/** Links into the CI run the report came from. */
export interface ReportMeta {
  readonly runUrl?: string | undefined;
  readonly htmlUrl?: string | undefined;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-report <report.json> [--run-url <url>]
       [--html-url <url>] [-h | --help]

Render the rolling survivor-issue body from a Stryker
JSON report — the actionable mutants (Survived, NoCoverage) in the
same format npm run mutation:survivors prints, plus the run and
HTML-report links when given.

  <report.json>   Path to a Stryker reports/mutation/mutation.json.

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

/** The rolling-issue body for one report file's text. */
export function renderIssueBody(
  reportText: string,
  meta: ReportMeta = {},
): string {
  const lines = actionableLines(parseReport(reportText));

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

  if (lines.length === 0) {
    return [
      ...head,
      ...lead,
      "No actionable mutants — nothing survived, nothing uncovered.",
      "",
    ].join("\n");
  }

  return [
    ...head,
    ...lead,
    `Actionable mutants (${lines.length}) — kill or record as equivalent:`,
    "",
    "```",
    ...lines,
    "```",
    "",
  ].join("\n");
}

interface Options {
  reportPath: string;
  runUrl?: string | undefined;
  htmlUrl?: string | undefined;
}

/** Parse argv through the shared CLI shell — unknown options are
 *  rejected, never read as the report path — keeping the link flags'
 *  own value message; throws on a missing positional. */
function reportOptions(argv: readonly string[]): Options {
  const parsed = parseArgs(argv, {
    value: ["--run-url", "--html-url"],
    positionals: { max: 1, error: (arg) => `unexpected argument: ${arg}` },
  });

  if (parsed.error !== undefined) {
    throw new Error(parsed.error);
  }

  for (const flag of ["--run-url", "--html-url"] as const) {
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
    runUrl: parsed.values.get("--run-url"),
    htmlUrl: parsed.values.get("--html-url"),
  } as Options;
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

  try {
    console.log(
      renderIssueBody(text, {
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
