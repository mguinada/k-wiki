import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type BoardItem,
  decideTriage,
  fetchBoardState,
  type GraphQLFn,
  ghGraphQL,
  main,
  parseBoardIds,
  parseBoardItems,
  runBoardTriage,
  stepSummaryMarkdown,
} from "../src/board/board-triage.ts";

/**
 * The board-triage contract (issue #209): the mechanical half of the
 * triage-issues skill, encoded as decision rules over one board read,
 * with guardrails — Status values only, lane order never touched,
 * IDs resolved fresh, every write verified by re-reading the board.
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
      labels: { nodes: (spec.labels ?? []).map((name) => ({ name })) },
      blockedBy: {
        nodes: (spec.blockers ?? []).map((blocker) => ({
          number: blocker.number,
          state: blocker.state,
        })),
      },
      timelineItems: {
        nodes: (spec.refs ?? []).map((ref) => ({
          source: ref.pr ? { number: ref.number, state: ref.state } : {},
        })),
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
    if (query.includes("updateProjectV2FieldValue")) {
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
        data: { updateProjectV2FieldValue: { clientMutationId: null } },
      };
    }

    return boardPage(nodes);
  };

  return { graphql, mutations };
}

function backlogItem(overrides: Partial<BoardItem>): BoardItem {
  return {
    id: "I1",
    number: 1,
    state: "OPEN",
    status: "Backlog",
    labels: [],
    openBlockers: [],
    openPrs: [],
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("decideTriage", () => {
  it("moves a closed issue not on Done to Done from any lane", () => {
    const decision = decideTriage(
      backlogItem({ state: "CLOSED", status: "In progress", number: 3 }),
    );

    expect(decision).toEqual({
      kind: "move",
      to: "Done",
      reason: "In progress → Done — issue closed",
    });
  });

  it("keeps a closed issue already on Done on Done", () => {
    const decision = decideTriage(
      backlogItem({ state: "CLOSED", status: "Done" }),
    );

    expect(decision).toEqual({
      kind: "stay",
      reason: "stays Done — closed, already Done",
    });
  });

  it("keeps a Backlog issue blocked by an open issue on Backlog", () => {
    const decision = decideTriage(backlogItem({ openBlockers: [31, 32] }));

    expect(decision).toEqual({
      kind: "stay",
      reason: "stays Backlog — blocked by open #31, #32",
    });
  });

  it("keeps a Backlog issue with the research label on Backlog", () => {
    const decision = decideTriage(backlogItem({ labels: ["research"] }));

    expect(decision).toEqual({
      kind: "stay",
      reason: "stays Backlog — research label",
    });
  });

  it("reports the blocker before the research label when both apply", () => {
    const decision = decideTriage(
      backlogItem({ openBlockers: [5], labels: ["research"] }),
    );

    expect(decision.kind).toBe("stay");
    expect(
      decision.kind === "stay" &&
        decision.reason.startsWith("stays Backlog — blocked"),
    ).toBe(true);
  });

  it("moves a Backlog issue with an open PR cross-reference to In progress", () => {
    const decision = decideTriage(backlogItem({ openPrs: [12] }));

    expect(decision).toEqual({
      kind: "move",
      to: "In progress",
      reason: "Backlog → In progress — open PR #12",
    });
  });

  it("moves a plain unblocked Backlog issue to Ready", () => {
    const decision = decideTriage(backlogItem({ number: 7 }));

    expect(decision).toEqual({
      kind: "move",
      to: "Ready",
      reason: "Backlog → Ready — unblocked, no research label",
    });
  });

  it("never touches an open issue on a non-Backlog lane", () => {
    const decision = decideTriage(backlogItem({ status: "Ready" }));

    expect(decision).toEqual({
      kind: "stay",
      reason: "stays Ready — not Backlog, untouched",
    });
  });

  it("leaves an item without a Status value untouched", () => {
    const decision = decideTriage(backlogItem({ status: undefined }));

    expect(decision).toEqual({
      kind: "stay",
      reason: "untouched — no Status value",
    });
  });
});

describe("parseBoardIds", () => {
  it("resolves the project id, Status field id, and the three move-target option ids fresh from the board response", () => {
    const ids = parseBoardIds({
      id: "PVT_9",
      field: {
        id: "F_9",
        options: [
          { id: "o-backlog", name: "Backlog" },
          { id: "o-ready", name: "Ready" },
          { id: "o-progress", name: "In progress" },
          { id: "o-review", name: "In review" },
          { id: "o-done", name: "Done" },
        ],
      },
    });

    expect(ids).toEqual({
      projectId: "PVT_9",
      statusFieldId: "F_9",
      optionIds: {
        Ready: "o-ready",
        "In progress": "o-progress",
        Done: "o-done",
      },
    });
  });

  it("throws naming the Status option when a move target is missing", () => {
    expect(() =>
      parseBoardIds({
        id: "PVT_9",
        field: { id: "F_9", options: [{ id: "o-done", name: "Done" }] },
      }),
    ).toThrow("Status option missing on board: Ready");
  });

  it("throws when the board has no Status field", () => {
    expect(() => parseBoardIds({ id: "PVT_9", field: null })).toThrow(
      "board has no Status field",
    );
  });
});

describe("parseBoardItems", () => {
  it("parses an issue node into triage facts, keeping only open blockers and open PR cross-references", () => {
    const items = parseBoardItems([
      issueNode({
        id: "I1",
        number: 7,
        status: "Backlog",
        labels: ["quality", "research"],
        blockers: [
          { number: 3, state: "OPEN" },
          { number: 4, state: "CLOSED" },
        ],
        refs: [
          { number: 12, state: "OPEN", pr: true },
          { number: 13, state: "MERGED", pr: true },
          { number: 99, state: "OPEN", pr: false },
        ],
      }),
    ]);

    expect(items).toEqual([
      {
        id: "I1",
        number: 7,
        state: "OPEN",
        status: "Backlog",
        labels: ["quality", "research"],
        openBlockers: [3],
        openPrs: [12],
      },
    ]);
  });

  it("skips non-issue board content such as pull requests and drafts", () => {
    const items = parseBoardItems([
      {
        id: "I2",
        fieldValueByName: null,
        content: { __typename: "PullRequest" },
      },
      issueNode({ id: "I3", number: 8, status: "Backlog" }),
    ]);

    expect(items.map((item) => item.id)).toEqual(["I3"]);
  });

  it("treats an item without a Status value as statusless, not Backlog", () => {
    const items = parseBoardItems([
      issueNode({ id: "I4", number: 9, status: null }),
    ]);

    expect(items[0]?.status).toBeUndefined();
  });
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
});

describe("runBoardTriage", () => {
  const OPTIONS = { owner: "mguinada", projectNumber: 2, dryRun: false };

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

  it("never touches lane order: the module contains no item-position mutation", async () => {
    const source = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../src/board/board-triage.ts",
      ),
      "utf8",
    );

    expect(source.includes("updateProjectV2ItemPosition")).toBe(false);
  });
});

describe("stepSummaryMarkdown", () => {
  it("renders the report as a markdown job summary", () => {
    const markdown = stepSummaryMarkdown({
      lines: [
        {
          text: "#101 Backlog → Ready — unblocked, no research label",
          level: "move",
        },
        { text: "#102 stays Backlog — blocked by open #9", level: "stay" },
      ],
      summary: "board-triage: 1 move, 1 stay, 0 untouched — dry run, no writes",
      moves: 1,
      ok: true,
      dryRun: true,
    });

    expect(markdown).toBe(
      [
        "## Board triage (dry run)",
        "",
        "- #101 Backlog → Ready — unblocked, no research label",
        "- #102 stays Backlog — blocked by open #9",
        "",
        "board-triage: 1 move, 1 stay, 0 untouched — dry run, no writes",
        "",
      ].join("\n"),
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
      '#!/bin/sh\necho \'{"data":{"via":"\'"$GITHUB_TOKEN"\'"}}\'\n',
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

describe("main", () => {
  async function runCli(
    args: string[],
    graphql: GraphQLFn | undefined,
    env: Record<string, string> = {},
  ): Promise<{ out: string[]; err: string[] }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];
    const savedEnv: Record<string, string | undefined> = {};

    for (const key of [...Object.keys(env), "GITHUB_STEP_SUMMARY"]) {
      savedEnv[key] = process.env[key];
    }

    process.argv = [...argv.slice(0, 2), ...args];
    Object.assign(process.env, env);
    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main(graphql);
    } finally {
      process.argv = argv;

      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out, err };
  }

  it("prints the usage line for --help with exit 0 and no side effects", async () => {
    const { out, err } = await runCli(["--help"], undefined);

    expect(
      `${process.exitCode}|${err.length}|${out[0]?.startsWith("Usage: board-triage")}`,
    ).toBe("undefined|0|true");
  });

  it("rejects an unknown option with exit 1", async () => {
    const { err } = await runCli(["--wat"], undefined);

    expect(err[0]).toContain("unknown option");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a non-numeric --project value with exit 1", async () => {
    const { err } = await runCli(["--project", "abc"], undefined);

    expect(err[0]).toContain("--project needs a project number");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a valueless --owner with exit 1", async () => {
    const { err } = await runCli(["--owner"], undefined);

    expect(err[0]).toContain("--owner needs a login value");
    expect(process.exitCode).toBe(1);
  });

  it("runs the injected client with the parsed owner and project", async () => {
    const seen: { owner: string; projectNumber: number }[] = [];
    const graphql: GraphQLFn = async (_query, variables) => {
      seen.push({
        owner: String(variables.owner),
        projectNumber: Number(variables.projectNumber),
      });

      return boardPage([issueNode({ id: "I1", number: 1, status: "Backlog" })]);
    };

    await runCli(["--owner", "octo", "--project", "7", "--dry-run"], graphql);

    expect(seen[0]).toEqual({ owner: "octo", projectNumber: 7 });
  });

  it("renders the dry-run plan on stdout and appends the job summary when GITHUB_STEP_SUMMARY is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-triage-summary-"));

    tempDirs.push(dir);

    const summaryPath = join(dir, "summary.md");
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 7, status: "Backlog" }),
    ]);

    const { out } = await runCli(["--dry-run"], graphql, {
      GITHUB_STEP_SUMMARY: summaryPath,
      NO_COLOR: "1",
    });

    expect(out).toContain("#7 Backlog → Ready — unblocked, no research label");
    expect(await readFile(summaryPath, "utf8")).toContain(
      "## Board triage (dry run)",
    );
  });

  it("reports a failing client red on stderr with exit 1", async () => {
    const graphql: GraphQLFn = async () => {
      throw new Error("boom");
    };

    const { err } = await runCli([], graphql);

    expect(err[0]).toContain("board-triage: boom");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when a move fails verification", async () => {
    const { graphql } = fakeBoard(
      [issueNode({ id: "I1", number: 7, status: "Backlog" })],
      {
        failAlways: ["I1"],
      },
    );

    const { err } = await runCli([], graphql);

    expect(err.some((line) => line.includes("not verified"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
