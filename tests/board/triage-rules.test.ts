import { describe, expect, it } from "vitest";
import {
  type BoardItem,
  DRY_OUTCOME,
  decideTriage,
  describeMove,
  plannedLines,
  toMove,
  triageSummary,
} from "../../src/board/triage-rules.ts";

/** One Backlog board item with overrides. */
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

describe("decideTriage", () => {
  it("moves a closed issue not on Done to Done from any lane", () => {
    expect(decideTriage(backlogItem({ state: "CLOSED" }))).toEqual({
      kind: "move",
      to: "Done",
      reason: "Backlog → Done — issue closed",
    });
  });

  it("keeps a closed issue already on Done on Done", () => {
    expect(
      decideTriage(backlogItem({ state: "CLOSED", status: "Done" })),
    ).toEqual({
      kind: "stay",
      reason: "stays Done — closed, already Done",
    });
  });

  it("keeps a Backlog issue blocked by an open issue on Backlog", () => {
    expect(decideTriage(backlogItem({ openBlockers: [4] }))).toEqual({
      kind: "stay",
      reason: "stays Backlog — blocked by open #4",
    });
  });

  it("keeps a Backlog issue with the research label on Backlog", () => {
    expect(decideTriage(backlogItem({ labels: ["research"] }))).toEqual({
      kind: "stay",
      reason: "stays Backlog — research label",
    });
  });

  it("reports the blocker before the research label when both apply", () => {
    expect(
      decideTriage(backlogItem({ labels: ["research"], openBlockers: [4, 7] })),
    ).toEqual({
      kind: "stay",
      reason: "stays Backlog — blocked by open #4, #7",
    });
  });

  it("moves a Backlog issue with an open PR cross-reference to In progress", () => {
    expect(decideTriage(backlogItem({ openPrs: [12] }))).toEqual({
      kind: "move",
      to: "In progress",
      reason: "Backlog → In progress — open PR #12",
    });
  });

  it("moves a plain unblocked Backlog issue to Ready", () => {
    expect(decideTriage(backlogItem({}))).toEqual({
      kind: "move",
      to: "Ready",
      reason: "Backlog → Ready — unblocked, no research label",
    });
  });

  it("never touches an open issue on a non-Backlog lane", () => {
    expect(decideTriage(backlogItem({ status: "In review" }))).toEqual({
      kind: "stay",
      reason: "stays In review — not Backlog, untouched",
    });
  });

  it("leaves an item without a Status value untouched", () => {
    expect(decideTriage(backlogItem({ status: undefined }))).toEqual({
      kind: "stay",
      reason: "untouched — no Status value",
    });
  });
});

describe("toMove", () => {
  it("narrows a move decision to its target lane", () => {
    const item = backlogItem({});

    expect(
      toMove({ item, decision: { kind: "move", to: "Ready", reason: "r" } }),
    ).toEqual([{ item, to: "Ready" }]);
  });

  it("drops stay decisions", () => {
    expect(
      toMove({
        item: backlogItem({}),
        decision: { kind: "stay", reason: "r" },
      }),
    ).toEqual([]);
  });
});

describe("plannedLines", () => {
  it("logs a Backlog move with its reason", () => {
    const item = backlogItem({});

    expect(
      plannedLines([
        {
          item,
          decision: {
            kind: "move",
            to: "Ready",
            reason: "Backlog → Ready — unblocked",
          },
        },
      ]),
    ).toEqual([{ text: "#1 Backlog → Ready — unblocked", level: "move" }]);
  });

  it("logs a statusless item as a stay", () => {
    const item = backlogItem({ status: undefined });

    expect(plannedLines([{ item, decision: decideTriage(item) }])).toEqual([
      { text: "#1 untouched — no Status value", level: "stay" },
    ]);
  });

  it("logs a closed item still on Backlog as a move to Done", () => {
    const item = backlogItem({ state: "CLOSED" });

    expect(plannedLines([{ item, decision: decideTriage(item) }])).toEqual([
      { text: "#1 Backlog → Done — issue closed", level: "move" },
    ]);
  });

  it("does not log an open item already on Ready", () => {
    const item = backlogItem({ status: "Ready" });

    expect(plannedLines([{ item, decision: decideTriage(item) }])).toEqual([]);
  });

  it("does not log a closed item already on Done", () => {
    const item = backlogItem({ state: "CLOSED", status: "Done" });

    expect(plannedLines([{ item, decision: decideTriage(item) }])).toEqual([]);
  });
});

describe("describeMove", () => {
  it("describes one applied move as number, from-lane, and to-lane", () => {
    expect(
      describeMove({ item: backlogItem({ number: 3 }), to: "Ready" }),
    ).toBe("#3 Backlog → Ready");
  });

  it("says no Status when the moved item had none", () => {
    expect(
      describeMove({
        item: backlogItem({ status: undefined }),
        to: "Done",
      }),
    ).toBe("#1 no Status → Done");
  });
});

describe("triageSummary", () => {
  it("names a dry run in the summary", () => {
    expect(triageSummary(1, 2, 3, DRY_OUTCOME, true)).toBe(
      "board-triage: 1 move, 2 stays, 3 untouched — dry run, no writes",
    );
  });

  it("reports verification against the board when no move failed", () => {
    expect(triageSummary(2, 0, 1, { reconciled: 1, failed: [] }, false)).toBe(
      "board-triage: 2 moves, 0 stays, 1 untouched — verified against the board (1 reconciled)",
    );
  });

  it("reports the unverified move count when verification failed", () => {
    const failed = [
      {
        move: { item: backlogItem({}), to: "Ready" as const },
        actual: "Backlog",
      },
    ];

    expect(triageSummary(1, 0, 0, { reconciled: 0, failed }, false)).toBe(
      "board-triage: 1 move, 0 stays, 0 untouched — 1 move not verified",
    );
  });
});
