import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "../cli/colors.ts";
import {
  type BoardIds,
  type BoardState,
  itemNodes,
  type JsonRecord,
  nextCursor,
  parseBoardIds,
  parseBoardItems,
  requireProject,
} from "./triage-decode.ts";
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
 * The board-triage infrastructure (issue #209, extracted in issue
 * #259): the `gh api graphql` client, the board pagination, the
 * Status mutations with their verify-and-reconcile protocol, and the
 * one triage run that composes them. The guardrails hold here by
 * construction — project, field, and option IDs are resolved fresh
 * from the board every run; every applied move is verified by
 * re-reading the board, and a mismatch is reconciled by one retry
 * (finding O-5).
 */

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

export const DEFAULT_OWNER = "mguinada";
export const DEFAULT_PROJECT = 2;

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
