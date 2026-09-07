import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/shell.ts";
import {
  composeProposePrompt,
  proposeArgError,
  templateCandidateNote,
} from "../../src/sandbox/propose.ts";

/**
 * The propose verb's pure surface (issue #340): the deterministic
 * candidate-note template, the sandbox-write prompt composition, and
 * the verb's usage-error rules. The gated flow itself (write →
 * accept-gate → stamp → atomic commit through family 3's primitive)
 * runs as real child processes in tests/e2e/propose.e2e.test.ts.
 */

/** The verb's own parse of its argv (the shell spec propose uses). */
function parsed(args: readonly string[]) {
  return parseArgs(args, {
    value: ["--checkout", "--timeout", "--wiki", "--title", "--type"],
    alias: new Map([["-w", "--wiki"]]),
    positionals: {
      max: 2,
      error: (arg) => `unexpected argument ${JSON.stringify(arg)}`,
    },
  });
}

describe("templateCandidateNote", () => {
  it("wraps the body in title and type frontmatter", () => {
    expect(
      templateCandidateNote({
        title: "Attention notes",
        type: "query",
        body: "Proposal body.\n",
      }),
    ).toBe(
      [
        "---",
        'title: "Attention notes"',
        "type: query",
        "---",
        "",
        "Proposal body.",
        "",
      ].join("\n"),
    );
  });

  it("keeps a title with quotes and colons on one JSON-quoted line", () => {
    const note = templateCandidateNote({
      title: 'RAG: "when" to prefer it',
      type: "concept",
      body: "Body.\n",
    });

    expect(note.split("\n")[1]).toBe('title: "RAG: \\"when\\" to prefer it"');
    expect(note).toContain("type: concept");
  });

  it("normalizes trailing whitespace to exactly one final newline", () => {
    expect(
      templateCandidateNote({
        title: "T",
        type: "query",
        body: "Body.\n\n\n  \n",
      }),
    ).toBe('---\ntitle: "T"\ntype: query\n---\n\nBody.\n');
  });

  it("keeps the body byte-exact apart from the trailing normalization", () => {
    expect(
      templateCandidateNote({
        title: "T",
        type: "query",
        body: "  indented start\n\n- list item\n",
      }),
    ).toBe(
      '---\ntitle: "T"\ntype: query\n---\n\n  indented start\n\n- list item\n',
    );
  });
});

describe("composeProposePrompt", () => {
  it("carries the prompt text, the target path, and the fenced note", () => {
    const prompt = composeProposePrompt(
      "WRITE RULES.",
      "attention-notes",
      "---\ntype: query\n---\n\nBody.\n",
    );

    expect(prompt.startsWith("WRITE RULES.")).toBe(true);
    expect(prompt).toContain("Target path: wiki/sandbox/attention-notes.md");
    expect(prompt).toContain("-----BEGIN NOTE-----");
    expect(prompt).toContain("-----END NOTE-----");
    expect(prompt).toContain("---\ntype: query\n---\n\nBody.\n");
  });
});

describe("proposeArgError", () => {
  it("requires a slug", () => {
    expect(proposeArgError(parsed([]), false)).toBe(
      "a <slug> is required: k-wiki propose <slug> [<file>]",
    );
  });

  it("rejects a slug that is not lowercase kebab-case", () => {
    expect(proposeArgError(parsed(["Attention Notes"]), false)).toContain(
      "kebab-case",
    );
  });

  it("requires a file argument when stdin is a terminal", () => {
    expect(proposeArgError(parsed(["note-slug"]), true)).toBe(
      "the note body is required: pass a <file> argument or pipe the note on stdin",
    );
  });

  it("accepts no file when stdin is piped", () => {
    expect(proposeArgError(parsed(["note-slug"]), false)).toBeUndefined();
  });

  it("accepts a file argument with terminal stdin", () => {
    expect(
      proposeArgError(parsed(["note-slug", "note.md"]), true),
    ).toBeUndefined();
  });

  it("rejects a multi-line title", () => {
    expect(
      proposeArgError(
        parsed(["note-slug", "n.md", "--title", "two\nlines"]),
        false,
      ),
    ).toBe("--title must be a single line");
  });

  it("rejects an unknown type", () => {
    expect(
      proposeArgError(parsed(["note-slug", "n.md", "--type", "essay"]), false),
    ).toBe(
      'unknown type "essay"; valid types: concept|entity|source|query|comparison',
    );
  });

  it("rejects an invalid --wiki value", () => {
    expect(
      proposeArgError(parsed(["note-slug", "n.md", "--wiki", "a/b"]), false),
    ).toContain("--wiki must be a wiki name");
  });

  it("rejects a non-positive --timeout value", () => {
    expect(
      proposeArgError(
        parsed(["note-slug", "n.md", "--timeout", "soon"]),
        false,
      ),
    ).toBe("--timeout needs a positive integer number of seconds");
  });

  it("rejects a third positional argument", () => {
    expect(proposeArgError(parsed(["a-b", "n.md", "extra"]), false)).toContain(
      "unexpected argument",
    );
  });
});
