import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { cliFail, errorMessage, terminalColors } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { isPlainObject } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";
import {
  type BoardItem,
  DRY_OUTCOME,
  decideTriage,
  describeMove,
  type PlannedMove,
  plannedLines,
  type TriageOutcome,
  type TriageReport,
  toMove,
  triageSummary,
  type UnverifiedMove,
} from "./triage-rules.ts";

/**
 * Scheduled board triage (issue #209): the mechanical half of the
 * triage-issues skill, applied to a GitHub Projects board's Status
 * field only. The guardrails hold by construction — only Backlog
 * items (plus closed, not-yet-Done items from any lane) move; lane
 * order is never touched (no item-position mutation exists here);
 * issues themselves are never edited; project, field, and option IDs
 * are resolved fresh from the board every run; every applied move is
 * verified by re-reading the board, and a mismatch is reconciled by
 * one retry. The judgment half — Ready-lane sequencing — stays with
 * human/agent triage runs.
 */

/** Board ids resolved fresh this run — never hardcoded. */
export interface BoardIds {
  readonly projectId: string;
  readonly statusFieldId: string;
  readonly optionIds: Readonly<
    Record<"Ready" | "In progress" | "Done", string>
  >;
}

export interface BoardState {
  readonly ids: BoardIds;
  readonly items: readonly BoardItem[];
}

/** A GraphQL call over `gh api graphql`; injectable for tests. */
export type GraphQLFn = (
  query: string,
  variables: Record<string, string | number | null>,
) => Promise<unknown>;

const BOARD_PAGE_QUERY = `query BoardPage($owner: String!, $projectNumber: Int!, $cursor: String) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
          }
          content {
            __typename
            ... on Issue {
              number
              state
              labels(first: 20) {
                nodes { name }
                pageInfo { hasNextPage }
              }
              blockedBy(first: 20) {
                nodes { number state }
                pageInfo { hasNextPage }
              }
              timelineItems(first: 30, itemTypes: CROSS_REFERENCED_EVENT) {
                nodes {
                  ... on CrossReferencedEvent {
                    source { ... on PullRequest { number state } }
                  }
                }
                pageInfo { hasNextPage }
              }
            }
          }
        }
      }
      field(name: "Status") {
        ... on ProjectV2FieldCommon { id }
        ... on ProjectV2SingleSelectField { options { id name } }
      }
    }
  }
}`;

const MOVE_MUTATION = `mutation MoveItem($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) { clientMutationId }
}`;

const DEFAULT_OWNER = "mguinada";
const DEFAULT_PROJECT = 2;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return isPlainObject(value) ? value : undefined;
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`board response is missing ${what}`);
  }

  return value;
}

function requiredNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`board response is missing ${what}`);
  }

  return value;
}

/** Project, Status field, and move-target option ids from one board
 *  response — resolved fresh, verified against the three lanes the
 *  contract moves to. */
export function parseBoardIds(project: unknown): BoardIds {
  const node = asRecord(project);

  if (node === undefined) {
    throw new Error("board response is missing the project");
  }

  const field = asRecord(node.field);

  if (field === undefined) {
    throw new Error("board has no Status field");
  }

  const byName = new Map<string, string>();

  for (const raw of Array.isArray(field.options) ? field.options : []) {
    const option = asRecord(raw);

    if (option !== undefined) {
      byName.set(String(option.name), String(option.id));
    }
  }

  const names = ["Ready", "In progress", "Done"] as const;
  const optionIds = {} as Record<(typeof names)[number], string>;

  for (const name of names) {
    const id = byName.get(name);

    if (id === undefined) {
      throw new Error(`Status option missing on board: ${name}`);
    }

    optionIds[name] = id;
  }

  return {
    projectId: requiredString(node.id, "the project id"),
    statusFieldId: requiredString(field.id, "the Status field id"),
    optionIds,
  };
}

function parseState(value: unknown): "OPEN" | "CLOSED" {
  if (value !== "OPEN" && value !== "CLOSED") {
    throw new Error(
      `board response has an unknown issue state: ${String(value)}`,
    );
  }

  return value;
}

function statusName(value: unknown): string | undefined {
  const name = asRecord(value)?.name;

  return typeof name === "string" ? name : undefined;
}

function nameList(value: unknown): readonly string[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => asRecord(entry)?.name)
    .filter((name): name is string => typeof name === "string");
}

/** The numbers whose `state` is OPEN among a node list. */
function openNumbers(value: unknown): readonly number[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => asRecord(entry))
    .filter((entry) => entry?.state === "OPEN")
    .map((entry) => entry?.number)
    .filter((number): number is number => typeof number === "number");
}

/** Open PR numbers among cross-referenced events — an issue reference
 *  (source without a number) and a merged/closed PR do not count. */
function openPrNumbers(value: unknown): readonly number[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => asRecord(asRecord(entry)?.source))
    .flatMap((source) =>
      source !== undefined &&
      source.state === "OPEN" &&
      typeof source.number === "number"
        ? [source.number]
        : [],
    );
}

/** A nested connection truncated at its page cap fails the run:
 *  silently dropping its facts (an open blocker, a live PR
 *  reference) would misclassify the item. */
function failIfTruncated(
  connection: unknown,
  number: number,
  what: string,
): void {
  if (asRecord(asRecord(connection)?.pageInfo)?.hasNextPage === true) {
    throw new Error(
      `board read truncated: issue #${number} ${what} exceeded one page — raise the cap in BOARD_PAGE_QUERY or paginate`,
    );
  }
}

/** Issue items from board nodes; non-issue content (pull requests,
 *  draft issues) is skipped — the contract triages issues. */
export function parseBoardItems(
  nodes: readonly unknown[],
): readonly BoardItem[] {
  const items: BoardItem[] = [];

  for (const raw of nodes) {
    const node = asRecord(raw);
    const content = node === undefined ? undefined : asRecord(node.content);

    if (node === undefined || content?.__typename !== "Issue") {
      continue;
    }

    const number = requiredNumber(
      content.number,
      `the issue number of item ${String(node.id)}`,
    );

    failIfTruncated(content.labels, number, "labels");
    failIfTruncated(content.blockedBy, number, "blockedBy edges");
    failIfTruncated(content.timelineItems, number, "cross-referenced events");

    items.push({
      id: requiredString(node.id, "an item id"),
      number,
      state: parseState(content.state),
      status: statusName(node.fieldValueByName),
      labels: nameList(asRecord(content.labels)?.nodes),
      openBlockers: openNumbers(asRecord(content.blockedBy)?.nodes),
      openPrs: openPrNumbers(asRecord(content.timelineItems)?.nodes),
    });
  }

  return items;
}

function requireProject(
  response: unknown,
  owner: string,
  projectNumber: number,
): JsonRecord {
  const user = asRecord(asRecord(asRecord(response)?.data)?.user);
  const project = asRecord(user?.projectV2);

  if (project === undefined) {
    throw new Error(
      `owner ${owner} has no project ${projectNumber} readable by this token`,
    );
  }

  return project;
}

function itemNodes(project: JsonRecord): readonly unknown[] {
  const nodes = asRecord(project.items)?.nodes;

  return Array.isArray(nodes) ? nodes : [];
}

function nextCursor(project: JsonRecord): string | null {
  const pageInfo = asRecord(asRecord(project.items)?.pageInfo);

  return pageInfo?.hasNextPage === true &&
    typeof pageInfo.endCursor === "string"
    ? pageInfo.endCursor
    : null;
}

async function boardPage(
  graphql: GraphQLFn,
  owner: string,
  projectNumber: number,
  cursor: string | null,
): Promise<{ project: JsonRecord; cursor: string | null }> {
  const response = await graphql(BOARD_PAGE_QUERY, {
    owner,
    projectNumber,
    cursor,
  });
  const project = requireProject(response, owner, projectNumber);

  return { project, cursor: nextCursor(project) };
}

/** The whole board in one read: ids resolved fresh, every item page
 *  accumulated. */
export async function fetchBoardState(
  graphql: GraphQLFn,
  owner: string,
  projectNumber: number,
): Promise<BoardState> {
  const items: BoardItem[] = [];
  const first = await boardPage(graphql, owner, projectNumber, null);
  const ids = parseBoardIds(first.project);
  let cursor = first.cursor;

  items.push(...parseBoardItems(itemNodes(first.project)));

  while (cursor !== null) {
    const page = await boardPage(graphql, owner, projectNumber, cursor);

    items.push(...parseBoardItems(itemNodes(page.project)));
    cursor = page.cursor;
  }

  return { ids, items };
}

async function moveItem(
  graphql: GraphQLFn,
  ids: BoardIds,
  move: PlannedMove,
): Promise<void> {
  await graphql(MOVE_MUTATION, {
    projectId: ids.projectId,
    itemId: move.item.id,
    fieldId: ids.statusFieldId,
    optionId: ids.optionIds[move.to],
  });
}

/** Moves that the re-read board contradicts: the item is not on the
 *  lane the mutation targeted. */
async function unverifiedMoves(
  graphql: GraphQLFn,
  owner: string,
  projectNumber: number,
  moves: readonly PlannedMove[],
): Promise<UnverifiedMove[]> {
  const state = await fetchBoardState(graphql, owner, projectNumber);
  const byId = new Map(state.items.map((item) => [item.id, item]));

  return moves.flatMap((move) => {
    const actual = byId.get(move.item.id)?.status;

    return actual === move.to ? [] : [{ move, actual: actual ?? "no Status" }];
  });
}

export interface TriageOptions {
  readonly owner: string;
  readonly projectNumber: number;
  readonly dryRun: boolean;
}

/** The mid-failure partial-state report (issue #245): every move
 *  already applied, verified against a fresh board read when one is
 *  possible — so the error that fails the run still records what
 *  did land on the board. */
async function appliedMovesReport(
  graphql: GraphQLFn,
  options: TriageOptions,
  applied: readonly PlannedMove[],
): Promise<string> {
  if (applied.length === 0) {
    return "none";
  }

  try {
    const mismatched = await unverifiedMoves(
      graphql,
      options.owner,
      options.projectNumber,
      applied,
    );
    const byId = new Map(
      mismatched.map((entry) => [entry.move.item.id, entry]),
    );

    return applied
      .map((move) => {
        const text = describeMove(move);
        const unverified = byId.get(move.item.id);

        return unverified === undefined
          ? `${text} — verified`
          : `${text} not verified — still on ${unverified.actual}`;
      })
      .join("; ");
  } catch (error) {
    return `${applied.map(describeMove).join("; ")} — verification unavailable (${errorMessage(error)})`;
  }
}

/** Apply every planned move, then verify by re-reading the board;
 *  a lost write is retried once, and whatever still fails
 *  verification comes back in `failed`. Every failure after the
 *  first write is rethrown with the applied moves verified and
 *  reported — the partial state is never lost (issue #245). */
async function applyAndVerify(
  graphql: GraphQLFn,
  options: TriageOptions,
  state: BoardState,
  moves: readonly PlannedMove[],
): Promise<TriageOutcome> {
  if (moves.length === 0) {
    return DRY_OUTCOME;
  }

  const applied: PlannedMove[] = [];

  try {
    for (const move of moves) {
      await moveItem(graphql, state.ids, move);
      applied.push(move);
    }

    const mismatched = await unverifiedMoves(
      graphql,
      options.owner,
      options.projectNumber,
      moves,
    );

    for (const unverified of mismatched) {
      await moveItem(graphql, state.ids, unverified.move);
    }

    const failed =
      mismatched.length === 0
        ? []
        : await unverifiedMoves(
            graphql,
            options.owner,
            options.projectNumber,
            moves,
          );

    return { reconciled: mismatched.length, failed };
  } catch (cause) {
    const report = await appliedMovesReport(graphql, options, applied);

    throw new Error(
      `${errorMessage(cause)} — triage aborted; applied moves: ${report}`,
      { cause },
    );
  }
}

/** One triage run: read the board, decide every item, apply the
 *  moves (unless dry run), verify by re-reading, reconcile a lost
 *  write once, and report one line per logged item. */
export async function runBoardTriage(
  graphql: GraphQLFn,
  options: TriageOptions,
): Promise<TriageReport> {
  const state = await fetchBoardState(
    graphql,
    options.owner,
    options.projectNumber,
  );
  const planned = state.items.map((item) => ({
    item,
    decision: decideTriage(item),
  }));
  const lines = plannedLines(planned);
  const moves = planned.flatMap(toMove);
  const stays = lines.filter((line) => line.level === "stay").length;
  const untouched = state.items.length - moves.length - stays;
  const outcome = options.dryRun
    ? DRY_OUTCOME
    : await applyAndVerify(graphql, options, state, moves);

  for (const unverified of outcome.failed) {
    lines.push({
      text: `${describeMove(unverified.move)} not verified — still on ${unverified.actual}`,
      level: "error",
    });
  }

  return {
    lines,
    summary: triageSummary(
      moves.length,
      stays,
      untouched,
      outcome,
      options.dryRun,
    ),
    moves: moves.length,
    ok: outcome.failed.length === 0,
    dryRun: options.dryRun,
  };
}

type GhRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>;

const runGh = promisify(execFile);

/* v8 ignore next: exercised only through the real gh binary (PATH-stub test and acceptance runs) */
const spawnGh: GhRunner = (args, env) => runGh("gh", [...args], { env });

/**
 * A GraphQLFn over `gh api graphql`. A local GITHUB_TOKEN env var
 * (repo scope only, per AGENTS.md) is stripped so gh falls back to
 * the keyring login, which carries the project scope; GH_TOKEN
 * (GitHub Actions) is kept and wins.
 */
export function ghGraphQL(
  runner: GhRunner = spawnGh,
  env: NodeJS.ProcessEnv = process.env,
): GraphQLFn {
  return async (query, variables) => {
    const args = ["api", "graphql", "-f", `query=${query}`];

    for (const [key, value] of Object.entries(variables)) {
      if (value === null) {
        continue;
      }

      args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }

    const childEnv = { ...env };

    delete childEnv.GITHUB_TOKEN;

    try {
      const { stdout } = await runner(args, childEnv);

      return JSON.parse(stdout) as unknown;
    } catch (cause) {
      throw new Error(`gh api graphql failed: ${errorMessage(cause)}`);
    }
  };
}

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
