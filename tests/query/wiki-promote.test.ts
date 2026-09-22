import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/query/wiki-promote.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Run main() in-process with captured consoles and NO_COLOR. */
async function runMain(
  args: readonly string[],
): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const prior = process.env.NO_COLOR;

  process.env.NO_COLOR = "1";
  process.exitCode = undefined;

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await main([...args]);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();

    if (prior === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prior;
    }
  }

  return { out, err };
}

/** A git data repo holding one promotable sandbox note and its
 *  source page with a live origin. */
async function makeRepo(): Promise<{ dataRoot: string; rawDir: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-promote-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw", "vault"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Log\n");
  await writeFile(
    join(dataRoot, "wiki", "sandbox", "note-slug.md"),
    [
      "---",
      'title: "Note"',
      "type: concept",
      "via: agent",
      "expires: 2099-01-01",
      "---",
      "",
      "Proposal body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dataRoot, "wiki", "sources", "attention.md"),
    [
      "---",
      'title: "Attention"',
      "type: source",
      "origin: vault/attention.md",
      "---",
      "",
      "Source body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dataRoot, "raw", "vault", "attention.md"),
    "# Attention\n",
  );
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

  return { dataRoot, rawDir: join(dataRoot, "raw") };
}

describe("wiki-promote main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help and exits clean for --help", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--help"]);

    expect(logged.join("\n")).toContain("Usage: wiki-promote");
    expect(logged.join("\n")).toContain("--sources");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails with a usage error when the slug is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--sources", "rag-notes"]);

    expect(error.mock.calls.at(-1)?.[0]).toContain("a slug is required");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
  });

  it("fails with a usage error when no sources were supplied", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["attention-notes"]);

    expect(error.mock.calls.at(-1)?.[0]).toContain("at least one --sources");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
  });
});

describe("wiki-promote main: help contract", () => {
  it("prints the exact shipped help for --help", async () => {
    const { out, err } = await runMain(["--help"]);

    expect(
      out.join("\n"),
    ).toBe(`Usage: wiki-promote [-h | --help] [--wiki, -w <name>] [--raw-dir <dir>] <slug> --sources "<source page>" [--sources "<source page>"...]

Walk one sandbox note into the main wiki — the sandbox's only
exit, the human's deliberate act. Deterministic code, no agent,
zero tokens: the note's body lands byte-exact as a main page under
its type directory, its sandbox stamps (via:, expires:) and any
agent-written sources are dropped, and the human-approved sources
are written in — the note earns provenance only from the vault
projection, never from sandbox lineage.

The promotion is one unit with one commit (promote: <slug>): the
page lands under wiki/<type-directory>/<slug>.md, index.md gains
its entry under the type's section, log.md gains its audit entry,
and the sandbox copy is deleted — a failure anywhere rolls all of
it back and nothing is promoted.

Review first: read wiki/sandbox/<slug>.md (k-wiki read, or any
editor), then promote with exactly the sources you approve.

Refusals (exit 1, nothing written):
  - a dirty data repo (commit or revert first)
  - no sandbox note for the slug (already promoted, reaped, or
    never proposed)
  - an expired note (dead by definition; re-derive it as a new
    proposal)
  - a note whose type is not a wiki page type (concept, entity,
    source, query, comparison)
  - a slug colliding with an existing main page (renaming is the
    human's explicit act: re-propose under the new slug, then
    promote)
  - sources that do not trace to raw/: every --sources entry must
    name an existing type: source page whose origin exists under
    the raw projection (a bracketed "[[name]]" entry is accepted;
    an anchored "[[hub#Chapter]]" entry validates its hub)
  - a promoted page that would violate the one-way citation wall
    (a body link to a sandbox peer)

Switches and arguments:
  <slug>               The sandbox note's slug — wiki/sandbox/<slug>.md.
  --sources <name>     One approved source page name; repeat the
                       flag for several (order preserved). At least
                       one is required. Bracketed and anchored
                       forms are accepted.
  --wiki, -w <name>    Select the wiki instance: an alias in the
                       checkout's sync.json instances map first,
                       then a sync-<name>.json stem in the checkout
                       root; the resolved config's data repo is
                       promoted into. Default: the default instance.
  --raw-dir <dir>      raw/ directory of the data repo to promote
                       in; its parent is the data repo root.
                       Default: <dataRoot>/raw from the resolved
                       instance's sync config; an explicit flag
                       overrides it.
  -h, --help           Print this help and exit; no side effects.

What it writes: one data-repo commit (promote: <slug>) adding
wiki/<type-directory>/<slug>.md with the index.md and log.md
entries and deleting wiki/sandbox/<slug>.md. Prints "Promoted:
<path> (commit <hash>)" on stdout; progress goes to stderr (dim).
Errors print red, prefixed "wiki-promote:", and exit 1. NO_COLOR is
honored. This is a human-door verb: k-wiki wiki-promote from inside
the checkout, or the standalone bin/libexec/wiki-promote launcher;
it is not available on the agent door.`);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("wiki-promote main: usage refusals", () => {
  it("refuses a second positional argument with the exact count error", async () => {
    const { err } = await runMain(["a-slug", "extra", "--sources", "x"]);

    expect(err.at(-1)).toBe(
      'wiki-promote: expected exactly one <slug> argument, got 2 (first extra: "extra")',
    );
    expect(process.exitCode).toBe(1);
  });

  it("refuses a --sources entry that is empty or whitespace", async () => {
    const { err } = await runMain(["a-slug", "--sources", " "]);

    expect(err.at(-1)).toBe(
      "wiki-promote: every --sources entry needs a source page name",
    );
    expect(process.exitCode).toBe(1);
  });

  it("refuses an invalid --wiki name through the shared rule", async () => {
    const { err } = await runMain([
      "a-slug",
      "--wiki",
      "a/b",
      "--sources",
      "x",
    ]);

    expect(err.at(-1)).toContain("--wiki must be a wiki name");
    expect(process.exitCode).toBe(1);
  });
});

describe("wiki-promote main: promotion", () => {
  it("promotes through the CLI: page, index, one commit, bold line", async () => {
    const { dataRoot, rawDir } = await makeRepo();

    const { out, err } = await runMain([
      "note-slug",
      "--raw-dir",
      rawDir,
      "--sources",
      "attention",
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(
      /^Promoted: wiki\/concepts\/note-slug\.md \(commit [0-9a-f]{8}\)$/,
    );
    expect(err.some((line) => line.includes("wiki-promote: committed"))).toBe(
      true,
    );

    const page = await readFile(
      join(dataRoot, "wiki", "concepts", "note-slug.md"),
      "utf8",
    );

    expect(page).toContain('title: "Note"');
    expect(page).toContain("Proposal body.");
    expect(page).not.toContain("via: agent");

    const { stdout: subject } = await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    expect(subject.trim()).toBe("promote: note-slug");
  });

  it("renders a promotion refusal red with the wiki-promote prefix", async () => {
    const { rawDir } = await makeRepo();

    const { err } = await runMain([
      "missing-slug",
      "--raw-dir",
      rawDir,
      "--sources",
      "attention",
    ]);

    expect(err.at(-1)).toContain(
      "wiki-promote: nothing to promote — wiki/sandbox/missing-slug.md does not exist",
    );
    expect(process.exitCode).toBe(1);
  });
});
