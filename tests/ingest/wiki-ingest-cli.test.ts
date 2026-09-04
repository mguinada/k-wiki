import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/shell.ts";
import { ingestFlags, main } from "../../src/ingest/wiki-ingest-cli.ts";
import { serializeManifest } from "../../src/sync/manifest.ts";
import {
  entry,
  type Harness,
  makeHarness,
  manifestWith,
  restoreNoColor,
  restoreStderrTty,
  runFiles,
} from "./harness.ts";

/**
 * wiki-ingest-cli unit tests (issue #258): the CLI flag derivation on
 * the shared shell (ingestFlags) and the end-to-end CLI suite moved
 * from wiki-ingest.test.ts.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const track: (dir: string) => void = (dir) => tempDirs.push(dir);

describe("ingestFlags", () => {
  const SPEC = {
    value: ["--settings", "--outputs", "--timeout", "--note", "--wiki"],
    repeat: ["--sources"],
    positionals: {
      max: 1,
      error: (_arg: string, count: number) =>
        `expected at most one <raw-dir> argument, got ${count}`,
    },
  } as const;

  it("maps every flag and the positional onto the typed flag set", () => {
    const parsed = parseArgs(
      [
        "--settings",
        "s.yml",
        "--outputs",
        "o",
        "--timeout",
        "5",
        "--sources",
        "V/a.md",
        "--note",
        "re-open",
        "raw",
      ],
      SPEC,
    );
    const { flags, error } = ingestFlags(parsed);

    expect(error).toBeUndefined();
    expect(flags).toEqual({
      settings: "s.yml",
      outputs: "o",
      timeoutMs: 5000,
      rawDir: "raw",
      sources: ["V/a.md"],
      note: "re-open",
    });
  });

  it("reads the inline = forms of the value and repeat flags", () => {
    const parsed = parseArgs(["--settings=s.yml", "--sources=V/a.md"], SPEC);
    const { flags, error } = ingestFlags(parsed);

    expect(error).toBeUndefined();
    expect(flags.settings).toBe("s.yml");
    expect(flags.sources).toEqual(["V/a.md"]);
  });

  it("defaults to an empty sources list and an absent note", () => {
    const { flags, error } = ingestFlags(parseArgs([], SPEC));

    expect(error).toBeUndefined();
    expect(flags.sources).toEqual([]);
    expect(flags.note).toBeUndefined();
  });

  it("rejects a note without its value", () => {
    const { error } = ingestFlags(parseArgs(["--note"], SPEC));

    expect(error).toBe("--note needs a value");
  });

  it("rejects a blank note", () => {
    const { error } = ingestFlags(parseArgs(["--note", "  "], SPEC));

    expect(error).toBe("--note needs a value");
  });

  it("rejects a note without a scoped --sources run", () => {
    const { error } = ingestFlags(parseArgs(["--note", "intent"], SPEC));

    expect(error).toBe("--note requires --sources");
  });

  it("rejects a --sources flag without its value", () => {
    const { error } = ingestFlags(parseArgs(["--sources"], SPEC));

    expect(error).toBe("--sources needs a path value");
  });

  it("rejects a --settings flag without its value", () => {
    const { error } = ingestFlags(parseArgs(["--settings"], SPEC));

    expect(error).toBe("--settings needs a path value");
  });

  it("rejects a non-numeric --timeout", () => {
    const { error } = ingestFlags(parseArgs(["--timeout", "abc"], SPEC));

    expect(error).toBe("--timeout needs a positive integer number of seconds");
  });

  it("rejects a second positional", () => {
    const { error } = ingestFlags(parseArgs(["a", "b"], SPEC));

    expect(error).toBe("expected at most one <raw-dir> argument, got 2");
  });

  it("rejects an unknown option", () => {
    const { error } = ingestFlags(parseArgs(["--nope"], SPEC));

    expect(error).toBe('unknown option "--nope"');
  });

  it("carries the --wiki name onto the flag set", () => {
    const { flags, error } = ingestFlags(parseArgs(["--wiki", "meta"], SPEC));

    expect(error).toBeUndefined();
    expect(flags.wiki).toBe("meta");
  });

  it("names the missing --wiki value", () => {
    const { error } = ingestFlags(parseArgs(["--wiki"], SPEC));

    expect(error).toBe("--wiki needs a name value");
  });

  it("rejects a --wiki name with a path separator", () => {
    const { error } = ingestFlags(parseArgs(["--wiki", "../x"], SPEC));

    expect(error).toContain("--wiki must be a wiki name");
  });

  it("keeps an absent --wiki undefined", () => {
    const { flags, error } = ingestFlags(parseArgs([], SPEC));

    expect(error).toBeUndefined();
    expect(flags.wiki).toBeUndefined();
  });
});

describe("wiki-ingest CLI", () => {
  const STUB = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Guard: a mutated wrapper may redirect this stub into the real data
// repo; refuse to write anywhere but this harness's data root.
if (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);
const index = process.argv.indexOf("--print");
await mkdir(join(process.cwd(), "outputs"), { recursive: true });
await writeFile(join(process.cwd(), "outputs", "stub-prompt.txt"), process.argv[index + 1] ?? "");
await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "concepts", "stub.md"), [
  "---",
  'title: "Stub"',
  "type: concept",
  "created: 2026-08-20",
  "updated: 2026-08-20",
  "tags:",
  "  - llm",
  "sources:",
  '  - "[[src]]"',
  "---",
  "",
  "stub body",
  "",
].join("\\n"));
console.log("stub report");
`;

  /** A harness whose settings point at an executable stub agent. */
  async function makeCliHarness(): Promise<Harness> {
    const h = await makeHarness({ "a.md": "a" }, track);
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
    await writeFile(stub, STUB, { mode: 0o755 });
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    return h;
  }

  function cliArgs(h: Harness): string[] {
    return [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];
  }

  async function runCli(args: string[]): Promise<{ out: string; err: string }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), ...args];
    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-ingest [-h | --help] [--wiki <name>] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [--sources <vault/path>] [--note <text>] [<raw-dir>]",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the --settings switch in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--settings");
  });

  it("documents the --outputs switch in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--outputs");
  });

  it("documents the <raw-dir> positional in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("<raw-dir>");
  });

  it("documents the switch defaults in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("Default");
  });

  it("documents --sources with the <vault/path> syntax", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--sources <vault/path>");
  });

  it("documents the exact-path rule for --sources", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("exact manifest paths");
  });

  it("documents the snapshot precondition of --sources", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("run a full ingest first");
  });

  it("documents --note with the <text> syntax", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--note <text>");
  });

  it("documents the --note default line and scoped-only rule", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("does not imply a no-op");
    expect(out).toContain("requires --sources");
  });

  it("parses a repeatable --sources flag and dedupes it", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/a.md",
      "--sources",
      "Engineering/a.md",
    ]);

    const prompt = await readFile(
      join(h.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt.split("~ Engineering/a.md").length - 1).toBe(1);
  });

  it("carries a --note into the scoped prompt", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/a.md",
      "--note",
      "recovery: re-adjudicate the four pages",
    ]);

    const prompt = await readFile(
      join(h.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Operator note:");
    expect(prompt).toContain("recovery: re-adjudicate the four pages");
  });

  it("applies the default operator note on a scoped CLI run without --note", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([...cliArgs(h), "--sources", "Engineering/a.md"]);

    const prompt = await readFile(
      join(h.dataRoot, "outputs", "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Operator note:");
    expect(prompt).toContain("Sources re-opened by the operator");
    expect(prompt).toContain("re-adjudicate filing decisions");
  });

  it("exits 1 when --note has no value", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--note"]);

    expect(err).toContain("--note needs a value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --note has a blank value", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--note", ""]);

    expect(err).toContain("--note needs a value");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --note runs without --sources", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--note", "intent"]);

    expect(err).toContain("--note requires --sources");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 on an unknown --sources path naming the path", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    const { err } = await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/nope.md",
    ]);

    expect(err).toContain("unknown --sources path(s): Engineering/nope.md");
  });

  it("sets exit code 1 for an unknown --sources path", async () => {
    const h = await makeCliHarness();

    await mkdir(dirname(h.snapshotPath), { recursive: true });
    await writeFile(
      h.snapshotPath,
      serializeManifest(manifestWith("Engineering", { "a.md": entry("a") }), {
        snapshotFor: h.dataRoot,
      }),
    );

    await runCli([...cliArgs(h), "--sources", "Engineering/nope.md"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 on --sources with no snapshot and says to run a full ingest first", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([
      ...cliArgs(h),
      "--sources",
      "Engineering/a.md",
    ]);

    expect(err).toContain("run a full ingest first");
  });

  it("sets exit code 1 when --sources has no snapshot", async () => {
    const h = await makeCliHarness();

    await runCli([...cliArgs(h), "--sources", "Engineering/a.md"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when --sources has no value", async () => {
    const h = await makeCliHarness();

    const { err } = await runCli([...cliArgs(h), "--sources"]);

    expect(err).toContain("--sources needs a path value");
  });

  it("sets exit code 1 when --sources has no value", async () => {
    const h = await makeCliHarness();

    await runCli([...cliArgs(h), "--sources"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "/no/such/raw-dir"]);

    expect(out).toContain("Usage: wiki-ingest");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 with a stderr message when settings cannot be read", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("sets exit code 1 when settings cannot be read", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("runs the stub agent end to end and prints the digest", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
  });

  it("prints the created and updated page counts in the digest", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("**Wiki pages:** 1 created, 0 updated, 0 deleted");
  });

  it("announces the full ingest mode on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toContain("wiki-ingest: mode full, invoking agent");
  });

  it("leaves the exit code unset after a successful end-to-end run", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the skip line for a second run with no changes", async () => {
    const h = await makeCliHarness();
    const args = [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];

    await runCli(args);

    const { out } = await runCli(args);

    expect(out).toBe(
      "wiki-ingest: no changed sources since the last ingest; nothing to do",
    );
  });

  it("leaves the exit code unset for a no-change second run", async () => {
    const h = await makeCliHarness();
    const args = [
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
    ];

    await runCli(args);
    await runCli(args);

    expect(process.exitCode).toBeUndefined();
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1800",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("Wiki ingest digest");
  });

  it("leaves the exit code unset when --timeout is accepted", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1800",
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("converts --timeout seconds to the agent deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "slow-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('slow but fine');\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const { out } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "5",
      join(h.dataRoot, "raw"),
    ]);

    expect(out).toContain("slow but fine");
  });

  it("leaves the exit code unset when the agent finishes under the deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "slow-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('slow but fine');\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "5",
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stalled-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(err).toMatch(/timed out after 1 second/);
  });

  it("sets exit code 1 when a stalled agent is killed at the deadline", async () => {
    const h = await makeCliHarness();
    const stub = join(h.dataRoot, "stalled-stub.mjs");

    await writeFile(
      stub,
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    await runCli([
      "--settings",
      h.settingsPath,
      "--outputs",
      h.outputsDir,
      "--timeout",
      "1",
      join(h.dataRoot, "raw"),
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--bogus"]);

    expect(err).toContain("wiki-ingest: unknown option");
  });

  it("sets exit code 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--bogus"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints no color codes under NO_COLOR", async () => {
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { err } = await runCli(["--bogus"]);

      expect(err).not.toContain("\u001b[");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("exits 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(err).toContain("needs a path value");
  });

  it("sets exit code 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--outputs",
      h.outputsDir,
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "one", "two"]);

    expect(err).toContain("expected at most one <raw-dir>");
  });

  it("sets exit code 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "one", "two"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --outputs without a value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      join(h.dataRoot, "raw"),
      "--outputs",
    ]);

    expect(err).toContain("--outputs needs a path value");
  });

  it("sets exit code 1 for --outputs without a value", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      join(h.dataRoot, "raw"),
      "--outputs",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("documents the --timeout switch and its default in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("--timeout <secs>");
  });

  it("documents the --timeout default of 1800 seconds in the help text", async () => {
    const out = (await runCli(["--help"])).out;

    expect(out).toContain("1800");
  });

  it("exits 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "0"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "0"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "-5"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "-5"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "abc"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "abc"]);

    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...cliArgs(h), "--timeout", "5x"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("sets exit code 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    await runCli([...cliArgs(h), "--timeout", "5x"]);

    expect(process.exitCode).toBe(1);
  });

  it("writes the run digest into the --outputs directory it was given", async () => {
    const h = await makeCliHarness();
    const runsDir = join(h.outputsDir, "runs");
    const before = await runFiles(runsDir);

    await runCli(cliArgs(h));

    const after = await runFiles(runsDir);

    expect(after.length).toBe(before.length + 1);
  });

  it("defaults --outputs to the repo's outputs directory", async () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const runsDir = join(repoRoot, "outputs", "runs");
    const before = await runFiles(runsDir);
    const h = await makeCliHarness();

    await runCli(["--settings", h.settingsPath, join(h.dataRoot, "raw")]);

    const after = await runFiles(runsDir);

    expect(after.length).toBeGreaterThan(before.length);
  });

  it("defaults --settings to the repo settings.yml", async () => {
    const noManifest = await mkdtemp(join(tmpdir(), "k-wiki-nomanifest-"));

    tempDirs.push(noManifest);

    const { err } = await runCli([join(noManifest, "raw")]);

    expect(err).toContain("no manifest at");
  });

  it("renders progress straight to stderr when stderr is a TTY", async () => {
    const h = await makeCliHarness();
    const priorTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const priorNoColor = process.env.NO_COLOR;
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    delete process.env.NO_COLOR;

    let raw = "";

    try {
      await runCli(cliArgs(h));
      raw = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      writeSpy.mockRestore();
      restoreStderrTty(priorTty);
      restoreNoColor(priorNoColor);
    }

    expect(raw).toContain("wiki-ingest: raw dir");
  });

  it("keeps progress off the raw stderr writer under NO_COLOR on a TTY", async () => {
    const h = await makeCliHarness();
    const priorTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const priorNoColor = process.env.NO_COLOR;
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    process.env.NO_COLOR = "1";

    let captured: { out: string; err: string };
    let raw = "";

    try {
      captured = await runCli(cliArgs(h));
      raw = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      writeSpy.mockRestore();
      restoreStderrTty(priorTty);
      restoreNoColor(priorNoColor);
    }

    expect({
      errHasRender: captured.err.includes("wiki-ingest: raw dir"),
      rawHasRender: raw.includes("wiki-ingest: raw dir"),
    }).toEqual({ errHasRender: true, rawHasRender: false });
  });
});
