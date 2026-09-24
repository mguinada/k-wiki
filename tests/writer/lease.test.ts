import { describe, expect, it } from "vitest";
import {
  casPushArgs,
  leaseExpired,
  newLeaseBody,
  parseLeaseBody,
  serializeLeaseBody,
} from "../../src/writer/lease.ts";

const LEASE_REF = "refs/k-wiki/leases/shared-writer-v1";
const BRANCH_REF = "refs/heads/main";
const NOW = () => new Date("2026-01-01T00:00:00Z");
const HOLDER = "test-host:1";

describe("lease body", () => {
  it("round-trips the protocol fields through the message form", () => {
    const body = newLeaseBody("abc", NOW, HOLDER);

    expect(parseLeaseBody(serializeLeaseBody(body), "lease")).toEqual(body);
  });

  it("rejects an unknown protocol version", () => {
    const body = newLeaseBody("abc", NOW, HOLDER);
    const text = serializeLeaseBody(body).replace("protocol: 1", "protocol: 2");

    expect(() => parseLeaseBody(text, "lease")).toThrow(
      /unknown lease protocol/,
    );
  });

  it("rejects an unparseable expiry (fail closed)", () => {
    const body = newLeaseBody("abc", NOW, HOLDER);
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
    const stale = { ...newLeaseBody("abc", NOW, HOLDER) };
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
