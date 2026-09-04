import { readFileSync } from "node:fs";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";
import { readSourceFrom } from "./mutation-identity.ts";
import {
  type Ledger,
  ledgerBlockLine,
  ledgerFromBody,
  ledgerLines,
  mergeLedger,
} from "./mutation-ledger.ts";
import {
  type PruneCandidate,
  parseRegistry,
  pruneCandidates,
  REGISTRY_FILENAME,
  type Registry,
  splitByRegistry,
} from "./mutation-registry.ts";
import { parseReport } from "./mutation-survivors.ts";

// Renders the rolling survivor-issue body from a Stryker JSON report
// (issue #208): the merged ledger's actionable-mutant list in the
// exact format `npm run mutation:survivors` prints, plus links to
// the source run and its HTML report artifact, plus the hidden
// ledger block the next filing merges on top of (issue #261 — the
// body is a merge-body ledger, never a replace-body snapshot), with
// registry-recorded adjudications (issue #241) filtered from the
// untriaged list and counted separately: recording a mutant moves it
// between counts, and the total never shrinks silently.

/** Links into the CI run the report came from. */
export interface ReportMeta {
  readonly runUrl?: string | undefined;
  readonly htmlUrl?: string | undefined;
  /** Registry entries the full run's generated identities no longer
   *  cover — rendered as prune candidates (removal lands as a PR). */
  readonly prune?: readonly PruneCandidate[] | undefined;
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
                  drops. Registry entries the run's generated
                  identities no longer cover render as prune
                  candidates. Default: absent entries stay — the
                  windowed nightly's partial scope must not wipe the
                  ledger, and windowed runs never prune.

  --run-url <url> Link to the CI run the report came from. Default:
                  omitted — the body drops the line.

  --html-url <url>
                  Link to the run's HTML report artifact. Default:
                  omitted — the body drops the line.

The mutant registry ${REGISTRY_FILENAME} and the report's source
files are read from the working directory; an absent registry
filters nothing, an invalid one fails the render naming the file.

  -h, --help      Print this help and exit; no side effects.

Writes the Markdown body to stdout. Exit 0 after rendering (even
with survivors — mutation testing is advisory and this renderer
must stay unusable as a gate); exit 1 when the report is missing,
unreadable, or not a Stryker report, or when the registry file is
present but invalid.`;

/** The recorded-adjudication line for one split. */
function recordedLine(split: ReturnType<typeof splitByRegistry>): string[] {
  const recorded = split.equivalents.length + split.artifacts.length;

  if (recorded === 0) {
    return [];
  }

  return [
    `Recorded adjudications (${recorded}) — filtered from the list above: ` +
      `${split.equivalents.length} equivalent, ${split.artifacts.length} ` +
      `artifact (${REGISTRY_FILENAME}).`,
  ];
}

/** The artifact section: kept visible because artifacts are
 *  plausibly killable — they stay revisitable, never silently
 *  excused. */
function artifactSection(split: ReturnType<typeof splitByRegistry>): string[] {
  if (split.artifacts.length === 0) {
    return [];
  }

  return [
    "",
    `Artifact mutants (${split.artifacts.length}) — measurement artifacts, plausibly killable, kept visible:`,
    "",
    ...split.artifacts.map(
      ({ entry, record }) =>
        `- ${entry.status}  ${entry.file}:${entry.line}  ${entry.mutator} — ` +
        `${record.justification} (${record.pr})`,
    ),
  ];
}

/** The prune-candidates section: full runs only (windowed runs
 *  cannot tell a gone span from an out-of-window one). */
function pruneSection(candidates: readonly PruneCandidate[]): string[] {
  if (candidates.length === 0) {
    return [];
  }

  return [
    "",
    `Registry prune candidates (${candidates.length}) — not generated by this full run; remove from ${REGISTRY_FILENAME} in a PR:`,
    "",
    ...candidates.map(
      ({ id, record }) => `- ${id} recorded ${record.date} (${record.pr})`,
    ),
  ];
}

/** The untriaged list — the exact survivors-printer format. */
function untriagedSection(lines: string[], actionable: number): string[] {
  if (actionable === 0) {
    return ["No actionable mutants — nothing survived, nothing uncovered."];
  }

  if (lines.length === 0) {
    return ["No untriaged mutants — every actionable mutant is adjudicated."];
  }

  return [
    `Untriaged mutants (${lines.length}) — kill or record as adjudicated:`,
    "",
    "```",
    ...lines,
    "```",
  ];
}

/** The rolling-issue body for one ledger. */
export function renderIssueBody(
  ledger: Ledger,
  registry: Registry,
  meta: ReportMeta = {},
): string {
  const split = splitByRegistry(ledger.entries, registry);

  const links = [
    meta.runUrl === undefined ? null : `- Source run: ${meta.runUrl}`,
    meta.htmlUrl === undefined
      ? null
      : `- HTML report artifact: ${meta.htmlUrl}`,
  ].filter((line): line is string => line !== null);

  const head = [
    "Mutation testing: actionable survivors — auto-filed from CI",
    "(issue #208). Advisory signal, never a gate. Kill survivors via",
    "the mutation-triage skill; adjudicated equivalents and artifacts",
    `live in ${REGISTRY_FILENAME}.`,
  ];

  const lead = links.length === 0 ? [] : ["", ...links, ""];

  const list = untriagedSection(
    ledgerLines({ entries: split.untriaged }),
    ledger.entries.length,
  );

  return [
    ...head,
    ...lead,
    ...list,
    "",
    ...recordedLine(split),
    ...artifactSection(split),
    ...pruneSection(meta.prune ?? []),
    ledgerBlockLine(ledger),
    "",
  ].join("\n");
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

/** The prior body's text, "" when none was given; undefined when
 *  a given path cannot be read. */
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

/** Everything the render needs besides argv: the report text, the
 *  prior body, and the parsed registry. */
interface MergeInputs {
  readonly reportText: string;
  readonly priorBody: string;
  readonly registry: Registry;
}

/** Load the merge inputs, throwing the first failure as the
 *  message the caller prints and exits 1 on. */
function loadMergeInputs(options: Options): MergeInputs {
  let reportText: string;

  try {
    reportText = readFileSync(options.reportPath, "utf8");
  } catch {
    throw new Error(`cannot read the report at ${options.reportPath}`);
  }

  const priorBody = readPriorBody(options.priorBodyPath);

  if (priorBody === undefined) {
    throw new Error(`cannot read the prior body at ${options.priorBodyPath}`);
  }

  let registryText: string | undefined;

  try {
    registryText = readFileSync(REGISTRY_FILENAME, "utf8");
  } catch {
    registryText = undefined;
  }

  try {
    return { reportText, priorBody, registry: parseRegistry(registryText) };
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : String(cause));
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

  let inputs: MergeInputs;

  try {
    inputs = loadMergeInputs(options);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;

    return;
  }

  try {
    const merged = mergeLedger(
      ledgerFromBody(inputs.priorBody),
      parseReport(inputs.reportText),
      {
        absenceKills: options.absenceKills,
        readSource: readSourceFrom(process.cwd()),
      },
    );

    console.log(
      renderIssueBody(merged.ledger, inputs.registry, {
        runUrl: options.runUrl,
        htmlUrl: options.htmlUrl,
        prune: options.absenceKills
          ? pruneCandidates(inputs.registry, merged.generated)
          : undefined,
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
