import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  mutantIdentity,
  readSourceFrom,
  spanText,
} from "../../src/quality/mutation-identity.ts";
import type { Mutant } from "../../src/quality/mutation-survivors.ts";

// The mutant identity (issue #241): a sha over the mutated span's
// exact code text, the mutator name, and the file's repo-relative
// path — never file:line, which rots under refactors. Locations in
// the fixtures use the coordinates Stryker's JSON report carries:
// 1-based lines and columns, end exclusive (verified against a live
// report — see spanText).

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** `  return a + b;` — the canonical mutated line. */
const ADD_SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
].join("\n");

/** The `a + b` span of ADD_SOURCE: 1-based line 2, columns 10..15. */
const addMutant = (mutator = "ArithmeticOperator"): Mutant => ({
  mutatorName: mutator,
  status: "Survived",
  replacement: "a - b",
  location: {
    start: { line: 2, column: 10 },
    end: { line: 2, column: 15 },
  },
});

const at = (line: number): Mutant => ({
  ...addMutant(),
  location: { start: { line, column: 10 }, end: { line, column: 15 } },
});

const reader = (sources: Record<string, string>) => (file: string) =>
  sources[file];

const sources = () => reader({ "src/math.ts": ADD_SOURCE });

describe("spanText", () => {
  it("extracts a mid-line span column-precisely", () => {
    expect(spanText(ADD_SOURCE, addMutant())).toBe("a + b");
  });

  it("extracts a multi-line span with column offsets on both ends", () => {
    const source = ["call(arg,", "  other);"].join("\n");

    expect(
      spanText(source, {
        ...addMutant(),
        location: {
          start: { line: 1, column: 6 },
          end: { line: 2, column: 9 },
        },
      }),
    ).toBe("arg,\n  other)");
  });

  it("yields undefined for a span past the end of the source", () => {
    expect(
      spanText(ADD_SOURCE, {
        ...addMutant(),
        location: {
          start: { line: 9, column: 1 },
          end: { line: 9, column: 4 },
        },
      }),
    ).toBeUndefined();
  });

  it("yields undefined for a mutant without an end location", () => {
    expect(
      spanText(ADD_SOURCE, {
        ...addMutant(),
        location: { start: { line: 2, column: 10 } },
      }),
    ).toBeUndefined();
  });

  it("yields undefined for a mutant without columns", () => {
    expect(
      spanText(ADD_SOURCE, {
        ...addMutant(),
        location: { start: { line: 2 }, end: { line: 2 } },
      }),
    ).toBeUndefined();
  });
});

describe("mutantIdentity", () => {
  it("keys the same code span identically after its lines moved", () => {
    const moved = ["// moved", "// by", "// three", ADD_SOURCE].join("\n");

    expect(
      mutantIdentity("src/math.ts", at(5), reader({ "src/math.ts": moved })),
    ).toBe(mutantIdentity("src/math.ts", addMutant(), sources()));
  });

  it("re-keys the span when the mutated code changes", () => {
    const edited = ADD_SOURCE.replace("a + b", "a - b");

    expect(
      mutantIdentity("src/math.ts", at(2), reader({ "src/math.ts": edited })),
    ).not.toBe(mutantIdentity("src/math.ts", addMutant(), sources()));
  });

  it("re-keys the span when only its formatting churns", () => {
    const churned = ADD_SOURCE.replace("a + b", "a  +  b");

    expect(
      mutantIdentity(
        "src/math.ts",
        {
          ...addMutant(),
          location: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 17 },
          },
        },
        reader({ "src/math.ts": churned }),
      ),
    ).not.toBe(mutantIdentity("src/math.ts", addMutant(), sources()));
  });

  it("keys identical spans in different files differently", () => {
    const both = reader({ "src/a.ts": ADD_SOURCE, "src/b.ts": ADD_SOURCE });

    expect(mutantIdentity("src/a.ts", addMutant(), both)).not.toBe(
      mutantIdentity("src/b.ts", addMutant(), both),
    );
  });

  it("keys the same span under a different mutator differently", () => {
    const own = reader({ "src/a.ts": ADD_SOURCE });

    expect(
      mutantIdentity("src/a.ts", addMutant("MethodExpression"), own),
    ).not.toBe(mutantIdentity("src/a.ts", addMutant(), own));
  });

  it("keys the same span in a renamed file differently", () => {
    const both = reader({
      "src/math.ts": ADD_SOURCE,
      "src/renamed.ts": ADD_SOURCE,
    });

    expect(mutantIdentity("src/renamed.ts", addMutant(), both)).not.toBe(
      mutantIdentity("src/math.ts", addMutant(), both),
    );
  });

  it("keys duplicate identical spans within one file by their occurrence", () => {
    const source = [
      "const first: string[] = [];",
      "const second: string[] = [];",
    ].join("\n");
    const reader = () => source;
    const at = (line: number, column: number): Mutant => ({
      ...addMutant("ArrayDeclaration"),
      replacement: '["Stryker was here"]',
      location: {
        start: { line, column },
        end: { line, column: column + 2 },
      },
    });

    const first = mutantIdentity("src/math.ts", at(1, 25), reader);
    const second = mutantIdentity("src/math.ts", at(2, 26), reader);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keys the same occurrence identically after its lines moved", () => {
    const source = [
      "const first: string[] = [];",
      "const second: string[] = [];",
    ].join("\n");
    const moved = ["// header", source].join("\n");
    const at = (line: number, column: number): Mutant => ({
      ...addMutant("ArrayDeclaration"),
      replacement: '["Stryker was here"]',
      location: {
        start: { line, column },
        end: { line, column: column + 2 },
      },
    });

    expect(mutantIdentity("src/math.ts", at(2, 26), () => source)).toBe(
      mutantIdentity("src/math.ts", at(3, 26), () => moved),
    );
  });

  it("keys sibling mutants of one mutator on one span by their replacement", () => {
    const toLte = addMutant();
    const toGte = { ...addMutant(), replacement: "a >= b" };

    expect(mutantIdentity("src/math.ts", toLte, sources())).not.toBe(
      mutantIdentity("src/math.ts", toGte, sources()),
    );
  });

  it("yields undefined for a mutant without a replacement", () => {
    const { replacement: _unused, ...withoutReplacement } = addMutant();

    expect(
      mutantIdentity("src/math.ts", withoutReplacement, sources()),
    ).toBeUndefined();
  });

  it("yields undefined when the source file is unreadable", () => {
    expect(
      mutantIdentity("src/gone.ts", addMutant(), () => undefined),
    ).toBeUndefined();
  });

  it("yields undefined for an empty span", () => {
    expect(
      mutantIdentity(
        "src/math.ts",
        {
          ...addMutant(),
          location: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 10 },
          },
        },
        sources(),
      ),
    ).toBeUndefined();
  });

  it("yields 16 lowercase hex characters", () => {
    expect(mutantIdentity("src/math.ts", addMutant(), sources())).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it("keys a live-report mutant by its exact expression text", () => {
    // The same convention Stryker writes: `a.path < b.path` on
    // 1-based line 59 of mutation-chunk.ts, columns 35..50, mutated
    // to `a.path <= b.path` — the survived sibling; `>=` is another
    // mutant with another identity.
    const real = {
      ...addMutant(),
      mutatorName: "EqualityOperator",
      replacement: "a.path <= b.path",
      location: {
        start: { line: 59, column: 35 },
        end: { line: 59, column: 50 },
      },
    } as const;
    const chunk = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/quality/mutation-chunk.ts",
      ),
      "utf8",
    );
    const text = spanText(chunk, real);

    expect(text).toBe("a.path < b.path");
    expect(
      mutantIdentity("src/quality/mutation-chunk.ts", real, () => chunk),
    ).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("readSourceFrom", () => {
  it("reads report-relative files under the base directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutid-"));

    tempDirs.push(dir);

    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "math.ts"), ADD_SOURCE);

    expect(readSourceFrom(dir)("src/math.ts")).toBe(ADD_SOURCE);
  });

  it("yields undefined for a file missing under the base directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutid-"));

    tempDirs.push(dir);

    expect(readSourceFrom(dir)("src/gone.ts")).toBeUndefined();
  });
});
