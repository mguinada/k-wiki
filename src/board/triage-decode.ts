import { isPlainObject } from "../cli/shared.ts";
import type { BoardItem } from "./triage-rules.ts";

/**
 * Board-response decoding (issue #209, extracted in issue #259):
 * turn one raw GraphQL page — the project envelope with its Status
 * field, and the item nodes — into the typed facts the triage
 * contract decides on. Decoding is strict by design: a malformed
 * field fails the run instead of guessing, and a nested connection
 * truncated at its page cap fails too, because silently dropping an
 * open blocker or a live PR reference would misclassify the item
 * (finding O-5).
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

export type JsonRecord = Record<string, unknown>;

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

/** The project record of one board-page response, named by owner and
 *  number when the token cannot read it. */
export function requireProject(
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

/** The item nodes of one decoded project record. */
export function itemNodes(project: JsonRecord): readonly unknown[] {
  const nodes = asRecord(project.items)?.nodes;

  return Array.isArray(nodes) ? nodes : [];
}

/** The next-page cursor of one decoded project record, null when the
 *  connection ends (or its cursor is not a string). */
export function nextCursor(project: JsonRecord): string | null {
  const pageInfo = asRecord(asRecord(project.items)?.pageInfo);

  return pageInfo?.hasNextPage === true &&
    typeof pageInfo.endCursor === "string"
    ? pageInfo.endCursor
    : null;
}
