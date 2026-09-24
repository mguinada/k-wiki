/**
 * The lease body's v1 schema (issue #390): the exact field set, the
 * strict value syntaxes, and the field-map parser every lease message
 * goes through. Split from lease.ts so the protocol lifecycle and the
 * schema grammar each stay readable; malformed, duplicated, unknown,
 * or wrongly-shaped fields all fail closed here.
 */

import type { LeaseBody } from "./lease.ts";

/** The only lease protocol this build speaks; anything else fails
 *  closed (issue #390 — never take over an unknown protocol). */
export const LEASE_PROTOCOL_VERSION = 1;

/** The commit-message subject every lease carries. */
export const LEASE_SUBJECT = `k-wiki shared-writer lease v${LEASE_PROTOCOL_VERSION}`;

/** One `field: value` body line; undefined when malformed. */
function parseField(line: string): [string, string] | undefined {
  const cut = line.indexOf(": ");

  return cut === -1 ? undefined : [line.slice(0, cut), line.slice(cut + 2)];
}

/** The exact v1 field set, in schema order. */
export const LEASE_FIELDS: readonly string[] = [
  "protocol",
  "token",
  "holder",
  "acquired",
  "expires",
  "base",
  "renewals",
];

/** Strict ISO-8601 UTC: `YYYY-MM-DDTHH:MM:SS(.mmm)Z` (Date.parse in
 *  the expiry comparison then rejects impossible dates). */
export const ISO_Z_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export type LeaseFieldsMap = Map<string, string>;

/** Parse the body lines into exactly one entry per known field.
 *  Malformed lines, duplicates, unknown fields, and missing fields
 *  all throw — a lease body is exactly the v1 schema, nothing else. */
export function parseLeaseFields(
  lines: readonly string[],
  origin: string,
): LeaseFieldsMap {
  const fields = new Map<string, string>();

  for (const line of lines) {
    if (line === "") {
      continue;
    }

    const field = parseField(line);

    if (field === undefined) {
      throw new Error(
        `${origin}: malformed lease line ${JSON.stringify(line)}`,
      );
    }

    if (fields.has(field[0])) {
      throw new Error(
        `${origin}: duplicate lease field ${JSON.stringify(field[0])}`,
      );
    }

    if (!LEASE_FIELDS.includes(field[0])) {
      throw new Error(
        `${origin}: unknown lease field ${JSON.stringify(field[0])}`,
      );
    }

    fields.set(field[0], field[1]);
  }

  for (const known of LEASE_FIELDS) {
    if (!fields.has(known)) {
      throw new Error(`${origin}: lease field "${known}" missing`);
    }
  }

  return fields;
}

/** The field's value when it matches the strict pattern. */
export function requireLeasePattern(
  fields: ReadonlyMap<string, string>,
  name: string,
  pattern: RegExp,
  expected: string,
  origin: string,
): string {
  const value = fields.get(name) ?? "";

  if (!pattern.test(value)) {
    throw new Error(`${origin}: lease "${name}" is not ${expected}`);
  }

  return value;
}

export function parseLeaseBody(message: string, origin: string): LeaseBody {
  const lines = message.trimEnd().split("\n");

  if (lines[0] !== LEASE_SUBJECT) {
    throw new Error(`${origin}: not a k-wiki shared-writer lease commit`);
  }

  const fields = parseLeaseFields(lines.slice(1), origin);

  if (fields.get("protocol") !== String(LEASE_PROTOCOL_VERSION)) {
    throw new Error(
      `${origin}: unknown lease protocol ${JSON.stringify(fields.get("protocol"))}`,
    );
  }

  const token = requireLeasePattern(
    fields,
    "token",
    /^[0-9a-f]{32}$/,
    "a 32-hex token",
    origin,
  );
  const base = requireLeasePattern(
    fields,
    "base",
    /^[0-9a-f]{40}$/,
    "a 40-hex commit SHA",
    origin,
  );
  const acquired = requireLeasePattern(
    fields,
    "acquired",
    ISO_Z_TIMESTAMP,
    "an ISO-8601 Z timestamp",
    origin,
  );
  const expires = requireLeasePattern(
    fields,
    "expires",
    ISO_Z_TIMESTAMP,
    "an ISO-8601 Z timestamp",
    origin,
  );
  // Shape alone admits impossible dates (month 13); Date.parse
  // rejects them — the fail-closed direction for a malformed lease.
  for (const stamp of [acquired, expires]) {
    if (Number.isNaN(Date.parse(stamp))) {
      throw new Error(
        `${origin}: lease timestamp ${JSON.stringify(stamp)} is not a real date`,
      );
    }
  }

  const renewalsText = requireLeasePattern(
    fields,
    "renewals",
    /^(0|[1-9][0-9]*)$/,
    "a plain count",
    origin,
  );

  return {
    token,
    holder: fields.get("holder") ?? "",
    acquired,
    expires,
    base,
    renewals: Number.parseInt(renewalsText, 10),
  };
}
