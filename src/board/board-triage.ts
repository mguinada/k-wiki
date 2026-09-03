import { appendFile } from "node:fs/promises";
import { cliFail, errorMessage, terminalColors } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";
import {
  DEFAULT_OWNER,
  DEFAULT_PROJECT,
  type GraphQLFn,
  ghGraphQL,
  runBoardTriage,
  type TriageOptions,
} from "./triage-board.ts";
import type { TriageReport } from "./triage-rules.ts";

/**
 * board-triage: the scheduled triage CLI (issue #209). Composes the
 * split halves (issue #259) — the pure decision rules
 * (triage-rules.ts), the strict response decoding (triage-decode.ts),
 * and the gh/GraphQL infrastructure (triage-board.ts) — with the
 * rendering (stderr colors, the GitHub Actions job summary) and the
 * argv boundary. Run through dev/board-triage.ts; the mechanical
 * half of the triage-issues skill, applied to a board's Status field
 * only.
 */

/** The report as a GitHub Actions job-summary block. */
export function stepSummaryMarkdown(report: TriageReport): string {
  const heading = `## Board triage${report.dryRun ? " (dry run)" : ""}`;
  const items = report.lines.map((line) => `- ${line.text}`);

  return `${[heading, "", ...items, "", report.summary].join("\n")}\n`;
}

async function writeStepSummary(
  report: TriageReport,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const target = env.GITHUB_STEP_SUMMARY;

  if (target !== undefined && target !== "") {
    await appendFile(target, stepSummaryMarkdown(report));
  }
}

function renderReport(report: TriageReport): void {
  const colors = terminalColors();

  for (const line of report.lines) {
    if (line.level === "error") {
      console.error(colors.red(line.text));
    } else if (line.level === "move") {
      console.log(colors.green(line.text));
    } else {
      console.log(colors.dim(line.text));
    }
  }

  if (report.ok) {
    console.log(colors.green(report.summary));
  } else {
    console.error(colors.red(report.summary));
  }
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: board-triage [-h | --help] [--dry-run] [--owner <login>] [--project <number>]

Apply the mechanical half of the K-Wiki Kanban triage contract (the
triage-issues skill) to a GitHub Projects board — Status lane moves
only, never the issues themselves:

  - a closed issue not on Done moves to Done (from any lane)
  - a Backlog issue with an open PR cross-reference moves to In progress
  - a Backlog issue with no open blocker and no 'research' label moves to Ready
  - a Backlog issue blocked by an open issue, or labeled 'research', stays
  - open issues on Ready / In progress / In review are never touched
  - lane order is never touched — Ready sequencing stays with triage runs

Project, Status field, and option IDs are resolved fresh from the board
every run; nothing is hardcoded. Every applied move is verified by
re-reading the board; a mismatch is retried once, and a move that
still fails verification is reported as an error (exit 1). A
mid-run API failure fails the run naming the moves already applied,
each verified against a fresh board read.

Authentication is the gh CLI: the keyring login locally (a local
GITHUB_TOKEN env var is ignored — its repo scope cannot write
projects), GH_TOKEN in GitHub Actions (a PAT with project write
access). When GITHUB_STEP_SUMMARY is set, the report is also appended
to the job summary.

Writes: board Status field values only — never issues, labels,
bodies, or lane order. --dry-run reads the board and prints the plan
with zero writes.

  -h, --help        Print this help and exit; no side effects.
  --dry-run         Print every planned move and stay without writing.
  --owner <login>   The project owner. Default: ${DEFAULT_OWNER}.
  --project <n>     The project number. Default: ${DEFAULT_PROJECT} (K-Wiki Kanban).

Exit status: 0 = triage applied or planned, 1 = usage error, board or
API failure, or a move that failed verification.`;

function parseCliFlags(args: readonly string[]): {
  readonly values: ReadonlyMap<string, string | undefined>;
  readonly dryRun: boolean;
  readonly error: string | undefined;
} {
  const parsed = parseArgs(args, {
    value: ["--owner", "--project"],
    boolean: ["--dry-run"],
    positionals: {
      max: 0,
      error: (arg) =>
        `unexpected argument ${JSON.stringify(arg)} — board-triage takes no positionals`,
    },
  });

  return {
    values: parsed.values,
    dryRun: parsed.flags.has("--dry-run"),
    error: parsed.error,
  };
}

function usageErrorOf(
  values: ReadonlyMap<string, string | undefined>,
): string | undefined {
  const projectText = values.get("--project");

  if (values.has("--owner") && values.get("--owner") === undefined) {
    return "--owner needs a login value";
  }

  if (values.has("--project") && values.get("--project") === undefined) {
    return "--project needs a project number";
  }

  if (projectText !== undefined && !/^\d+$/.test(projectText)) {
    return `--project needs a project number (got ${JSON.stringify(projectText)})`;
  }

  return undefined;
}

function triageOptionsOf(parsed: {
  readonly values: ReadonlyMap<string, string | undefined>;
  readonly dryRun: boolean;
}): TriageOptions {
  const projectText = parsed.values.get("--project");

  return {
    owner: parsed.values.get("--owner") ?? DEFAULT_OWNER,
    projectNumber:
      projectText === undefined ? DEFAULT_PROJECT : Number(projectText),
    dryRun: parsed.dryRun,
  };
}

/** board-triage entry point: `board-triage [-h | --help] [--dry-run] [--owner <login>] [--project <number>]` (default: mguinada's project 2). */
export async function main(graphql?: GraphQLFn): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseCliFlags(args);

  if (parsed.error !== undefined) {
    cliFail("board-triage", parsed.error);

    return;
  }

  const usageError = usageErrorOf(parsed.values);

  if (usageError !== undefined) {
    cliFail("board-triage", usageError);

    return;
  }

  const client = graphql ?? ghGraphQL();

  try {
    const report = await runBoardTriage(client, triageOptionsOf(parsed));

    renderReport(report);
    await writeStepSummary(report, process.env);

    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(terminalColors().red(`board-triage: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/board/board-triage.ts` runs */
refuseDirectExecution(import.meta.url, "board-triage", "dev");
