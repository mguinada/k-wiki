import { describe, expect, it } from "vitest";
import { scannedLines } from "../../src/sync/fence-state.ts";

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
