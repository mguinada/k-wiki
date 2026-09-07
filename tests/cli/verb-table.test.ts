import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  HELP,
  PORCELAIN_VERBS,
  VERB_NAMES,
  VERBS,
  type VerbSpec,
} from "../../src/cli/verb-table.ts";

/**
 * The verb-table drift guards (issue #337, decision 11): every
 * verb carries a class and a tier, every runtime launcher has its
 * 1:1 verb, the agent whitelist derives from the classes, and the
 * bare help lists every verb tiered porcelain-first. A new
 * launcher without its row — or a write-note verb without its
 * gate wiring — fails here.
 */

const binRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
);

/** Every runtime launcher basename under bin/ and bin/libexec/. */
async function launcherNames(): Promise<string[]> {
  const top = (await readdir(binRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const nested = await readdir(join(binRoot, "libexec"), {
    withFileTypes: true,
  });

  return [...top, ...nested.map((entry) => entry.name)].filter(
    (name) => name !== "k-wiki",
  );
}

/** The read-class verb names — k-wiki's own, no launcher. */
const READ_VERBS = ["query", "status", "list", "read", "health"];

describe("k-wiki verb table", () => {
  it("gives every verb a class of read, write-note, or operator", () => {
    const classes = new Set(["read", "write-note", "operator"]);

    for (const verb of VERBS) {
      expect(classes.has(verb.klass)).toBe(true);
    }
  });

  it("gives every verb a tier of porcelain, operator, or libexec", () => {
    const tiers = new Set(["porcelain", "operator", "libexec"]);

    for (const verb of VERBS) {
      expect(tiers.has(verb.tier)).toBe(true);
    }
  });

  it("lists every runtime launcher 1:1 as an operator verb", async () => {
    const launchers = (await launcherNames()).sort();
    const dispatched = VERB_NAMES.filter(
      (name) => !READ_VERBS.includes(name),
    ).sort();

    expect(dispatched).toEqual(launchers);
  });

  it("keeps every non-read verb wired to a dispatch main", () => {
    const unwired = VERBS.filter(
      (verb) => verb.klass !== "read" && verb.main === undefined,
    );

    expect(unwired.map((verb) => verb.name)).toEqual([]);
  });

  it("keeps every read verb off the launcher mains", () => {
    const wired = VERBS.filter(
      (verb) => verb.klass === "read" && verb.main !== undefined,
    );

    expect(wired.map((verb) => verb.name)).toEqual([]);
  });

  it("wires every write-note verb to the sandbox gate", () => {
    const writeNotes = VERBS.filter(
      (verb: VerbSpec) => verb.klass === "write-note",
    );

    expect(
      writeNotes
        .filter((verb) => verb.gate !== "sandbox")
        .map((verb) => verb.name),
    ).toEqual([]);
  });

  it("gates no read or operator verb", () => {
    expect(
      VERBS.filter(
        (verb) => verb.klass !== "write-note" && verb.gate !== undefined,
      ).map((verb) => verb.name),
    ).toEqual([]);
  });

  it("derives the agent whitelist from the verb classes", () => {
    expect(AGENT_COMMANDS).toEqual(READ_VERBS);
  });

  it("keeps every verb inside the porcelain spotlight list", () => {
    expect(PORCELAIN_VERBS).toEqual([
      "query",
      "status",
      "list",
      "read",
      "health",
      "wiki-sync",
      "wiki-query",
    ]);
  });

  it("groups the bare help porcelain tier first", () => {
    const tiers = [
      "Daily (porcelain):",
      "Occasional operator:",
      "Maintenance (plumbing",
    ];

    const positions = tiers.map((heading) => HELP.indexOf(heading));

    expect(positions.every((pos) => pos !== -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names every verb of every tier in the bare help", () => {
    for (const name of VERB_NAMES) {
      expect(HELP).toContain(`\n  ${name}`);
    }
  });

  it("documents the -w verbs in the global flag entry", () => {
    for (const verb of VERBS.filter((entry) => entry.wiki)) {
      expect(HELP).toContain(verb.name);
    }
  });
});
