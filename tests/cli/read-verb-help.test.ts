import { describe, expect, it } from "vitest";
import { READ_VERB_HELP } from "../../src/cli/read-verb-help.ts";
import { VERBS } from "../../src/cli/verb-table.ts";

/**
 * The read-verb help table (in-context verb help): every read verb
 * in the verb table carries one authored scoped help, and nothing
 * else does. The dispatcher prints these for
 * `k-wiki <verb> -h|--help`; the behavior-level pins (scoped usage,
 * reordering, self-sufficiency) live in tests/cli/k-wiki.test.ts.
 */

describe("read-verb help table", () => {
  it("covers exactly the read verbs of the verb table", () => {
    const readNames = VERBS.filter((verb) => verb.klass === "read")
      .map((verb) => verb.name)
      .sort();

    expect(Object.keys(READ_VERB_HELP).sort()).toEqual(readNames);
  });

  it("starts every entry with its scoped usage line", () => {
    for (const [name, help] of Object.entries(READ_VERB_HELP)) {
      expect(help.startsWith(`Usage: k-wiki ${name} `)).toBe(true);
    }
  });
});
