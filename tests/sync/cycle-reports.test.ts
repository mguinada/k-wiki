import { describe, expect, it } from "vitest";
import {
  cycleBackReferenceLine,
  cycleDayTitle,
  cycleLintReference,
  cycleSectionTitle,
  lintDayTitle,
  lintRunReference,
  lintSectionTitle,
  localIsoTimestamp,
  parseDayFile,
  planCycleAppend,
  planLintAppend,
  STANDALONE_MARKER,
  scannedLines,
} from "../../src/sync/cycle-reports.ts";

/** The `±HH:MM` suffix of the machine's offset at the instant — the
 *  one TZ-dependent piece, derived independently of the formatter
 *  under test. */
function offsetSuffix(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** An instant whose LOCAL wall clock reads 2026-10-12T14:54:53. */
const LOCAL_MORNING = new Date(2026, 9, 12, 14, 54, 53);

/** An instant whose LOCAL wall clock reads 2026-10-12T18:00:59. */
const LOCAL_LATER = new Date(2026, 9, 12, 18, 0, 59);

/** A UTC instant on 2026-10-12 (13:54:53Z): day titles are UTC-day
 *  keyed, so UTC instants pin them TZ-independently. */
const UTC_MORNING = new Date("2026-10-12T13:54:53.000Z");

describe("localIsoTimestamp", () => {
  it("formats the local wall clock with a local-offset suffix", () => {
    expect(localIsoTimestamp(LOCAL_MORNING)).toBe(
      `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`,
    );
  });

  it("formats a later instant's own wall clock", () => {
    expect(localIsoTimestamp(LOCAL_LATER)).toBe(
      `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`,
    );
  });
});

describe("day titles", () => {
  it("titles the cycle day file with the UTC day, stated once", () => {
    expect(cycleDayTitle(UTC_MORNING)).toBe(
      "# wiki-sync cycle digest — 2026-10-12",
    );
  });

  it("titles the windowed lint day file", () => {
    expect(lintDayTitle("window", UTC_MORNING)).toBe(
      "# Windowed lint — 2026-10-12",
    );
  });

  it("titles the full-sweep lint day file", () => {
    expect(lintDayTitle("full", UTC_MORNING)).toBe("# Full lint — 2026-10-12");
  });
});

describe("section titles", () => {
  it("carries number, date, and time with the date stated once", () => {
    expect(cycleSectionTitle(LOCAL_MORNING, 2)).toBe(
      `Cycle 2 — 2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`,
    );
  });

  it("carries the lint run's instant and window definition", () => {
    expect(lintSectionTitle(LOCAL_LATER, 3, "window audit, 34 pages")).toBe(
      `Lint run 3 — 2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)} (window audit, 34 pages)`,
    );
  });
});

describe("planCycleAppend", () => {
  it("titles the fresh-file first section Cycle 1", () => {
    const plan = planCycleAppend(undefined, LOCAL_MORNING);
    const stamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;

    expect(plan.sectionTitle).toBe(`Cycle 1 — ${stamp}`);
  });

  it("opens the fresh file with the day title and the first section", () => {
    const plan = planCycleAppend(undefined, LOCAL_MORNING);
    const stamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;

    expect(plan.prefix).toBe(
      `# wiki-sync cycle digest — 2026-10-12\n\n## Cycle 1 — ${stamp}\n\n`,
    );
  });

  it("numbers the appended section by its position", () => {
    const firstStamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;
    const secondStamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing = `# wiki-sync cycle digest — 2026-10-12\n\n## Cycle 1 — ${firstStamp}\n\n- first cycle\n`;

    const plan = planCycleAppend(existing, LOCAL_LATER);

    expect(plan.sectionTitle).toBe(`Cycle 2 — ${secondStamp}`);
  });

  it("separates the appended section from the prior ones with ---", () => {
    const firstStamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;
    const secondStamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing = `# wiki-sync cycle digest — 2026-10-12\n\n## Cycle 1 — ${firstStamp}\n\n- first cycle\n`;

    const plan = planCycleAppend(existing, LOCAL_LATER);

    expect(plan.prefix).toBe(
      `${existing.trimEnd()}\n\n---\n\n## Cycle 2 — ${secondStamp}\n\n`,
    );
  });

  it("titles the transitioned file's new section Cycle 2", () => {
    const secondStamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing =
      "# wiki-sync cycle digest\n\n- overwritten-era digest\n\n## Lint summary\n\nold audit\n";

    const plan = planCycleAppend(existing, LOCAL_LATER);

    expect(plan.sectionTitle).toBe(`Cycle 2 — ${secondStamp}`);
  });

  it("retitles a legacy-shape file and binds it as pre-append", () => {
    const secondStamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing =
      "# wiki-sync cycle digest\n\n- overwritten-era digest\n\n## Lint summary\n\nold audit\n";

    const plan = planCycleAppend(existing, LOCAL_LATER);

    expect(plan.prefix).toBe(
      "# wiki-sync cycle digest — 2026-10-12\n\n" +
        "## Cycle 1 (pre-append)\n\n" +
        "- overwritten-era digest\n\n## Lint summary\n\nold audit\n\n" +
        `---\n\n## Cycle 2 — ${secondStamp}\n\n`,
    );
  });

  it("keeps legacy content without an H1 verbatim in the bound", () => {
    const existing = "- orphan-era digest with no title\n";

    const plan = planCycleAppend(existing, LOCAL_LATER);

    expect(plan.prefix).toContain(
      "## Cycle 1 (pre-append)\n\n- orphan-era digest with no title\n\n---\n\n",
    );
  });
});

describe("planLintAppend", () => {
  it("titles the fresh-file first run section Lint run 1", () => {
    const plan = planLintAppend(
      undefined,
      LOCAL_MORNING,
      "window",
      "window audit, 34 pages",
    );
    const stamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;

    expect(plan.sectionTitle).toBe(
      `Lint run 1 — ${stamp} (window audit, 34 pages)`,
    );
  });

  it("opens the fresh windowed file with its day title and section", () => {
    const plan = planLintAppend(
      undefined,
      LOCAL_MORNING,
      "window",
      "window audit, 34 pages",
    );
    const stamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;

    expect(plan.prefix).toBe(
      `# Windowed lint — 2026-10-12\n\n## Lint run 1 — ${stamp} (window audit, 34 pages)\n\n`,
    );
  });

  it("plans the full-sweep family with its own day title", () => {
    const plan = planLintAppend(undefined, LOCAL_MORNING, "full", "full audit");
    const stamp = `2026-10-12T14:54:53${offsetSuffix(LOCAL_MORNING)}`;

    expect(plan.prefix).toBe(
      `# Full lint — 2026-10-12\n\n## Lint run 1 — ${stamp} (full audit)\n\n`,
    );
  });

  it("transitions a legacy lint file with the pre-append bound", () => {
    const secondStamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing =
      "# Some overwrite-era lint report\n\n### Repairs\n\nnone\n";

    const plan = planLintAppend(
      existing,
      LOCAL_LATER,
      "window",
      "window audit, 2 pages",
    );

    expect(plan.prefix).toBe(
      "# Windowed lint — 2026-10-12\n\n" +
        "## Lint run 1 (pre-append)\n\n" +
        "### Repairs\n\nnone\n\n" +
        "---\n\n" +
        `## Lint run 2 — ${secondStamp} (window audit, 2 pages)\n\n`,
    );
  });

  it("numbers the next run past a quoted heading inside a fence", () => {
    const stamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing = [
      lintDayTitle("window", LOCAL_LATER),
      "",
      `## Lint run 1 — ${stamp} (window audit, 34 pages)`,
      "",
      "```",
      `## Lint run 2 — ${stamp} (window audit, 34 pages)`,
      "```",
      "",
    ].join("\n");
    const plan = planLintAppend(
      existing,
      LOCAL_LATER,
      "window",
      "window audit, 34 pages",
    );

    expect(plan.sectionTitle).toBe(
      `Lint run 2 — ${stamp} (window audit, 34 pages)`,
    );
  });

  it("seals a fence the existing content leaves open", () => {
    const stamp = `2026-10-12T18:00:59${offsetSuffix(LOCAL_LATER)}`;
    const existing = [
      lintDayTitle("window", LOCAL_LATER),
      "",
      `## Lint run 1 — ${stamp} (window audit, 34 pages)`,
      "",
      "```bash",
      "# unterminated",
    ].join("\n");
    const plan = planLintAppend(
      existing,
      LOCAL_LATER,
      "window",
      "window audit, 2 pages",
    );

    expect(plan.prefix).toBe(
      `${existing}\n\`\`\`\n\n---\n\n## Lint run 2 — ${stamp} (window audit, 2 pages)\n\n`,
    );
  });
});

describe("parseDayFile", () => {
  const TITLE = "# wiki-sync cycle digest — 2026-10-12";

  const appended = [
    TITLE,
    "",
    "## Cycle 1 — 2026-10-12T14:54:53+01:00",
    "",
    "- first",
    "",
    "---",
    "",
    "## Cycle 2 — 2026-10-12T18:00:59+01:00",
    "",
    "- second",
    "",
  ].join("\n");

  it("parses the sections of an append-shape file in order", () => {
    const parsed = parseDayFile(appended, "cycle", TITLE);

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections.map((section) => section.title)).toEqual([
      "Cycle 1 — 2026-10-12T14:54:53+01:00",
      "Cycle 2 — 2026-10-12T18:00:59+01:00",
    ]);
  });

  it("keeps a --- line inside a section body from splitting it", () => {
    const withRule = appended.replace(
      "- first",
      "- first\n\n---\n\nmid-content rule",
    );
    const parsed = parseDayFile(withRule, "cycle", TITLE);

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections).toHaveLength(2);
  });

  it("keeps a heading quoted inside a fence from splitting a section", () => {
    const quoted = [
      "# Windowed lint — 2026-10-12",
      "",
      "## Lint run 1 — 2026-10-12T14:54:52+01:00 (window audit, 34 pages)",
      "",
      "```",
      "## Lint run 2 — 2026-10-12T18:00:58+01:00 (window audit, 2 pages)",
      "```",
      "",
    ].join("\n");
    const parsed = parseDayFile(quoted, "lint", "# Windowed lint — 2026-10-12");

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections).toHaveLength(1);
  });

  it("parses the sections of a file whose open fence got sealed", () => {
    const sealed = [
      "# Windowed lint — 2026-10-12",
      "",
      "## Lint run 1 — 2026-10-12T14:54:52+01:00 (window audit, 34 pages)",
      "",
      "```bash",
      "# unterminated",
      "```",
      "",
      "---",
      "",
      "## Lint run 2 — 2026-10-12T18:00:58+01:00 (window audit, 2 pages)",
      "",
      "body",
      "",
    ].join("\n");
    const parsed = parseDayFile(sealed, "lint", "# Windowed lint — 2026-10-12");

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections).toHaveLength(2);
  });

  it("keeps the mid-content rule inside the first section's body", () => {
    const withRule = appended.replace(
      "- first",
      "- first\n\n---\n\nmid-content rule",
    );
    const parsed = parseDayFile(withRule, "cycle", TITLE);

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections[0]?.body).toContain("mid-content rule");
  });

  it("marks a synthesized pre-append bound", () => {
    const transitioned = [
      TITLE,
      "",
      "## Cycle 1 (pre-append)",
      "",
      "- legacy digest",
      "",
      "---",
      "",
      "## Cycle 2 — 2026-10-12T18:00:59+01:00",
      "",
      "- new",
      "",
    ].join("\n");

    const parsed = parseDayFile(transitioned, "cycle", TITLE);

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections[0]?.preAppend).toBe(true);
  });

  it("keeps the appended section non-pre-append", () => {
    const transitioned = [
      TITLE,
      "",
      "## Cycle 1 (pre-append)",
      "",
      "- legacy digest",
      "",
      "---",
      "",
      "## Cycle 2 — 2026-10-12T18:00:59+01:00",
      "",
      "- new",
      "",
    ].join("\n");

    const parsed = parseDayFile(transitioned, "cycle", TITLE);

    if (parsed.kind !== "append") {
      throw new Error("expected an append-shape parse");
    }

    expect(parsed.file.sections[1]?.preAppend).toBe(false);
  });

  it("reports a wrong-title file as legacy", () => {
    expect(
      parseDayFile("# wiki-sync cycle digest\n\n- old\n", "cycle", TITLE),
    ).toEqual({ kind: "legacy" });
  });

  it("reports a file with no family sections as legacy", () => {
    expect(parseDayFile(`${TITLE}\n\n- unsectioned\n`, "cycle", TITLE)).toEqual(
      { kind: "legacy" },
    );
  });
});

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

describe("scannedLines", () => {
  it("carries heading depth 0 for lines inside a backtick fence", () => {
    expect(
      scannedLines("```bash\n# rebuild the index\n```\n").map(
        (scanned) => scanned.hashes,
      ),
    ).toEqual([0, 0, 0, 0]);
  });

  it("carries heading depth 0 for lines inside a tilde fence", () => {
    expect(
      scannedLines("~~~\n## example\n~~~\n").map((scanned) => scanned.hashes),
    ).toEqual([0, 0, 0, 0]);
  });

  it("carries a non-fenced heading's depth", () => {
    const scanned = scannedLines("## Cycle 1 — x\n\nbody\n");

    expect(scanned.map(({ hashes }) => hashes)).toEqual([2, 0, 0, 0]);
  });

  it("stays fenced across a nested different-character marker line", () => {
    expect(
      scannedLines("~~~\n```bash\n## Heading\n```\n~~~\n# After\n").map(
        (scanned) => scanned.hashes,
      ),
    ).toEqual([0, 0, 0, 0, 0, 1, 0]);
  });

  it("stays fenced across a shorter marker and closes on a matching one", () => {
    expect(
      scannedLines("````\ntext\n```\ntext\n````\n## Heading\n").map(
        (scanned) => scanned.hashes,
      ),
    ).toEqual([0, 0, 0, 0, 0, 2, 0]);
  });

  it("carries an indented heading's depth and indent", () => {
    const scanned = scannedLines(" ## Findings\n");

    expect(scanned.map(({ hashes, indent }) => ({ hashes, indent }))).toEqual([
      { hashes: 2, indent: 1 },
      { hashes: 0, indent: 0 },
    ]);
  });

  it("treats a backtick marker with a backtick info string as prose", () => {
    expect(
      scannedLines("``` `\n## Findings\n").map((scanned) => scanned.hashes),
    ).toEqual([0, 2, 0]);
  });
});
