import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCompletionVerb,
  zshCompletionScript,
} from "../../src/cli/completion.ts";
import { tierSections, verbTable } from "../../src/cli/verb-table.ts";

/**
 * The completion verb (issue #352): the front door's shell-plumbing
 * emitter — static, read-only, wiki-independent. These tests pin the
 * emitted zsh script's shape (compdef header, tier-grouped verb
 * lists, global flags), its determinism (default and explicit zsh
 * spelling byte-identical), the loud unknown-shell usage error, and
 * the verb's own help.
 */

interface Capture {
  readonly out: string;
  readonly err: string;
}

/** Run the verb in-process, capturing the console. */
async function runVerb(args: readonly string[]): Promise<Capture> {
  const out: string[] = [];
  const err: string[] = [];

  process.exitCode = undefined;

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await runCompletionVerb([...args]);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join("\n"), err: err.join("\n") };
}

describe("completion verb", () => {
  it("answers -h with usage and exits 0 without side effects", async () => {
    const { out, err } = await runVerb(["-h"]);

    expect(out.startsWith("Usage: k-wiki completion")).toBe(true);
    expect(err).toBe("");
  });

  it("answers --help with the same text as -h", async () => {
    const dash = await runVerb(["-h"]);
    const ddash = await runVerb(["--help"]);

    expect(ddash.out).toBe(dash.out);
  });

  it("prints help before validating the shell argument", async () => {
    const { out } = await runVerb(["-h", "bash"]);

    expect(out.startsWith("Usage: k-wiki completion")).toBe(true);
  });

  it("emits the zsh script on stdout with nothing on stderr, exit 0", async () => {
    const { out, err } = await runVerb([]);

    expect(out.startsWith("#compdef k-wiki")).toBe(true);
    expect(err).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("emits byte-identical output for the default and the explicit zsh spelling", async () => {
    const implicit = await runVerb([]);
    const explicit = await runVerb(["zsh"]);

    expect(explicit.out).toBe(implicit.out);
    expect(explicit.err).toBe("");
  });

  it("emits identical bytes on every run (deterministic)", async () => {
    const first = await runVerb([]);
    const second = await runVerb([]);

    expect(second.out).toBe(first.out);
  });

  it("exits 1 naming zsh for an unsupported shell, printing nothing on stdout", async () => {
    const { out, err } = await runVerb(["bash"]);

    expect(out).toBe("");
    expect(err).toContain('unsupported shell "bash"');
    expect(err).toContain("zsh");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for a second positional argument", async () => {
    const { err } = await runVerb(["zsh", "fish"]);

    expect(err).toContain("unexpected argument");
    expect(process.exitCode).toBe(1);
  });
});

describe("zsh completion script", () => {
  it("opens with the compdef header line", () => {
    expect(zshCompletionScript().split("\n")[0]).toBe("#compdef k-wiki");
  });

  it("names every verb of the table exactly once", () => {
    const script = zshCompletionScript();

    for (const verb of verbTable()) {
      expect(script.match(new RegExp(`'${verb.name}:`, "g"))?.length).toBe(1);
    }
  });

  it("groups the verb lists in the bare-help tier order", () => {
    const script = zshCompletionScript();
    const positions = tierSections().map(({ tier }) =>
      script.indexOf(`_k_wiki_${tier}=(`),
    );

    expect(positions.every((pos) => pos !== -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("completes the global flags, --checkout as a path-taking flag", () => {
    const script = zshCompletionScript();

    expect(script).toContain("'(-h --help)'{-h,--help}'");
    expect(script).toContain("'(-w --wiki)'{-w,--wiki}'");
    expect(script).toContain(
      "'--checkout[k-wiki checkout for this run]:path:_files'",
    );
  });

  it("offers the verbs at the first word and nothing beyond the flags", () => {
    const script = zshCompletionScript();

    expect(script).toContain("'1:verb:->verb'");
    expect(script).toContain("'*: :'");
  });

  it("registers itself when sourced into a compinit shell", () => {
    expect(zshCompletionScript()).toContain("compdef _k-wiki k-wiki");
  });

  it("escapes single quotes in verb descriptions for zsh", () => {
    const listLine = verbTable().find((verb) => verb.name === "list")?.lines[0] ?? "";

    expect(listLine).toContain("'");
    expect(zshCompletionScript()).toContain(
      `'list:${listLine.replaceAll("'", "'\\''")}'`,
    );
  });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});
