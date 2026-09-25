/**
 * The shared-writer marker (issue #390): read and validate the
 * operator-owned `.k-wiki/shared-writer.json` at the data repo root —
 * the tracked, visible switch that puts a remote-backed data repo in
 * shared-writer mode. Strict v1: malformed JSON, an unknown version,
 * missing or invalid fields, and unknown keys all fail closed, so a
 * half-written or future-format marker never silently downgrades the
 * protocol a cycle runs under. Reading is all this module does; the
 * enable command is the only writer, and it commits the marker.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isPlainObject } from "../cli/shared.ts";

/** The marker's repo-relative path inside the data repo. */
export const MARKER_PATH = ".k-wiki/shared-writer.json";

/** The lease ref namespace every v1 lease ref must live under. */
export const LEASE_REF_NAMESPACE = "refs/k-wiki/leases/";

/** The one source-removal policy v1 defines (issue #390): a proposed
 *  source removal or rename needs a human confirmation receipt. */
export const REMOVAL_POLICY = "confirm";

/** The parsed marker. Fields are verbatim from the schema (issue
 *  #390); `branch` is a bare branch name, `leaseRef` a full ref. */
export interface SharedWriterMarker {
  readonly version: 1;
  readonly remote: string;
  readonly branch: string;
  readonly leaseRef: string;
  readonly sourceRemovalPolicy: "confirm";
}

/** The outcome of reading a data repo's marker. `invalid` fails
 *  shared-mode runs closed before any source scan (issue #390). */
export type MarkerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "enabled"; readonly marker: SharedWriterMarker }
  | { readonly kind: "invalid"; readonly reason: string };

/** The marker's absolute path for a data repo root. */
export function markerPath(dataRoot: string): string {
  return join(dataRoot, MARKER_PATH);
}

/** A non-empty string without whitespace or path separators —
 *  remote names, and branch names as bare names (a full ref is not
 *  a branch). */
function isName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/\s/.test(value);
}

/** Reject keys outside the v1 schema, so a future field added by a
 *  newer writer is a loud failure, never silently ignored. */
function rejectUnknownKeys(
  parsed: Record<string, unknown>,
  origin: string,
): void {
  const known = new Set([
    "version",
    "remote",
    "branch",
    "leaseRef",
    "sourceRemovalPolicy",
  ]);

  for (const key of Object.keys(parsed)) {
    if (!known.has(key)) {
      throw new Error(`${origin}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

/** Validate the lease ref: a full ref under the k-wiki lease
 *  namespace with a non-empty leaf, so a marker can never point the
 *  protocol at an arbitrary ref (say `refs/heads/main`). */
function parseLeaseRef(value: unknown, origin: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(LEASE_REF_NAMESPACE) ||
    value.length <= LEASE_REF_NAMESPACE.length
  ) {
    throw new Error(
      `${origin}: "leaseRef" must be a full ref under ${LEASE_REF_NAMESPACE}`,
    );
  }

  return value;
}

/** Parse and validate marker text; throws with the origin path in
 *  the message on any v1 violation. */
export function parseSharedWriterMarker(
  text: string,
  origin: string,
): SharedWriterMarker {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${origin}: not valid JSON`, { cause });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${origin}: expected a JSON object`);
  }

  rejectUnknownKeys(parsed, origin);

  if (parsed.version !== 1) {
    throw new Error(
      `${origin}: unsupported "version" ${JSON.stringify(parsed.version)} — this build speaks protocol v1 only`,
    );
  }

  if (!isName(parsed.remote)) {
    throw new Error(`${origin}: "remote" must be a remote name`);
  }

  if (!isName(parsed.branch) || parsed.branch.includes("/")) {
    throw new Error(`${origin}: "branch" must be a bare branch name`);
  }

  if (parsed.sourceRemovalPolicy !== REMOVAL_POLICY) {
    throw new Error(
      `${origin}: "sourceRemovalPolicy" must be ${JSON.stringify(REMOVAL_POLICY)}`,
    );
  }

  return {
    version: 1,
    remote: parsed.remote,
    branch: parsed.branch,
    leaseRef: parseLeaseRef(parsed.leaseRef, origin),
    sourceRemovalPolicy: parsed.sourceRemovalPolicy,
  };
}

/** Read the data repo's marker. An absent file is the ordinary
 *  not-enabled case; anything present but not a valid v1 marker is
 *  `invalid` — the caller fails closed naming the reason. */
export async function readSharedWriterMarker(
  dataRoot: string,
): Promise<MarkerRead> {
  const path = markerPath(dataRoot);
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (text === undefined) {
    return { kind: "absent" };
  }

  try {
    return { kind: "enabled", marker: parseSharedWriterMarker(text, path) };
  } catch (error) {
    return { kind: "invalid", reason: (error as Error).message };
  }
}

/** Return whether the marker enables shared-writer mode, failing closed on invalid data. */
export async function markerIsEnabled(dataRoot: string): Promise<boolean> {
  const marker = await readSharedWriterMarker(dataRoot);

  if (marker.kind === "invalid") {
    throw new Error(
      `shared-writer marker is invalid — refusing to enable: ${marker.reason}`,
    );
  }

  return marker.kind === "enabled";
}
