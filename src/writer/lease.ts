/**
 * The remote lease (issue #390): the application protocol that
 * serializes shared-writer cycles through one Git ref —
 * `refs/k-wiki/leases/<name>` on the configured remote. The lease is
 * a synthetic commit (tree = the remote branch's tree, no parent)
 * whose message carries the protocol fields: version, token, holder,
 * acquired, expires, base remote SHA, renewal count. Every state
 * change is a compare-and-swap push: an absent-ref create is a plain
 * push (a racing second create is a non-fast-forward rejection), a
 * replacement or deletion must quote the exact expected OID via
 * `--force-with-lease`, and there is never a delete-then-create gap.
 * Lease commits never enter branch history. A live lease refuses a
 * second writer before any write; only an expired observed lease may
 * be taken over automatically, and only by quoting its exact OID.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  type GitRunner,
  gitOut,
  lsRemoteOid,
  revParseOid,
} from "./git-remote.ts";
import {
  LEASE_PROTOCOL_VERSION,
  LEASE_SUBJECT,
  parseLeaseBody,
} from "./lease-schema.ts";

/** Four hours, matching the local run lock's stale window: a full
 *  cycle with both agent stages stays well inside it. */
export const LEASE_TTL_MS = 4 * 60 * 60 * 1000;

/** The machine-readable fields of one lease commit's message body. */
export interface LeaseBody {
  readonly token: string;
  readonly holder: string;
  readonly acquired: string;
  readonly expires: string;
  readonly base: string;
  readonly renewals: number;
}

/** The live lease as observed on the remote: its OID plus parsed
 *  body. */
export interface ObservedLease {
  readonly oid: string;
  readonly body: LeaseBody;
}

/** The holder identifier for this process — diagnostics only; the
 *  protocol never treats a holder name as authority. */
export function leaseHolder(pid: number = process.pid): string {
  return `${hostname()}:${pid}`;
}

/** Serialize the lease body into its commit-message form: subject,
 *  blank line, one `field: value` line per field. */
export function serializeLeaseBody(body: LeaseBody): string {
  return [
    LEASE_SUBJECT,
    "",
    `protocol: ${LEASE_PROTOCOL_VERSION}`,
    `token: ${body.token}`,
    `holder: ${body.holder}`,
    `acquired: ${body.acquired}`,
    `expires: ${body.expires}`,
    `base: ${body.base}`,
    `renewals: ${body.renewals}`,
    "",
  ].join("\n");
}

/** Parse one `field: value` body line; undefined when malformed. */
function parseField(line: string): [string, string] | undefined {
  const cut = line.indexOf(": ");

  return cut === -1 ? undefined : [line.slice(0, cut), line.slice(cut + 2)];
}

/** Parse and validate a lease commit message; throws with the
 *  origin in the message on unknown protocol, any unknown or
 *  duplicated field, missing fields, or a value that fails its
 *  strict syntax — integers without junk, ISO-8601 Z timestamps,
 *  a 32-hex token, a 40-hex base SHA. A malformed or unknown lease
 *  must be retained and fail closed, never auto-taken-over
 *  (issue #390). */

/** A fresh lease body for this holder: token, TTL, base remote SHA. */
/** True when the lease's expiry has passed at `now`. */
export function leaseExpired(body: LeaseBody, now: () => Date): boolean {
  return Date.parse(body.expires) < now().getTime();
}

/** One push's ref update: set `ref` to `oid`, or delete `ref` when
 *  `delete` is set — optionally fenced by the exact expected OID. */
export interface RefUpdate {
  readonly ref: string;
  readonly oid?: string;
  readonly deleted?: boolean;
  readonly expectedOid?: string;
}

/** Assemble one push argv from ref updates: the remote first, then
 *  refspecs — `git push [<remote>] [<refspec>...]` — with an exact
 *  `--force-with-lease` per fenced ref and `--atomic` when the
 *  updates must land or refuse together (the finalize step). */
export function casPushArgs(
  remote: string,
  updates: readonly RefUpdate[],
  atomic: boolean,
): string[] {
  const head = atomic ? ["push", "--atomic"] : ["push"];
  const fences: string[] = [];
  const refspecs: string[] = [];

  for (const update of updates) {
    if (update.expectedOid !== undefined) {
      fences.push(`--force-with-lease=${update.ref}:${update.expectedOid}`);
    }

    refspecs.push(
      update.deleted === true
        ? `:${update.ref}`
        : `${update.oid ?? ""}:${update.ref}`,
    );
  }

  return [...head, ...fences, remote, ...refspecs];
}

/** Execute one CAS push; a rejection propagates with git's trimmed
 *  stderr — the caller decides what a race means. */
export async function casPush(
  git: GitRunner,
  remote: string,
  updates: readonly RefUpdate[],
  atomic = false,
): Promise<void> {
  const args = casPushArgs(remote, updates, atomic);

  try {
    await git(args);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";

    throw new Error(
      `push ${args.slice(1).join(" ")} failed — ${stderr.trim()}`,
      {
        cause: error,
      },
    );
  }
}

/** Create the synthetic lease commit and return its OID: the remote
 *  branch's tree, no parent, the protocol body as the message. */
export async function createLeaseCommit(
  git: GitRunner,
  treeOid: string,
  body: LeaseBody,
): Promise<string> {
  return await gitOut(git, [
    "commit-tree",
    treeOid,
    "-m",
    serializeLeaseBody(body),
  ]);
}

/** The live lease on the remote, observed by OID only, or undefined
 *  when the ref is absent. */
export async function observeLeaseOid(
  git: GitRunner,
  remote: string,
  leaseRef: string,
): Promise<string | undefined> {
  return await lsRemoteOid(git, remote, leaseRef);
}

/** Read the live lease's parsed body: observe the OID, fetch the
 *  exact ref (an explicit refspec — the default fetch refspecs need
 *  not carry custom refs), and parse its commit message. Returns
 *  undefined when no lease is live; a present but unparseable lease
 *  throws — fail closed (issue #390). */
export async function observeLease(
  git: GitRunner,
  remote: string,
  leaseRef: string,
): Promise<ObservedLease | undefined> {
  const oid = await observeLeaseOid(git, remote, leaseRef);

  if (oid === undefined) {
    return undefined;
  }

  const localRef = "refs/k-wiki/lease-observed";

  await git(["fetch", "--force", remote, `${leaseRef}:${localRef}`]);

  const fetched = await revParseOid(git, localRef);

  if (fetched !== oid) {
    throw new Error(
      `lease ${leaseRef} moved while being read (${oid} → ${fetched ?? "gone"}) — retry`,
    );
  }

  const message = await gitOut(git, ["log", "-1", "--format=%B", localRef]);

  return { oid, body: parseLeaseBody(message, leaseRef) };
}

export function newLeaseBody(
  base: string,
  now: () => Date,
  holder: string,
  options: { readonly token?: string } = {},
): LeaseBody {
  const stamp = now().toISOString();

  return {
    token: options.token ?? randomBytes(16).toString("hex"),
    holder,
    acquired: stamp,
    expires: new Date(now().getTime() + LEASE_TTL_MS).toISOString(),
    base,
    renewals: 0,
  };
}

/** Describe a live lease in one line — the refusal and status text
 *  that names holder and expiry (issue #390). */
export function describeLease(lease: ObservedLease): string {
  return `held by ${lease.body.holder}, expires ${lease.body.expires}`;
}
