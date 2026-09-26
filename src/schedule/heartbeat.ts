/**
 * The scheduled cycle's heartbeat (issue #362): one gitignored stamp
 * file in the data repo — `outputs/last-cycle.json` — written on
 * every cycle completion (ok, failed, or a benign quota-skipped tick).
 * A skipped tick releases its local lock before writing the stamp. The
 * stamp carries this cycle's timestamp, outcome, and holder PID plus the timestamp of
 * the last ok cycle, carried forward, so "when did the pipeline
 * last succeed" survives failed cycles. The independent watchdog
 * (bin/libexec/sync-watchdog) and the dashboard's last-cycle row
 * read it; both catch failures the pipeline's own process can never
 * report — a crash before startup leaves no log line, but a
 * stamping heartbeat that goes stale is visible from outside. The
 * watchdog's grace window also has an install anchor here: the ISO
 * line setup-schedule writes when the watchdog registration is
 * installed, so a stamp-less upgrade (an existing data repo whose
 * commits are old) holds the same grace a fresh init gets from its
 * seed commit.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { readTextIfExists } from "../cli/shared.ts";
import { ensureHeartbeatIgnored } from "../ingest/snapshot.ts";
import type { PreflightState } from "./quota-preflight.ts";

/** The stamp file's name in the data repo's outputs/. */
export const CYCLE_HEARTBEAT_FILENAME = "last-cycle.json";

/** The heartbeat stamp: one cycle's completion record. */
export interface CycleHeartbeat {
  /** When this cycle finished, ISO timestamp. */
  readonly timestamp: string;
  /** The cycle's outcome; skipped ticks are benign quota pre-flight ticks. */
  readonly outcome: "ok" | "failed" | "skipped";
  /** Why a benign skipped tick occurred, when present. */
  readonly reason?: string;
  /** How the cycle's quota pre-flight acted when it did not gate:
   *  `off` (disabled in settings), `unavailable` (probe absent or
   *  unreadable), or `no-provider` (settings name no provider);
   *  absent when the gate was active. */
  readonly preflight?: PreflightState;
  /** The PID that ran the cycle. */
  readonly pid: number;
  /** When the last ok cycle finished, carried forward through
   *  failed cycles; null when no ok cycle is on record. */
  readonly lastOk: string | null;
}

/** What reading the stamp yields: present, missing, or unreadable
 *  (torn bytes, invalid JSON, no usable timestamp) — the watchdog
 *  treats unreadable as a fault, never as fresh. */
export type ReadHeartbeat =
  | { readonly kind: "present"; readonly stamp: CycleHeartbeat }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The stamp file's path in a data repo. */
export function cycleHeartbeatPath(dataRoot: string): string {
  return join(dataRoot, "outputs", CYCLE_HEARTBEAT_FILENAME);
}

/** The watchdog install anchor's file name in the data repo's
 *  outputs/: one ISO line, written by setup-schedule when the
 *  watchdog registration installs (and re-written on every
 *  re-install, which re-arms the grace — a fresh install legitimately
 *  expects the pipeline to reach its next cycle within the
 *  threshold). */
export const WATCHDOG_SINCE_FILENAME = "watchdog-since.txt";

/** The grace anchor's path in a data repo. */
export function watchdogSincePath(dataRoot: string): string {
  return join(dataRoot, "outputs", WATCHDOG_SINCE_FILENAME);
}

/** Read the grace anchor; undefined when absent or unusable — the
 *  watchdog then falls back to its other grace reference. */
export async function readWatchdogSince(
  dataRoot: string,
): Promise<Date | undefined> {
  const text = await readTextIfExists(watchdogSincePath(dataRoot));

  if (text === undefined) {
    return undefined;
  }

  const date = new Date(text.trim());

  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Write the grace anchor for a watchdog install: one ISO line,
 *  atomic (tmp + rename) like the stamp so torn bytes can never
 *  read as a reference, and kept out of the data repo's history the
 *  same per-instance way. */
export async function writeWatchdogSince(options: {
  readonly dataRoot: string;
  readonly now: Date;
  /** Progress sink for the one-time exclude announcement; default
   *  silent. */
  readonly onProgress?: (line: string) => void;
}): Promise<void> {
  await ensureHeartbeatIgnored(
    options.dataRoot,
    options.onProgress ?? (() => {}),
  );
  await mkdir(dirname(watchdogSincePath(options.dataRoot)), {
    recursive: true,
  });

  const path = watchdogSincePath(options.dataRoot);
  const tmpPath = `${path}.tmp`;

  await writeFile(tmpPath, `${options.now.toISOString()}\n`, "utf8");
  await rename(tmpPath, path);
}

/** An ISO timestamp string. */
function isIsoString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** The record shape a stamp's fields must have for the stamp to
 *  be trusted (lastOk checked separately — it is optional). */
interface StampFields {
  readonly timestamp: string;
  readonly outcome: "ok" | "failed" | "skipped";
  readonly reason?: unknown;
  readonly preflight?: unknown;
  readonly pid: number;
  readonly lastOk?: unknown;
}

/** Whether the parsed JSON carries a complete stamp: a usable
 *  timestamp, an ok|failed|skipped outcome, and an integer PID. */
function isStampShape(parsed: unknown): parsed is StampFields {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    isIsoString((parsed as Record<string, unknown>).timestamp) &&
    ((parsed as Record<string, unknown>).outcome === "ok" ||
      (parsed as Record<string, unknown>).outcome === "failed" ||
      (parsed as Record<string, unknown>).outcome === "skipped") &&
    Number.isInteger((parsed as Record<string, unknown>).pid)
  );
}

/** Parse stamp text into a heartbeat; `parseError` when the text
 *  cannot be trusted (the watchdog alerts on unreadable stamps, so a
 *  parse never silently reads as fresh). The dedicated tag — not
 *  `reason`, which a real stamp itself carries — is what lets the
 *  caller tell a parse failure from a skipped stamp's cause. */
export function parseHeartbeat(
  text: string,
): CycleHeartbeat | { readonly parseError: string } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { parseError: `not valid JSON (${errorMessage(cause)})` };
  }

  if (!isStampShape(parsed)) {
    return { parseError: "missing or invalid timestamp, outcome, or pid" };
  }

  return {
    timestamp: parsed.timestamp,
    outcome: parsed.outcome,
    ...(typeof parsed.reason === "string" && { reason: parsed.reason }),
    ...((parsed.preflight === "unavailable" ||
      parsed.preflight === "off" ||
      parsed.preflight === "no-provider") && {
      preflight: parsed.preflight,
    }),
    pid: parsed.pid,
    lastOk: isIsoString(parsed.lastOk) ? parsed.lastOk : null,
  };
}

/** Read the stamp; missing when the file is absent, unreadable when
 *  its bytes cannot be trusted. */
export async function readCycleHeartbeat(
  dataRoot: string,
): Promise<ReadHeartbeat> {
  const text = await readTextIfExists(cycleHeartbeatPath(dataRoot));

  if (text === undefined) {
    return { kind: "missing" };
  }

  const parsed = parseHeartbeat(text);

  return "parseError" in parsed
    ? { kind: "unreadable", reason: parsed.parseError }
    : { kind: "present", stamp: parsed };
}

/** Write the stamp for one completed cycle: timestamp, outcome, and
 *  PID, with the last-ok timestamp carried forward from the
 *  previous stamp (a failed cycle keeps the older success on
 *  record; an unreadable previous stamp reads as no success yet). A
 *  skipped tick preserves the last successful timestamp. Atomic (tmp + rename)
 *  so a torn write can never masquerade as a
 *  heartbeat, and the stamp is kept out of the data repo's history
 *  via .git/info/exclude, re-applied on every write so fresh
 *  clones self-heal. */
export async function writeCycleHeartbeat(options: {
  readonly dataRoot: string;
  readonly outcome: "ok" | "failed" | "skipped";
  readonly reason?: string;
  readonly preflight?: PreflightState;
  readonly pid: number;
  readonly now: Date;
  /** Progress sink for the one-time exclude announcement; default
   *  silent. */
  readonly onProgress?: (line: string) => void;
}): Promise<void> {
  const previous = await readCycleHeartbeat(options.dataRoot);
  const previousStamp =
    previous.kind === "present" ? previous.stamp : undefined;
  const lastOk =
    options.outcome === "ok"
      ? options.now.toISOString()
      : (previousStamp?.lastOk ?? null);

  const stamp: CycleHeartbeat = {
    timestamp: options.now.toISOString(),
    outcome: options.outcome,
    ...(options.reason !== undefined && { reason: options.reason }),
    ...(options.preflight !== undefined && { preflight: options.preflight }),
    pid: options.pid,
    lastOk,
  };
  const path = cycleHeartbeatPath(options.dataRoot);

  await ensureHeartbeatIgnored(
    options.dataRoot,
    options.onProgress ?? (() => {}),
  );
  await mkdir(dirname(path), { recursive: true });

  const tmpPath = `${path}.tmp`;

  await writeFile(tmpPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

/** What the watchdog verdict says about a present stamp. */
export type HeartbeatVerdict =
  | { readonly verdict: "fresh"; readonly ageMs: number }
  | { readonly verdict: "stale"; readonly ageMs: number };

/** Classify a present stamp against a staleness threshold: the age
 *  of the stamp's recorded timestamp, fresh when within the
 *  threshold (the boundary itself counts as fresh). */
export function classifyHeartbeat(
  stamp: CycleHeartbeat,
  now: Date,
  thresholdMs: number,
): HeartbeatVerdict {
  const ageMs = Math.max(0, now.getTime() - Date.parse(stamp.timestamp));

  return ageMs <= thresholdMs
    ? { verdict: "fresh", ageMs }
    : { verdict: "stale", ageMs };
}

/** A human age: `45m`, `3h 5m`, `2d 4h` — coarse on purpose; the
 *  watchdog line and the dashboard row name ages, not clocks. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const mins = minutes % 60;

  return hours > 0 && mins > 0
    ? `${hours}h ${mins}m`
    : hours > 0
      ? `${hours}h`
      : `${mins}m`;
}
