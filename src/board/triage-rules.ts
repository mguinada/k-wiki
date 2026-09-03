import { pluralized } from "../cli/shared.ts";

/**
 * The triage decision rules (issue #209, extracted in issue #259):
 * the contract's mechanical verdict for one board item — closed
 * issues move to Done from any lane, Backlog issues with an open PR
 * cross-reference move to In progress, unblocked Backlog issues move
 * to Ready, everything else stays — plus the pure planning and
 * summary layer over those verdicts. Pure over board facts: no
 * GraphQL, no process, no printing (finding O-5).
 */

/** One issue item on the board, with the facts the contract needs. */
export interface BoardItem {
  readonly id: string;
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  /** The Status single-select lane name; undefined when unset. */
  readonly status: string | undefined;
  readonly labels: readonly string[];
  readonly openBlockers: readonly number[];
  readonly openPrs: readonly number[];
}

export type TriageDecision =
  | {
      readonly kind: "move";
      readonly to: "Ready" | "In progress" | "Done";
      readonly reason: string;
    }
  | { readonly kind: "stay"; readonly reason: string };

export interface TriageLine {
  readonly text: string;
  readonly level: "move" | "stay" | "error";
}

export interface TriageReport {
  readonly lines: readonly TriageLine[];
  readonly summary: string;
  readonly moves: number;
  readonly ok: boolean;
  readonly dryRun: boolean;
}

function issueNumbers(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

/** The contract's mechanical verdict for one item (triage-issues
 *  rules 1–4; the closed→Done exception of issue #209 included). */
export function decideTriage(item: BoardItem): TriageDecision {
  if (item.status === undefined) {
    return { kind: "stay", reason: "untouched — no Status value" };
  }

  if (item.state === "CLOSED") {
    return item.status === "Done"
      ? { kind: "stay", reason: "stays Done — closed, already Done" }
      : {
          kind: "move",
          to: "Done",
          reason: `${item.status} → Done — issue closed`,
        };
  }

  if (item.status !== "Backlog") {
    return {
      kind: "stay",
      reason: `stays ${item.status} — not Backlog, untouched`,
    };
  }

  return backlogDecision(item);
}

function backlogDecision(item: BoardItem): TriageDecision {
  if (item.openBlockers.length > 0) {
    return {
      kind: "stay",
      reason: `stays Backlog — blocked by open ${issueNumbers(item.openBlockers)}`,
    };
  }

  if (item.labels.includes("research")) {
    return { kind: "stay", reason: "stays Backlog — research label" };
  }

  if (item.openPrs.length > 0) {
    return {
      kind: "move",
      to: "In progress",
      reason: `Backlog → In progress — open PR ${issueNumbers(item.openPrs)}`,
    };
  }

  return {
    kind: "move",
    to: "Ready",
    reason: "Backlog → Ready — unblocked, no research label",
  };
}

/** One planned entry: an item with its decision (toMove/plannedLines input). */
export interface PlannedEntry {
  readonly item: BoardItem;
  readonly decision: TriageDecision;
}

/** A planned move: the narrowed form of a move decision, so apply and
 *  verify code carries the invariant in its type. */
export interface PlannedMove {
  readonly item: BoardItem;
  readonly to: "Ready" | "In progress" | "Done";
}

/** Narrow planned entries to their moves. */
export function toMove(entry: PlannedEntry): PlannedMove[] {
  return entry.decision.kind === "move"
    ? [{ item: entry.item, to: entry.decision.to }]
    : [];
}

/** Whether the entry gets a report line: Backlog items, statusless
 *  items, and closed items not yet Done. Open items on other lanes
 *  are untouched and unlogged. */
function isLogged(entry: PlannedEntry): boolean {
  const { item } = entry;

  return (
    item.status === undefined ||
    item.status === "Backlog" ||
    (item.state === "CLOSED" && item.status !== "Done")
  );
}

/** One report line per logged entry, carrying its decision reason. */
export function plannedLines(planned: readonly PlannedEntry[]): TriageLine[] {
  const lines: TriageLine[] = [];

  for (const entry of planned) {
    if (isLogged(entry)) {
      lines.push({
        text: `#${entry.item.number} ${entry.decision.reason}`,
        level: entry.decision.kind === "move" ? "move" : "stay",
      });
    }
  }

  return lines;
}

/** One applied move as a report fragment: `#101 Backlog → Ready`. */
export function describeMove(move: PlannedMove): string {
  return `#${move.item.number} ${move.item.status ?? "no Status"} → ${move.to}`;
}

/** Moves that the re-read board contradicts: the item is not on the
 *  lane the mutation targeted. */
export interface UnverifiedMove {
  readonly move: PlannedMove;
  readonly actual: string;
}

/** The apply phase's outcome: how many lost writes the one retry
 *  reconciled, and what still failed verification. */
export interface TriageOutcome {
  readonly reconciled: number;
  readonly failed: readonly UnverifiedMove[];
}

/** The outcome of a dry run — or of an apply with no moves. */
export const DRY_OUTCOME: TriageOutcome = { reconciled: 0, failed: [] };

export function triageSummary(
  moves: number,
  stays: number,
  untouched: number,
  outcome: TriageOutcome,
  dryRun: boolean,
): string {
  const counts = `${pluralized(moves, "move")}, ${pluralized(stays, "stay")}, ${untouched} untouched`;

  if (dryRun) {
    return `board-triage: ${counts} — dry run, no writes`;
  }

  const suffix =
    outcome.failed.length > 0
      ? `${pluralized(outcome.failed.length, "move")} not verified`
      : `verified against the board (${outcome.reconciled} reconciled)`;

  return `board-triage: ${counts} — ${suffix}`;
}
