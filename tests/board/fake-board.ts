import type { GraphQLFn } from "../../src/board/triage-board.ts";

/**
 * Shared board fixtures for the triage suites: the Status lane
 * vocabulary, one board item node in the GraphQL response shape, a
 * one-page board response, and a stateful fake board. Used by
 * triage-decode, triage-board, and the board-triage CLI tests.
 */

export const STATUS_OPTIONS = [
  { id: "o-backlog", name: "Backlog" },
  { id: "o-ready", name: "Ready" },
  { id: "o-progress", name: "In progress" },
  { id: "o-review", name: "In review" },
  { id: "o-done", name: "Done" },
] as const;

export const STATUS_FIELD = { id: "F_status", options: STATUS_OPTIONS };

const LANE_BY_OPTION_ID = new Map<string, string>(
  STATUS_OPTIONS.map((option) => [option.id, option.name]),
);

export interface IssueSpec {
  readonly id: string;
  readonly number: number;
  readonly state?: "OPEN" | "CLOSED";
  readonly status?: string | null;
  readonly labels?: readonly string[];
  readonly blockers?: readonly { number: number; state: string }[];
  readonly refs?: readonly {
    number: number;
    state: string;
    pr: boolean;
  }[];
  readonly truncated?: "labels" | "blockedBy" | "timelineItems";
}

/** One board item node in the GraphQL response shape. */
export function issueNode(spec: IssueSpec): Record<string, unknown> {
  const status =
    spec.status === undefined || spec.status === null
      ? null
      : { name: spec.status, optionId: `o-${spec.status.toLowerCase()}` };

  return {
    id: spec.id,
    fieldValueByName: status,
    content: {
      __typename: "Issue",
      number: spec.number,
      state: spec.state ?? "OPEN",
      labels: {
        nodes: (spec.labels ?? []).map((name) => ({ name })),
        pageInfo: { hasNextPage: spec.truncated === "labels" },
      },
      blockedBy: {
        nodes: (spec.blockers ?? []).map((blocker) => ({
          number: blocker.number,
          state: blocker.state,
        })),
        pageInfo: { hasNextPage: spec.truncated === "blockedBy" },
      },
      timelineItems: {
        nodes: (spec.refs ?? []).map((ref) => ({
          source: ref.pr ? { number: ref.number, state: ref.state } : {},
        })),
        pageInfo: { hasNextPage: spec.truncated === "timelineItems" },
      },
    },
  };
}

/** A one-page board response for `query BoardPage`. */
export function boardPage(nodes: readonly Record<string, unknown>[]): unknown {
  return {
    data: {
      user: {
        projectV2: {
          id: "PVT_1",
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
          field: STATUS_FIELD,
        },
      },
    },
  };
}

/** A stateful fake board: reads render the current nodes, mutations
 *  rewrite the moved item's status. `failFirst` drops an item's first
 *  mutation (lost write); `failAlways` drops all of them. */
export function fakeBoard(
  nodes: Record<string, unknown>[],
  options: {
    failFirst?: readonly string[];
    failAlways?: readonly string[];
  } = {},
): { graphql: GraphQLFn; mutations: Record<string, unknown>[] } {
  const mutations: Record<string, unknown>[] = [];
  const dropped = new Set<string>();

  const graphql: GraphQLFn = async (query, variables) => {
    if (query.includes("updateProjectV2ItemFieldValue")) {
      mutations.push({ ...variables });
      const node = nodes.find((candidate) => candidate.id === variables.itemId);
      const lane = LANE_BY_OPTION_ID.get(String(variables.optionId));

      if (
        node !== undefined &&
        lane !== undefined &&
        !options.failAlways?.includes(String(node.id)) &&
        (!options.failFirst?.includes(String(node.id)) ||
          dropped.has(String(node.id)))
      ) {
        node.fieldValueByName = { name: lane, optionId: variables.optionId };
      } else if (node !== undefined) {
        dropped.add(String(node.id));
      }

      return {
        data: { updateProjectV2ItemFieldValue: { clientMutationId: null } },
      };
    }

    return boardPage(nodes);
  };

  return { graphql, mutations };
}
