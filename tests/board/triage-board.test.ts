import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fetchBoardState,
  type GraphQLFn,
  ghGraphQL,
  runBoardTriage,
} from "../../src/board/triage-board.ts";

/**
 * The board-triage infrastructure (issue #209, issue #259): the
 * `gh api graphql` client, board pagination, the move mutations with
 * their verify-and-reconcile protocol, and the mid-failure reporting
 * contract of issue #245.
 */

const STATUS_OPTIONS = [
  { id: "o-backlog", name: "Backlog" },
  { id: "o-ready", name: "Ready" },
  { id: "o-progress", name: "In progress" },
  { id: "o-review", name: "In review" },
  { id: "o-done", name: "Done" },
] as const;

const STATUS_FIELD = { id: "F_status", options: STATUS_OPTIONS };

const LANE_BY_OPTION_ID = new Map<string, string>(
  STATUS_OPTIONS.map((option) => [option.id, option.name]),
);

interface IssueSpec {
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
function issueNode(spec: IssueSpec): Record<string, unknown> {
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
function boardPage(nodes: readonly Record<string, unknown>[]): unknown {
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
function fakeBoard(
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

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("fetchBoardState", () => {
  it("paginates the board until hasNextPage is false", async () => {
    const cursors: string[] = [];
    const responses = [
      {
        data: {
          user: {
            projectV2: {
              id: "PVT_1",
              items: {
                pageInfo: { hasNextPage: true, endCursor: "c1" },
                nodes: [issueNode({ id: "I1", number: 1, status: "Backlog" })],
              },
              field: STATUS_FIELD,
            },
          },
        },
      },
      boardPage([issueNode({ id: "I2", number: 2, status: "Ready" })]),
    ];
    const graphql: GraphQLFn = async (_query, variables) => {
      cursors.push(String(variables.cursor));

      return responses.shift() as unknown;
    };

    const state = await fetchBoardState(graphql, "mguinada", 2);

    expect(cursors).toEqual(["null", "c1"]);
    expect(state.items.map((item) => item.number)).toEqual([1, 2]);
    expect(state.ids.projectId).toBe("PVT_1");
  });

  it("throws naming owner and project when the board is not readable", async () => {
    const graphql: GraphQLFn = async () => ({
      data: { user: { projectV2: null } },
    });

    await expect(fetchBoardState(graphql, "nobody", 42)).rejects.toThrow(
      "owner nobody has no project 42 readable by this token",
    );
  });

  it("throws the named owner error for a response without data", async () => {
    const graphql: GraphQLFn = async () => ({});

    await expect(fetchBoardState(graphql, "nobody", 42)).rejects.toThrow(
      "owner nobody has no project 42 readable by this token",
    );
  });

  it("throws the named owner error for a null response", async () => {
    const graphql: GraphQLFn = async () => null;

    await expect(fetchBoardState(graphql, "nobody", 42)).rejects.toThrow(
      "owner nobody has no project 42 readable by this token",
    );
  });

  it("returns no items when the board's items connection is null", async () => {
    const graphql: GraphQLFn = async () => ({
      data: {
        user: { projectV2: { id: "PVT_1", items: null, field: STATUS_FIELD } },
      },
    });

    const state = await fetchBoardState(graphql, "mguinada", 2);

    expect(`${state.ids.projectId}|${state.items.length}`).toBe("PVT_1|0");
  });

  it("stops paginating when the last page has hasNextPage false with a leftover cursor", async () => {
    const cursors: string[] = [];
    const responses = [
      {
        data: {
          user: {
            projectV2: {
              id: "PVT_1",
              items: {
                pageInfo: { hasNextPage: true, endCursor: "c1" },
                nodes: [issueNode({ id: "I1", number: 1, status: "Backlog" })],
              },
              field: STATUS_FIELD,
            },
          },
        },
      },
      {
        data: {
          user: {
            projectV2: {
              id: "PVT_1",
              items: {
                pageInfo: { hasNextPage: false, endCursor: "leftover" },
                nodes: [issueNode({ id: "I2", number: 2, status: "Ready" })],
              },
              field: STATUS_FIELD,
            },
          },
        },
      },
    ];
    const graphql: GraphQLFn = async (_query, variables) => {
      cursors.push(String(variables.cursor));

      return responses.shift() as unknown;
    };

    await fetchBoardState(graphql, "mguinada", 2);

    expect(cursors).toEqual(["null", "c1"]);
  });

  it("stops paginating when a next-page cursor is not a string", async () => {
    const cursors: string[] = [];
    const graphql: GraphQLFn = async (_query, variables) => {
      cursors.push(String(variables.cursor));

      return {
        data: {
          user: {
            projectV2: {
              id: "PVT_1",
              items: {
                pageInfo: { hasNextPage: true, endCursor: 42 },
                nodes: [issueNode({ id: "I1", number: 1, status: "Backlog" })],
              },
              field: STATUS_FIELD,
            },
          },
        },
      };
    };

    const state = await fetchBoardState(graphql, "mguinada", 2);

    expect(`${cursors.join()}|${state.items.length}`).toBe("null|1");
  });
});

/** The mixed-lane board the runBoardTriage tests plan against:
 *  moves I1 → Ready and I3 → Done, keeps I2 and I4. */
function mixedBoard() {
  return [
    issueNode({ id: "I1", number: 101, status: "Backlog" }),
    issueNode({
      id: "I2",
      number: 102,
      status: "Backlog",
      blockers: [{ number: 9, state: "OPEN" }],
    }),
    issueNode({
      id: "I3",
      number: 103,
      status: "In progress",
      state: "CLOSED",
    }),
    issueNode({ id: "I4", number: 104, status: "Ready" }),
  ];
}

describe("runBoardTriage", () => {
  const OPTIONS = { owner: "mguinada", projectNumber: 2, dryRun: false };

  it("plans every move and stay with its evidence clause without writing in dry run", async () => {
    const { graphql, mutations } = fakeBoard(mixedBoard());

    const report = await runBoardTriage(graphql, { ...OPTIONS, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(mutations).toEqual([]);
    expect(report.lines.map((line) => line.text)).toEqual([
      "#101 Backlog → Ready — unblocked, no research label",
      "#102 stays Backlog — blocked by open #9",
      "#103 In progress → Done — issue closed",
    ]);
  });

  it("ends a dry run with a summary line that names it", async () => {
    const { graphql } = fakeBoard(mixedBoard());

    const report = await runBoardTriage(graphql, { ...OPTIONS, dryRun: true });

    expect(report.summary).toBe(
      "board-triage: 2 moves, 1 stay, 1 untouched — dry run, no writes",
    );
    expect(report.ok).toBe(true);
  });

  it("applies each planned move with the freshly resolved ids and reports it verified", async () => {
    const nodes = mixedBoard();
    const { graphql, mutations } = fakeBoard(nodes);

    const report = await runBoardTriage(graphql, OPTIONS);

    expect(mutations).toEqual([
      {
        projectId: "PVT_1",
        itemId: "I1",
        fieldId: "F_status",
        optionId: "o-ready",
      },
      {
        projectId: "PVT_1",
        itemId: "I3",
        fieldId: "F_status",
        optionId: "o-done",
      },
    ]);
    expect(nodes[0]?.fieldValueByName).toEqual({
      name: "Ready",
      optionId: "o-ready",
    });
    expect(nodes[2]?.fieldValueByName).toEqual({
      name: "Done",
      optionId: "o-done",
    });
    expect(report.ok).toBe(true);
    expect(report.summary).toBe(
      "board-triage: 2 moves, 1 stay, 1 untouched — verified against the board (0 reconciled)",
    );
  });

  it("reconciles a lost write by one retry and reports it reconciled", async () => {
    const { graphql, mutations } = fakeBoard(mixedBoard(), {
      failFirst: ["I1"],
    });

    const report = await runBoardTriage(graphql, OPTIONS);

    expect(mutations.filter((call) => call.itemId === "I1").length).toBe(2);
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("(1 reconciled)");
  });

  it("fails the run with an error line when a move never verifies", async () => {
    const { graphql } = fakeBoard(mixedBoard(), { failAlways: ["I1"] });

    const report = await runBoardTriage(graphql, OPTIONS);

    expect(report.ok).toBe(false);
    expect(report.lines.at(-1)?.text).toBe(
      "#101 Backlog → Ready not verified — still on Backlog",
    );
    expect(report.lines.at(-1)?.level).toBe("error");
  });

  it("is idempotent: a second run over the moved board plans zero moves and writes nothing", async () => {
    const { graphql, mutations } = fakeBoard(mixedBoard());

    await runBoardTriage(graphql, OPTIONS);

    const before = mutations.length;
    const second = await runBoardTriage(graphql, OPTIONS);

    expect(second.moves).toBe(0);
    expect(second.ok).toBe(true);
    expect(mutations.length).toBe(before);
  });

  async function appliedRunQueries(): Promise<string[]> {
    const queries: string[] = [];
    const { graphql } = fakeBoard(mixedBoard());
    const wrapped: GraphQLFn = async (query, variables) => {
      queries.push(query);

      return graphql(query, variables);
    };

    await runBoardTriage(wrapped, OPTIONS);

    return queries;
  }

  it("applies its moves through field-value mutations", async () => {
    const queries = await appliedRunQueries();

    expect(
      queries.some((query) => query.includes("updateProjectV2ItemFieldValue")),
    ).toBe(true);
  });

  it("never sends an item-position mutation during an applied run", async () => {
    const queries = await appliedRunQueries();

    expect(
      queries.some((query) => query.includes("updateProjectV2ItemPosition")),
    ).toBe(false);
  });

  it("logs a statusless item as untouched in a dry run", async () => {
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 7, status: null }),
    ]);

    const report = await runBoardTriage(graphql, { ...OPTIONS, dryRun: true });

    expect(report.lines.map((line) => `${line.level}|${line.text}`)).toEqual([
      "stay|#7 untouched — no Status value",
    ]);
  });

  it("does not log a closed item already on Done in a dry run", async () => {
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 6, status: "Done", state: "CLOSED" }),
      issueNode({ id: "I2", number: 2, status: "Backlog" }),
    ]);

    const report = await runBoardTriage(graphql, { ...OPTIONS, dryRun: true });

    expect(report.lines.map((line) => line.text)).toEqual([
      "#2 Backlog → Ready — unblocked, no research label",
    ]);
  });

  it("reports a vanished item as not verified on no Status", async () => {
    const nodes = [issueNode({ id: "I1", number: 7, status: "Backlog" })];
    let reads = 0;
    const graphql: GraphQLFn = async (query, _variables) => {
      if (query.includes("updateProjectV2ItemFieldValue")) {
        return {
          data: { updateProjectV2ItemFieldValue: { clientMutationId: null } },
        };
      }

      reads++;

      return boardPage(reads === 1 ? nodes : []);
    };

    const report = await runBoardTriage(graphql, OPTIONS);

    expect(report.lines.at(-1)?.text).toBe(
      "#7 Backlog → Ready not verified — still on no Status",
    );
  });

  it("reads the board exactly once when no moves are planned", async () => {
    const reads: string[] = [];
    const { graphql } = fakeBoard([
      issueNode({
        id: "I1",
        number: 9,
        status: "Backlog",
        blockers: [{ number: 4, state: "OPEN" }],
      }),
    ]);
    const wrapped: GraphQLFn = async (query, variables) => {
      if (!query.includes("updateProjectV2ItemFieldValue")) {
        reads.push(String(variables.cursor));
      }

      return graphql(query, variables);
    };

    await runBoardTriage(wrapped, OPTIONS);

    expect(reads).toEqual(["null"]);
  });

  it("verifies a green applied run with exactly one re-read", async () => {
    const reads: string[] = [];
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 7, status: "Backlog" }),
    ]);
    const wrapped: GraphQLFn = async (query, variables) => {
      if (!query.includes("updateProjectV2ItemFieldValue")) {
        reads.push(String(variables.cursor));
      }

      return graphql(query, variables);
    };

    await runBoardTriage(wrapped, OPTIONS);

    expect(reads).toEqual(["null", "null"]);
  });

  it("names the failed move count exactly in the summary", async () => {
    const { graphql } = fakeBoard(
      [issueNode({ id: "I1", number: 7, status: "Backlog" })],
      { failAlways: ["I1"] },
    );

    const report = await runBoardTriage(graphql, OPTIONS);

    expect(report.summary).toBe(
      "board-triage: 1 move, 0 stays, 0 untouched — 1 move not verified",
    );
  });

  it.each([
    ["labels", "labels"],
    ["blockedBy", "blockedBy edges"],
    ["timelineItems", "cross-referenced events"],
  ] as const)(
    "fails the run with the exact evidence when the %s connection is truncated",
    async (connection, what) => {
      const graphql: GraphQLFn = async () =>
        boardPage([
          issueNode({
            id: "I1",
            number: 7,
            status: "Backlog",
            truncated: connection,
          }),
        ]);

      await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
        `board read truncated: issue #7 ${what} exceeded one page — raise the cap in BOARD_PAGE_QUERY or paginate`,
      );
    },
  );
});

describe("runBoardTriage mid-failure reporting (issue #245)", () => {
  const OPTIONS = { owner: "mguinada", projectNumber: 2, dryRun: false };

  /** A fake board whose mutation for `failItemId` throws on its
   *  `failAttempt`-th attempt (the first by default — mid-loop, after
   *  earlier moves applied); `failFirst` keeps its usual lost-write
   *  meaning, `failReads` lists the 1-based board reads (past the
   *  initial one) that throw instead. */
  function throwingBoard(
    nodes: Record<string, unknown>[],
    failItemId: string,
    fakeOptions: { failFirst?: readonly string[] } = {},
    failReads: readonly number[] = [],
    failAttempt = 1,
  ): GraphQLFn {
    const { graphql } = fakeBoard(nodes, fakeOptions);
    const attempts = new Map<string, number>();
    let reads = 0;

    return async (query, variables) => {
      if (query.includes("updateProjectV2ItemFieldValue")) {
        const attempt = (attempts.get(String(variables.itemId)) ?? 0) + 1;

        attempts.set(String(variables.itemId), attempt);

        if (variables.itemId === failItemId && attempt === failAttempt) {
          throw new Error("mutation exploded");
        }
      } else {
        reads++;

        if (failReads.includes(reads)) {
          throw new Error("board unreadable");
        }
      }

      return graphql(query, variables);
    };
  }

  it("reports an applied move as verified when a later mutation throws mid-loop", async () => {
    const graphql = throwingBoard(mixedBoard(), "I3");

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "applied moves: #101 Backlog → Ready — verified",
    );
  });

  it("reports an applied move that did not land as not verified when a mutation throws mid-loop", async () => {
    const graphql = throwingBoard(mixedBoard(), "I3", { failFirst: ["I1"] });

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "#101 Backlog → Ready not verified — still on Backlog",
    );
  });

  it("keeps the original failure's message in the mid-loop rejection", async () => {
    const graphql = throwingBoard(mixedBoard(), "I3");

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "mutation exploded",
    );
  });

  it("reports that no moves were applied when the first mutation throws", async () => {
    const graphql = throwingBoard(mixedBoard(), "I1");

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "applied moves: none",
    );
  });

  it("falls back to an unverified report when the verification re-read fails", async () => {
    const graphql = throwingBoard(mixedBoard(), "I3", {}, [2]);

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "#101 Backlog → Ready — verification unavailable (board unreadable)",
    );
  });

  it("reports the applied moves when the first verification read fails", async () => {
    const graphql = throwingBoard(mixedBoard(), "I9", {}, [2]);

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "applied moves: #101 Backlog → Ready — verified; #103 In progress → Done — verified",
    );
  });

  it("still reports a landed move when the retry after a lost write fails", async () => {
    const graphql = throwingBoard(
      mixedBoard(),
      "I1",
      { failFirst: ["I1"] },
      [],
      2,
    );

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "applied moves: #101 Backlog → Ready not verified — still on Backlog; #103 In progress → Done — verified",
    );
  });

  it("reports the applied moves when the final verification read fails", async () => {
    const graphql = throwingBoard(
      mixedBoard(),
      "I9",
      { failFirst: ["I1"] },
      [3],
    );

    await expect(runBoardTriage(graphql, OPTIONS)).rejects.toThrow(
      "board unreadable — triage aborted; applied moves: #101 Backlog → Ready — verified; #103 In progress → Done — verified",
    );
  });
});

describe("ghGraphQL", () => {
  it("passes the query and typed variables to gh api graphql and parses its JSON", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const graphql = ghGraphQL(
      async (args, env) => {
        calls.push({ args, env });

        return { stdout: '{"data":{"ok":1}}', stderr: "" };
      },
      { GH_TOKEN: "t" },
    );

    await expect(
      graphql("query Q { q }", { owner: "o", n: 2 }),
    ).resolves.toEqual({
      data: { ok: 1 },
    });
    expect(calls[0]?.args).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query Q { q }",
      "-f",
      "owner=o",
      "-F",
      "n=2",
    ]);
  });

  it("omits null variables instead of sending the string null", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const graphql = ghGraphQL(async (args, env) => {
      calls.push({ args, env });

      return { stdout: "{}", stderr: "" };
    }, {});

    await graphql("query Q { q }", { cursor: null });
    expect(calls[0]?.args.join(" ").includes("cursor")).toBe(false);
  });

  it("strips a local repo-scope GITHUB_TOKEN but keeps GH_TOKEN for the child gh", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const graphql = ghGraphQL(
      async (args, env) => {
        calls.push({ args, env });

        return { stdout: "{}", stderr: "" };
      },
      { GH_TOKEN: "actions-token", GITHUB_TOKEN: "repo-scope-only" },
    );

    await graphql("query Q { q }", {});
    expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
    expect(calls[0]?.env.GH_TOKEN).toBe("actions-token");
  });

  it("surfaces a gh failure as an error naming gh", async () => {
    const graphql = ghGraphQL(async () => {
      throw new Error("gh: GraphQL: bad token (HTTP 401)");
    }, {});

    await expect(graphql("query Q { q }", {})).rejects.toThrow(
      "gh api graphql failed: gh: GraphQL: bad token (HTTP 401)",
    );
  });

  it("drives the real gh binary from PATH without the local GITHUB_TOKEN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-triage-gh-"));

    tempDirs.push(dir);

    const stub = join(dir, "gh");

    await writeFile(
      stub,
      '#!/bin/sh\nif [ "$1" != "api" ]; then exit 9; fi\necho \'{"data":{"via":"\'"$GITHUB_TOKEN"\'"}}\'\n',
      { mode: 0o755 },
    );

    const graphql = ghGraphQL(undefined, {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      GITHUB_TOKEN: "must-not-reach-gh",
    });

    await expect(graphql("query Q { q }", {})).resolves.toEqual({
      data: { via: "" },
    });
  });
});
