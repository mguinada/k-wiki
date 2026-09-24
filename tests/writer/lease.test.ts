import { describe, expect, it } from "vitest";
import {
  casPushArgs,
  leaseExpired,
  newLeaseBody,
  serializeLeaseBody,
} from "../../src/writer/lease.ts";
import { parseLeaseBody } from "../../src/writer/lease-schema.ts";

const LEASE_REF = "refs/k-wiki/leases/shared-writer-v1";
const BRANCH_REF = "refs/heads/main";
const NOW = () => new Date("2026-01-01T00:00:00Z");
const HOLDER = "test-host:1";

describe("lease body", () => {
  it("round-trips the protocol fields through the message form", () => {
    const body = newLeaseBody("b".repeat(40), NOW, HOLDER);

    expect(parseLeaseBody(serializeLeaseBody(body), "lease")).toEqual(body);
  });

  it("rejects an unknown protocol version", () => {
    const body = newLeaseBody("b".repeat(40), NOW, HOLDER);
    const text = serializeLeaseBody(body).replace("protocol: 1", "protocol: 2");

    expect(() => parseLeaseBody(text, "lease")).toThrow(
      /unknown lease protocol/,
    );
  });

  it("rejects an unparseable expiry (fail closed)", () => {
    const body = newLeaseBody("b".repeat(40), NOW, HOLDER);
    const text = serializeLeaseBody(body).replace(
      `expires: ${body.expires}`,
      "expires: yesterday-ish",
    );

    expect(() => parseLeaseBody(text, "lease")).toThrow(/expires/);
  });

  it("rejects a message that is not a lease commit", () => {
    expect(() => parseLeaseBody("not a lease", "lease")).toThrow(
      /not a k-wiki shared-writer lease/,
    );
  });

  it("treats a past expiry as expired", () => {
    const stale = { ...newLeaseBody("b".repeat(40), NOW, HOLDER) };
    const body = {
      ...stale,
      expires: "2020-01-01T00:00:00Z",
    };

    expect(leaseExpired(body, NOW)).toBe(true);
  });

  it("builds atomic fenced push args for a branch advance plus lease delete", () => {
    expect(
      casPushArgs(
        "origin",
        [
          { ref: BRANCH_REF, oid: "new" },
          { ref: LEASE_REF, deleted: true, expectedOid: "own" },
        ],
        true,
      ),
    ).toEqual([
      "push",
      "--atomic",
      `--force-with-lease=${LEASE_REF}:own`,
      "origin",
      `new:${BRANCH_REF}`,
      `:${LEASE_REF}`,
    ]);
  });
});

describe("lease body strictness (issue #390 fail-closed)", () => {
  const BASE = "b".repeat(40);

  const bodyWith = (patch: Record<string, string>): string => {
    const text = serializeLeaseBody(newLeaseBody(BASE, NOW, HOLDER));
    const [subject, blank, ...lines] = text.split("\n");

    return [
      subject,
      blank,
      ...lines.map((line) => {
        const key = line.slice(0, line.indexOf(":"));

        return patch[key] !== undefined ? `${key}: ${patch[key]}` : line;
      }),
    ].join("\n");
  };

  it("rejects a duplicated field", () => {
    const body = newLeaseBody(BASE, NOW, HOLDER);
    const text = serializeLeaseBody(body) + `token: ${body.token}\n`;

    expect(() => parseLeaseBody(text, "lease")).toThrow(
      /duplicate lease field/,
    );
  });

  it("rejects an unknown field", () => {
    const text = bodyWith({}) + "ttl: 60\n";

    expect(() => parseLeaseBody(text, "lease")).toThrow(/unknown lease field/);
  });

  it("rejects a missing field", () => {
    const text = serializeLeaseBody(newLeaseBody(BASE, NOW, HOLDER))
      .split("\n")
      .filter((line) => !line.startsWith("base:"))
      .join("\n");

    expect(() => parseLeaseBody(text, "lease")).toThrow(/"base" missing/);
  });

  it("rejects junk around the renewals integer (no parseInt slack)", () => {
    expect(() =>
      parseLeaseBody(bodyWith({ renewals: "2 garbage" }), "lease"),
    ).toThrow(/"renewals" is not a plain count/);
    expect(() =>
      parseLeaseBody(bodyWith({ renewals: "0x2" }), "lease"),
    ).toThrow(/"renewals" is not a plain count/);
    expect(() => parseLeaseBody(bodyWith({ renewals: "-1" }), "lease")).toThrow(
      /"renewals" is not a plain count/,
    );
    expect(() => parseLeaseBody(bodyWith({ renewals: " 2" }), "lease")).toThrow(
      /"renewals" is not a plain count/,
    );
  });

  it("rejects non-ISO-8601-Z acquired/expires timestamps", () => {
    expect(() =>
      parseLeaseBody(bodyWith({ expires: "yesterday" }), "lease"),
    ).toThrow(/"expires" is not an ISO-8601 Z timestamp/);
    expect(() =>
      parseLeaseBody(bodyWith({ acquired: "2026-01-01 00:00:00" }), "lease"),
    ).toThrow(/"acquired" is not an ISO-8601 Z timestamp/);
    expect(() =>
      parseLeaseBody(bodyWith({ expires: "2026-13-40T99:00:00Z" }), "lease"),
    ).toThrow(/is not a real date/);
  });

  it("rejects a token that is not 32 hex characters", () => {
    expect(() => parseLeaseBody(bodyWith({ token: "xyz" }), "lease")).toThrow(
      /"token" is not a 32-hex token/,
    );
  });

  it("rejects a base that is not a 40-hex commit SHA", () => {
    expect(() => parseLeaseBody(bodyWith({ base: "abc" }), "lease")).toThrow(
      /"base" is not a 40-hex commit SHA/,
    );
  });

  it("still accepts the canonical serialized form", () => {
    const body = newLeaseBody(BASE, NOW, HOLDER);

    expect(parseLeaseBody(serializeLeaseBody(body), "l")).toEqual(body);
  });
});
