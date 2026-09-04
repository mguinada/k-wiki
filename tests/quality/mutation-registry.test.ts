import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseRegistry,
  pruneCandidates,
  REGISTRY_FILENAME,
  type Registry,
  type RegistryEntry,
  splitByRegistry,
} from "../../src/quality/mutation-registry.ts";

// The committed equivalent-mutant registry (issue #241): the
// machine-readable memory of settled adjudications. Every entry
// carries its receipt — bucket, one-line justification, PR link,
// date — and the schema test below fails the suite for any
// receipt-less entry, including in the committed file itself.

const entry = (bucket: "equivalent" | "artifact"): RegistryEntry => ({
  bucket,
  justification: "Comparator ties are impossible (distinct paths).",
  pr: "https://github.com/mguinada/k-wiki/pull/237",
  date: "2026-08-31",
});

const registryText = (entries: Record<string, unknown>): string =>
  JSON.stringify({ schema: 1, entries });

const registryOf = (ids: readonly string[]): Registry =>
  parseRegistry(
    registryText(
      Object.fromEntries(ids.map((id) => [id, entry("equivalent")])),
    ),
  );

const actionable = (id?: string) => ({
  file: "src/quality/mutation-chunk.ts",
  line: 59,
  mutator: "EqualityOperator",
  status: "Survived",
  ...(id === undefined ? {} : { id }),
});

describe("parseRegistry", () => {
  it("parses a valid registry into its id-keyed entries", () => {
    const registry = parseRegistry(
      registryText({ "0123456789abcdef": entry("artifact") }),
    );

    expect(registry.entries.get("0123456789abcdef")?.bucket).toBe("artifact");
  });

  it("yields an empty registry for absent file text", () => {
    expect(parseRegistry(undefined).entries.size).toBe(0);
  });

  it("rejects text that is not valid JSON", () => {
    expect(() => parseRegistry("{not json")).toThrow(/corrupt/);
  });

  it("rejects a root without an entries object", () => {
    expect(() => parseRegistry('{"schema": 1}')).toThrow(/unexpected shape/);
  });

  it("rejects an unknown schema version", () => {
    expect(() => parseRegistry('{"schema": 2, "entries": {}}')).toThrow(
      /unexpected shape/,
    );
  });

  it("rejects an id key that is not 16 lowercase hex characters", () => {
    expect(() =>
      parseRegistry(registryText({ "src/a.ts:7|Mut": entry("equivalent") })),
    ).toThrow(/src\/a\.ts:7\|Mut/);
  });

  it("rejects an entry with a bucket outside the two legal ones", () => {
    expect(() =>
      parseRegistry(
        registryText({
          "0123456789abcdef": { ...entry("equivalent"), bucket: "parked" },
        }),
      ),
    ).toThrow(/bucket/);
  });

  it("rejects an entry without a justification receipt", () => {
    expect(() =>
      parseRegistry(
        registryText({
          "0123456789abcdef": { ...entry("equivalent"), justification: "" },
        }),
      ),
    ).toThrow(/justification/);
  });

  it("rejects a multi-line justification", () => {
    expect(() =>
      parseRegistry(
        registryText({
          "0123456789abcdef": {
            ...entry("equivalent"),
            justification: "line one\nline two",
          },
        }),
      ),
    ).toThrow(/justification/);
  });

  it("rejects a pr link that is not an https URL", () => {
    expect(() =>
      parseRegistry(
        registryText({
          "0123456789abcdef": { ...entry("equivalent"), pr: "237" },
        }),
      ),
    ).toThrow(/PR/i);
  });

  it("rejects a date outside YYYY-MM-DD", () => {
    expect(() =>
      parseRegistry(
        registryText({
          "0123456789abcdef": { ...entry("equivalent"), date: "2026-8-31" },
        }),
      ),
    ).toThrow(/date/);
  });
});

describe("splitByRegistry", () => {
  it("moves a registry-recorded equivalent out of the untriaged list", () => {
    const registry = registryOf(["a".repeat(16)]);
    const split = splitByRegistry(
      [actionable("a".repeat(16)), actionable("b".repeat(16))],
      registry,
    );

    expect(split.untriaged.map((e) => e.id)).toEqual(["b".repeat(16)]);
    expect(split.equivalents.map((r) => r.entry.id)).toEqual(["a".repeat(16)]);
  });

  it("routes a recorded artifact to its own bucket, never the equivalent one", () => {
    const id = "c".repeat(16);
    const registry = parseRegistry(registryText({ [id]: entry("artifact") }));

    const split = splitByRegistry([actionable(id)], registry);

    expect(split.equivalents).toEqual([]);
    expect(split.artifacts.map((r) => r.entry.id)).toEqual([id]);
  });

  it("keeps an entry without an identity untriaged — legacy entries never match", () => {
    const registry = registryOf(["a".repeat(16)]);

    expect(splitByRegistry([actionable()], registry).untriaged).toHaveLength(1);
  });

  it("keeps an entry whose identity the registry does not record", () => {
    const split = splitByRegistry(
      [actionable("b".repeat(16))],
      registryOf(["a".repeat(16)]),
    );

    expect(split.untriaged).toHaveLength(1);
    expect(split.equivalents).toEqual([]);
  });
});

describe("pruneCandidates", () => {
  it("lists a registry entry no generated mutant carries", () => {
    const registry = registryOf(["a".repeat(16), "b".repeat(16)]);
    const candidates = pruneCandidates(registry, new Set(["b".repeat(16)]));

    expect(candidates.map((c) => c.id)).toEqual(["a".repeat(16)]);
    expect(candidates[0]?.record.pr).toContain("/pull/237");
  });

  it("lists nothing when every registry entry was generated", () => {
    const registry = registryOf(["a".repeat(16)]);

    expect(pruneCandidates(registry, new Set(["a".repeat(16)]))).toEqual([]);
  });
});

describe("the committed registry file", () => {
  it("exists under its documented name and parses against the schema", () => {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../",
      REGISTRY_FILENAME,
    );

    expect(() => parseRegistry(readFileSync(path, "utf8"))).not.toThrow();
  });
});
