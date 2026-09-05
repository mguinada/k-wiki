import { describe, expect, it } from "vitest";
import { lastChangeLine } from "../../src/cli/last-change.ts";

/** The fixed "now" every fact-line test reads against — calendar
 *  construction, so the local-time stamp is deterministic. */
const STATUS_NOW = new Date(2026, 8, 4, 12, 0);

describe("lastChangeLine (issue #310)", () => {
  it("formats the last commit time with a relative age", () => {
    expect(lastChangeLine(new Date(2026, 8, 4, 10, 0), STATUS_NOW)).toBe(
      "last change: 2026-09-04 10:00 (2 hours ago)",
    );
  });

  it("states never for a never-committed data repo", () => {
    expect(lastChangeLine(undefined, STATUS_NOW)).toBe(
      "last change: never (fresh data repo)",
    );
  });

  it("renders a sub-minute age as just now", () => {
    expect(lastChangeLine(new Date(2026, 8, 4, 11, 59, 30), STATUS_NOW)).toBe(
      "last change: 2026-09-04 11:59 (just now)",
    );
  });

  it("renders a one-minute age in the singular", () => {
    expect(lastChangeLine(new Date(2026, 8, 4, 11, 59), STATUS_NOW)).toBe(
      "last change: 2026-09-04 11:59 (1 minute ago)",
    );
  });

  it("pluralizes whole minutes only (floor, not ceil)", () => {
    expect(lastChangeLine(new Date(2026, 8, 4, 11, 57, 30), STATUS_NOW)).toBe(
      "last change: 2026-09-04 11:57 (2 minutes ago)",
    );
  });

  it("renders whole days ago", () => {
    expect(lastChangeLine(new Date(2026, 8, 2, 12, 0), STATUS_NOW)).toBe(
      "last change: 2026-09-02 12:00 (2 days ago)",
    );
  });

  it("renders a 30-day age as one month ago", () => {
    expect(lastChangeLine(new Date(2026, 7, 5, 12, 0), STATUS_NOW)).toBe(
      "last change: 2026-08-05 12:00 (1 month ago)",
    );
  });

  it("renders a 365-day age as one year ago", () => {
    expect(lastChangeLine(new Date(2025, 8, 4, 12, 0), STATUS_NOW)).toBe(
      "last change: 2025-09-04 12:00 (1 year ago)",
    );
  });

  it("renders a future commit clock-skew as just now", () => {
    expect(lastChangeLine(new Date(2026, 8, 4, 12, 0, 30), STATUS_NOW)).toBe(
      "last change: 2026-09-04 12:00 (just now)",
    );
  });
});
