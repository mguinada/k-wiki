/**
 * The lease body's v1 schema grammar (issue #390): the exact field
 * set, strict value syntaxes, and the strict parser's fail-closed
 * rejections. The lifecycle behaviors around this grammar live in
 * lease.test.ts and lease-ops.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  ISO_Z_TIMESTAMP,
  LEASE_FIELDS,
  LEASE_SUBJECT,
  parseLeaseBody,
  parseLeaseFields,
} from "../../src/writer/lease-schema.ts";
import { newLeaseBody, serializeLeaseBody } from "../../src/writer/lease.ts";

const NOW = () => new Date("2026-01-01T00:00:00Z");
const HOLDER = "schema-host:3";

describe("lease schema", () => {
  it("declares exactly the v1 field set in schema order", () => {
    expect(LEASE_FIELDS).toEqual([
      "protocol",
      "token",
      "holder",
      "acquired",
      "expires",
      "base",
      "renewals",
    ]);
  });

  it("builds the subject from the protocol version", () => {
    expect(LEASE_SUBJECT).toBe("k-wiki shared-writer lease v1");
  });

  it("matches real UTC timestamps and rejects look-alikes", () => {
    expect(ISO_Z_TIMESTAMP.test("2026-01-01T00:00:00Z")).toBe(true);
    expect(ISO_Z_TIMESTAMP.test("2026-01-01T00:00:00.123Z")).toBe(true);
    expect(ISO_Z_TIMESTAMP.test("2026-01-01 00:00:00Z")).toBe(false);
    expect(ISO_Z_TIMESTAMP.test("2026-01-01T00:00:00")).toBe(false);
  });

  it("parseLeaseFields rejects a duplicate field", () => {
    const body = serializeLeaseBody(newLeaseBody("b".repeat(40), NOW, HOLDER));
    const text = `${body}token: ${"a".repeat(32)}\n`;

    expect(() =>
      parseLeaseFields(text.trimEnd().split("\n").slice(1), "lease"),
    ).toThrow(/duplicate lease field/);
  });

  it("parseLeaseFields rejects an unknown field", () => {
    const body = serializeLeaseBody(newLeaseBody("b".repeat(40), NOW, HOLDER));
    const text = `${body}ttl: 60\n`;

    expect(() =>
      parseLeaseFields(text.trimEnd().split("\n").slice(1), "lease"),
    ).toThrow(/unknown lease field/);
  });

  it("parseLeaseFields rejects a missing field", () => {
    const body = serializeLeaseBody(newLeaseBody("b".repeat(40), NOW, HOLDER));
    const lines = body
      .trimEnd()
      .split("\n")
      .slice(1)
      .filter((line) => !line.startsWith("base:"));

    expect(() => parseLeaseFields(lines, "lease")).toThrow(/"base" missing/);
  });

  it("parseLeaseBody refuses a message whose subject is not a lease", () => {
    expect(() =>
      parseLeaseBody("just a commit\n\nprotocol: 1\n", "lease"),
    ).toThrow(/not a k-wiki shared-writer lease commit/);
  });
});
