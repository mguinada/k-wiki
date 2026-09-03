import { describe, expect, it } from "vitest";
import {
  parseBoardIds,
  parseBoardItems,
} from "../../src/board/triage-decode.ts";

const STATUS_OPTIONS = [
  { id: "o-backlog", name: "Backlog" },
  { id: "o-ready", name: "Ready" },
  { id: "o-progress", name: "In progress" },
  { id: "o-review", name: "In review" },
  { id: "o-done", name: "Done" },
] as const;

const STATUS_FIELD = { id: "F_status", options: STATUS_OPTIONS };

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

  it("throws the named project error for a non-record project", () => {
    expect(() => parseBoardIds(null)).toThrow(
      "board response is missing the project",
    );
  });

  it("throws naming the project id when it is an empty string", () => {
    expect(() =>
      parseBoardIds({
        id: "",
        field: { id: "F_9", options: STATUS_FIELD.options },
      }),
    ).toThrow("board response is missing the project id");
  });

  it("throws naming the Status field id when it is an empty string", () => {
    expect(() =>
      parseBoardIds({
        id: "PVT_9",
        field: { id: "", options: STATUS_FIELD.options },
      }),
    ).toThrow("board response is missing the Status field id");
  });

  it("throws naming the missing Status option when options holds only non-records", () => {
    expect(() =>
      parseBoardIds({
        id: "PVT_9",
        field: { id: "F_9", options: [5, "junk"] },
      }),
    ).toThrow("Status option missing on board: Ready");
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

  it("throws on an item node without an id", () => {
    expect(() =>
      parseBoardItems([
        {
          fieldValueByName: null,
          content: { __typename: "Issue", number: 5, state: "OPEN" },
        },
      ]),
    ).toThrow("board response is missing an item id");
  });

  it("throws on an unknown issue state", () => {
    expect(() =>
      parseBoardItems([
        {
          id: "I5",
          fieldValueByName: null,
          content: { __typename: "Issue", number: 5, state: "MERGED" },
        },
      ]),
    ).toThrow("unknown issue state: MERGED");
  });

  it("throws naming the item when the issue number is a string", () => {
    expect(() =>
      parseBoardItems([
        {
          id: "I9",
          fieldValueByName: null,
          content: { __typename: "Issue", number: "7", state: "OPEN" },
        },
      ]),
    ).toThrow("board response is missing the issue number of item I9");
  });

  it("throws naming the item when the issue number is NaN", () => {
    expect(() =>
      parseBoardItems([
        {
          id: "I9",
          fieldValueByName: null,
          content: { __typename: "Issue", number: Number.NaN, state: "OPEN" },
        },
      ]),
    ).toThrow("board response is missing the issue number of item I9");
  });

  it("treats a non-string Status field name as statusless", () => {
    const items = parseBoardItems([
      {
        id: "I6",
        fieldValueByName: { name: 5, optionId: "o-x" },
        content: { __typename: "Issue", number: 6, state: "OPEN" },
      },
    ]);

    expect(items[0]?.status).toBeUndefined();
  });

  it("keeps only record string entries from the labels connection", () => {
    const items = parseBoardItems([
      {
        id: "I7",
        fieldValueByName: null,
        content: {
          __typename: "Issue",
          number: 7,
          state: "OPEN",
          labels: { nodes: [{ name: "quality" }, 5] },
        },
      },
    ]);

    expect(items[0]?.labels).toEqual(["quality"]);
  });

  it("keeps only open record blockers that carry a number", () => {
    const items = parseBoardItems([
      {
        id: "I8",
        fieldValueByName: null,
        content: {
          __typename: "Issue",
          number: 8,
          state: "OPEN",
          blockedBy: {
            nodes: [
              { number: 3, state: "OPEN" },
              { number: 4, state: "CLOSED" },
              5,
              { state: "OPEN" },
            ],
          },
        },
      },
    ]);

    expect(items[0]?.openBlockers).toEqual([3]);
  });

  it("keeps only open pull-request sources among mixed cross-references", () => {
    const items = parseBoardItems([
      {
        id: "I10",
        fieldValueByName: null,
        content: {
          __typename: "Issue",
          number: 10,
          state: "OPEN",
          timelineItems: {
            nodes: [
              { source: { number: 1, state: "OPEN" } },
              { source: { number: 13, state: "MERGED" } },
              { source: { number: "9", state: "OPEN" } },
              { source: {} },
              5,
            ],
          },
        },
      },
    ]);

    expect(items[0]?.openPrs).toEqual([1]);
  });

  it("skips non-record nodes and nodes without content", () => {
    const items = parseBoardItems([
      5,
      { id: "I11", fieldValueByName: null },
      issueNode({ id: "I12", number: 12, status: "Backlog" }),
    ]);

    expect(items.map((item) => item.number)).toEqual([12]);
  });

  it("parses an issue node that carries no labels, blockers, or cross-references keys", () => {
    const items = parseBoardItems([
      {
        id: "I13",
        fieldValueByName: null,
        content: { __typename: "Issue", number: 13, state: "OPEN" },
      },
    ]);

    expect(items[0]).toEqual({
      id: "I13",
      number: 13,
      state: "OPEN",
      status: undefined,
      labels: [],
      openBlockers: [],
      openPrs: [],
    });
  });
});
