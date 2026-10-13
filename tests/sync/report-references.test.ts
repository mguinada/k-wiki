import { describe, expect, it } from "vitest";
import { cycleBackReferenceLine } from "../../src/sync/cycle-reports.ts";
import {
  cycleLintReference,
  lintRunReference,
  STANDALONE_MARKER,
} from "../../src/sync/report-references.ts";

describe("lintRunReference", () => {
  it("recognizes the standalone marker", () => {
    expect(lintRunReference(`\n${STANDALONE_MARKER}\n\nbody\n`)).toEqual({
      kind: "standalone",
    });
  });

  it("extracts the cycle back-reference's path and section title", () => {
    expect(
      lintRunReference(
        `\n${cycleBackReferenceLine("outputs/cycle-2026-10-12.md", "Cycle 2 — 2026-10-12T18:00:59+01:00")}\n`,
      ),
    ).toEqual({
      kind: "cycle",
      path: "outputs/cycle-2026-10-12.md",
      sectionTitle: "Cycle 2 — 2026-10-12T18:00:59+01:00",
    });
  });

  it("reports neither marker nor reference", () => {
    expect(lintRunReference("\nno contract line here\n")).toEqual({
      kind: "none",
    });
  });

  it("ignores a back-reference line quoted inside a fence", () => {
    const quoted = cycleBackReferenceLine(
      "outputs/cycle-2026-10-12.md",
      "Cycle 2 — 2026-10-12T18:00:59+01:00",
    );

    expect(lintRunReference(`\`\`\`\n${quoted}\n\`\`\`\n`)).toEqual({
      kind: "none",
    });
  });

  it("ignores the standalone marker quoted inside a fence", () => {
    expect(lintRunReference(`\`\`\`\n${STANDALONE_MARKER}\n\`\`\`\n`)).toEqual({
      kind: "none",
    });
  });
});

describe("cycleLintReference", () => {
  it("extracts the lint bullet's report path and section title", () => {
    expect(
      cycleLintReference(
        '- **Lint:** window audit (34 pages: changed this cycle plus reverse neighbors) — report `outputs/lint-2026-10-12.md` — section "Lint run 1 — 2026-10-12T14:54:53+01:00 (window audit, 34 pages)" — summary below',
      ),
    ).toEqual({
      path: "outputs/lint-2026-10-12.md",
      sectionTitle:
        "Lint run 1 — 2026-10-12T14:54:53+01:00 (window audit, 34 pages)",
    });
  });

  it("returns undefined without a lint-run reference", () => {
    expect(
      cycleLintReference("- **Lint:** window empty (this cycle)"),
    ).toBeUndefined();
  });

  it("ignores a lint bullet quoted inside a fence", () => {
    const quoted =
      '- **Lint:** full audit — report `outputs/lint-2026-10-12.md` — section "Lint run 1 — 2026-10-12T14:54:52+01:00 (full audit)" — summary below';

    expect(cycleLintReference(`\`\`\`\n${quoted}\n\`\`\`\n`)).toBeUndefined();
  });
});
