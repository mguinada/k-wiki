import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/shell.ts";
import {
  composeProposePrompt,
  HELP,
  proposeArgError,
  runProposeVerb,
  templateCandidateNote,
} from "../../src/sandbox/propose.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** The stub agent the verb spawns: extracts the fenced note and
 *  the target path from the --print payload and writes exactly
 *  those bytes (the propose contract). A mode marker switches it
 *  to a run that writes nothing. */
const WRITING_STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? "" : process.argv[index + 1];
const target = /^Target path: (\\S+)$/m.exec(prompt)?.[1];
const note = prompt.split("-----BEGIN NOTE-----\\n")[1]?.split("-----END NOTE-----")[0];
if (target === undefined || note === undefined) process.exit(3);
const file = join(process.cwd(), target);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, note);
console.log("note written");
`;

const SILENT_STUB = `#!/usr/bin/env node
console.log("nothing written");
`;

/** A checkout + data repo pair the verb can resolve from cwd. */
async function makeHarness(
  stub: string,
): Promise<{ checkout: string; dataRoot: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-propose-data-"));

  tempDirs.push(dataRoot);
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Log\\n");
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ],
    { cwd: dataRoot },
  );

  const checkout = await mkdtemp(join(tmpdir(), "k-wiki-propose-co-"));

  tempDirs.push(checkout);
  await writeFile(
    join(checkout, "sync.json"),
    JSON.stringify({ vaults: [], dataRoot }),
  );
  await writeFile(
    join(checkout, "settings.yml"),
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: M\nreasoning: low\n`,
  );
  await writeFile(join(dataRoot, "stub-agent.mjs"), stub, { mode: 0o755 });
  await mkdir(join(checkout, "prompts"), { recursive: true });
  await writeFile(join(checkout, "prompts", "propose.md"), "WRITE RULES.");

  return { checkout, dataRoot };
}

/** Run the verb in-process from inside the checkout, capturing the
 *  console (process.cwd is mocked per the no-chdir rule). */
async function runVerb(
  checkout: string,
  args: readonly string[],
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(checkout);
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  process.exitCode = undefined;

  try {
    await runProposeVerb([...args]);
  } finally {
    cwd.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join("\\n"), err: err.join("\\n") };
}

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

describe("runProposeVerb", () => {
  it("answers -h with the exact shipped help text", async () => {
    const { out, err } = await runVerb(process.cwd(), ["-h"]);

    expect(out).toBe(HELP);
    expect(err).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("lands one gated proposal: note, stamps, audit entry, one commit", async () => {
    const { checkout, dataRoot } = await makeHarness(WRITING_STUB);
    const bodyFile = join(checkout, "note.md");

    await writeFile(bodyFile, "Proposal body.\n");
    const { out } = await runVerb(checkout, ["note-slug", bodyFile]);

    expect(out).toMatch(
      /^proposed wiki\/sandbox\/note-slug\.md \(commit [0-9a-f]{8}\) — a human reviews and promotes it into the wiki; filing is a human step$/,
    );

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "note-slug.md"),
      "utf8",
    );

    expect(note).toContain('title: "note-slug"');
    expect(note).toContain("type: query");
    expect(note).toContain("via: agent");
    expect(note).toMatch(/expires: \d{4}-\d{2}-\d{2}/);
    expect(note).toContain("Proposal body.");

    const { stdout: subject } = await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    expect(subject.trim()).toBe("sandbox: note-slug");

    const logMd = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(logMd).toContain("sandbox | note-slug");
  });

  it("templates the --title and --type overrides into the landed note", async () => {
    const { checkout, dataRoot } = await makeHarness(WRITING_STUB);
    const bodyFile = join(checkout, "note.md");

    await writeFile(bodyFile, "Body.\n");
    await runVerb(checkout, [
      "note-slug",
      bodyFile,
      "--title",
      "A Title",
      "--type",
      "concept",
    ]);

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "note-slug.md"),
      "utf8",
    );

    expect(note).toContain('title: "A Title"');
    expect(note).toContain("type: concept");
  });

  it("refuses an unreadable note file naming the path", async () => {
    const { checkout } = await makeHarness(WRITING_STUB);
    const missing = join(checkout, "no-such-note.md");
    const { err } = await runVerb(checkout, ["note-slug", missing]);

    expect(err).toContain(`cannot read the note file at ${missing}`);
    expect(process.exitCode).toBe(1);
  });

  it("refuses an empty note body", async () => {
    const { checkout } = await makeHarness(WRITING_STUB);
    const bodyFile = join(checkout, "empty.md");

    await writeFile(bodyFile, "   \n");
    const { err } = await runVerb(checkout, ["note-slug", bodyFile]);

    expect(err).toContain("the note body is empty — nothing to propose");
    expect(process.exitCode).toBe(1);
  });

  it("refuses an agent run that wrote nothing", async () => {
    const { checkout } = await makeHarness(SILENT_STUB);
    const bodyFile = join(checkout, "note.md");

    await writeFile(bodyFile, "Body.\n");
    const { err } = await runVerb(checkout, ["note-slug", bodyFile]);

    expect(err).toContain("the agent run wrote nothing — no note was proposed");
    expect(process.exitCode).toBe(1);
  });
});
