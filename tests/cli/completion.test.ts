import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCompletionVerb,
  zshCompletionScript,
} from "../../src/cli/completion.ts";
import { GLOBAL_FLAG_TOKENS } from "../../src/cli/k-wiki.ts";
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
  it("answers -h with the exact shipped help text", async () => {
    const { out } = await runVerb(["-h"]);

    expect(out).toBe(`Usage: k-wiki completion [-h | --help] [<shell>]

Emit the shell completion function for the k-wiki front door.
Shell plumbing, not a wiki verb: no checkout, instance, or door is
resolved, nothing is read but the verb table this CLI ships, and
nothing is written anywhere — the script goes to stdout only, and
stderr stays silent on success. The output is static and
byte-identical on every run, so it can be redirected into a file
or sourced directly.

Arguments:
  <shell>    The shell to emit for. Default: zsh — the only
             supported shell today. Any other name is a usage
             error naming the supported shells, never a guess.

Options:
  -h, --help          This help; no side effects.

What it writes: the completion script to stdout, nothing else.
Try it now, zero setup:
  source <(k-wiki completion zsh)
Keep it permanently:
  k-wiki completion zsh > ~/.zfunc/_k-wiki
  # ~/.zshrc — fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit
The script defines a zsh compdef function for k-wiki that completes
the verbs grouped by the bare-help tiers (daily, occasional
operator, maintenance) and the global flags (-w/--wiki, -h/--help,
--checkout <path>, which completes paths); verb arguments are not
completed statically. Exit 0 prints the script; exit 1 is a usage
error. NO_COLOR is honored (the script itself never uses color).`);
  });

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

  it("completes every global flag token the dispatcher accepts (drift guard)", () => {
    const script = zshCompletionScript();
    const argsBlock = script.slice(
      script.indexOf("_arguments"),
      script.indexOf("case $state"),
    );

    for (const token of GLOBAL_FLAG_TOKENS) {
      expect(argsBlock).toContain(token);
    }
  });

  it("registers itself when sourced into a compinit shell", () => {
    expect(zshCompletionScript()).toContain("compdef _k-wiki k-wiki");
  });

  it("escapes single quotes in verb descriptions for zsh", () => {
    expect(zshCompletionScript()).toContain(
      String.raw`    'list:one '\''slug — title'\'' line per page, grouped by type;'`,
    );
  });

  it("emits the exact shipped zsh script (the pinned completion contract)", () => {
    expect(zshCompletionScript()).toBe(`#compdef k-wiki
# k-wiki zsh completion — emitted by \`k-wiki completion\` (static:
# the verb table and the global flags; no wiki state is read at
# completion time). Install it permanently:
#   k-wiki completion zsh > ~/.zfunc/_k-wiki
#   # ~/.zshrc — fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit
# Or try it now, zero setup: source <(k-wiki completion zsh)

_k-wiki() {
  local context state state_descr line
  local -a _k_wiki_porcelain _k_wiki_operator _k_wiki_libexec

  _k_wiki_porcelain=(
    'query:ask the bound wiki one question (the only LLM verb;'
    'status:print the resolved binding, paths, and last change'
    'list:one '\\''slug — title'\\'' line per page, grouped by type;'
    'read:print one page verbatim, resolved by file name'
    'health:projection coherence + freshness check (read-only)'
    'propose:file one candidate note under wiki/sandbox/ — the gated'
    'wiki-sync:run the whole cycle and print the digest'
    'wiki-query:ask one question headless; --file-last files the'
  )

  _k_wiki_operator=(
    'init-data-repo:create and seed the data repo (once; idempotent)'
    'sync-vault:project every vault note into raw/ (deterministic)'
    'sync-repo:project a source repository verbatim into raw/ (meta)'
    'wiki-ingest:run the wiki agent over changed sources; write the digest'
    'wiki-lint:run the quality-lint agent alone; report to the data'
    'dashboard:regenerate the static KPI dashboard (read-only)'
    'scheduled-run:run one unattended cycle (the launchd command)'
    'setup-schedule:register the launchd schedule'
    'setup-meta-sync:install the meta wiki'\\''s post-merge auto-sync hooks'
    'completion:emit the zsh completion script for this front door'
  )

  _k_wiki_libexec=(
    'check-raw:coherence (and staleness) of a raw/ projection'
    'check-links:every [[wikilink]] and heading anchor resolves'
    'check-crosslinks:one-way cross-wiki link discipline'
    'check-citations:one-way wall between the wiki and its wiki/sandbox/'
    'check-provenance:every sources entry and origin is alive'
    'check-fidelity:quoted tokens trace to origins; titles match names'
    'backfill-origin:write origin on source pages lacking it; dry run first'
    'link-sources:migrate path-form sources entries to hub wikilinks'
    'anchor-citations:migrate aliased hub citations to chapter anchors'
    'invert-log:invert log.md to newest-first; lossless, one-way'
    'open-origin:emit an obsidian://open URI for a hub'\\''s origin'
    'wiki-promote:walk a sandbox note into the main wiki — one'
    'sync-watchdog:heartbeat watchdog — alert when the scheduled cycle'\\''s'
  )

  _arguments -S \\
    '(-h --help)'{-h,--help}'[print help — the front door alone, or the verb after it]' \\
    '(-w --wiki)'{-w,--wiki}'[select the wiki instance]:instance:' \\
    '--checkout[k-wiki checkout for this run]:path:_files' \\
    '1:verb:->verb' \\
    '*: :'

  case $state in
    verb)
      _describe -t porcelain 'porcelain verb' _k_wiki_porcelain
      _describe -t operator 'operator verb' _k_wiki_operator
      _describe -t libexec 'libexec verb' _k_wiki_libexec
      ;;
  esac
}

if (( $+functions[compdef] )); then
  compdef _k-wiki k-wiki
fi`);
  });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});
