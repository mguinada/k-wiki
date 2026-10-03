import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readQueryArtifact } from "../../src/query/file-last.ts";
import { main } from "../../src/query/query-cli.ts";
import {
  cleanTempDirs,
  defaultLastQuery,
  type Harness,
  makeHarness,
  repoRoot,
  run,
} from "./helpers.ts";

const localTempDirs: string[] = [];

afterAll(async () => {
  await cleanTempDirs();
  await Promise.all(
    localTempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("wiki-query CLI", () => {
  const STUB = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// Guard: a mutated wrapper may redirect this stub into the real data
// repo; refuse to write anywhere but this harness's data root.
if (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);
console.log("Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].");
`;

  /** A harness whose settings point at an executable stub agent. */
  async function makeCliHarness(): Promise<Harness> {
    const h = await makeHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
    await writeFile(stub, STUB, { mode: 0o755 });
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    return h;
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

  function queryArgs(h: Harness, extra: string[] = []) {
    return [
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      ...extra,
      "When should I prefer RAG over fine-tuning?",
    ];
  }

  function fileLastArgs(h: Harness, extra: string[] = []) {
    return [
      "--file-last",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      ...extra,
    ];
  }

  it("prints the usage line for --help", async () => {
    expect((await runCli(["--help"])).out).toContain(
      "wiki-query [-h | --help] [--file-last] [--web] [--wiki, -w <name>] [--settings <path>] [--outputs <dir>] [--raw-dir <dir>] [--timeout <secs>] <question>",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
  });

  it("documents the --file-last switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--file-last");
  });

  it("documents the --web switch in the help", async () => {
    const help = (await runCli(["--help"])).out;

    expect(help).toContain("--web");
    expect(help).toContain("pi-web-access");
    expect(help).toContain("Two agent passes");
  });

  it("names the --web with --file-last conflict on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--file-last",
      "--web",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
    ]);

    expect(err).toContain(
      "--web enriches a stage-1 answer run; --file-last takes no --web",
    );
  });

  it("exits 1 for the --web with --file-last conflict", async () => {
    const h = await makeCliHarness();

    await runCli([
      "--file-last",
      "--web",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("documents the --settings switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--settings");
  });

  it("documents the --outputs switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--outputs");
  });

  it("reaches the settings load when --outputs is absent, failing at the invalid settings file", async () => {
    const h = await makeHarness();

    await writeFile(h.settingsPath, "this line has no colon\n");

    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "a question?",
    ]);

    expect(err).toContain("invalid agent settings");
  });

  it("documents the --raw-dir switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--raw-dir");
  });

  it("documents the --timeout switch and its value in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--timeout <secs>");
  });

  it("documents the defaults in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("Default");
  });

  it("documents stage 1 in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("Stage 1");
  });

  it("documents stage 2 in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("Stage 2");
  });

  it("no longer documents --no-filing", async () => {
    expect((await runCli(["--help"])).out).not.toContain("--no-filing");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runCli(["--help", "leftover-arg"]);

    expect(out).toContain("Usage: wiki-query");
  });

  it("leaves the exit code unset for --help", async () => {
    await runCli(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the missing-question error on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
    ]);

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is missing", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the missing-question error for an empty question", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h).slice(0, -1).concat(""));

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is an empty string", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h).slice(0, -1).concat(""));

    expect(process.exitCode).toBe(1);
  });

  it("prints the missing-question error for a whitespace-only question", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h).slice(0, -1).concat("   "));

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is only whitespace", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h).slice(0, -1).concat("   "));

    expect(process.exitCode).toBe(1);
  });

  it("names the one-question rule on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "two"]);

    expect(err).toContain("expected exactly one <question>");
  });

  it("exits 1 for more than one positional argument", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "two"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the unknown option on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "--bogus"]);

    expect(err).toContain("wiki-query: unknown option");
  });

  it("exits 1 for an unknown option", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "--bogus"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the removed --no-filing switch on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "--no-filing"]);

    expect(err).toContain('unknown option "--no-filing"');
  });

  it("exits 1 for the removed --no-filing switch", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "--no-filing"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --settings value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--settings",
    ]);

    expect(err).toContain("--settings needs a path value");
  });

  it("exits 1 when --settings has no value", async () => {
    const h = await makeCliHarness();
    await runCli(["--raw-dir", join(h.dataRoot, "raw"), "--settings"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --raw-dir value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(["--settings", h.settingsPath, "--raw-dir"]);

    expect(err).toContain("--raw-dir needs a path value");
  });

  it("exits 1 when --raw-dir has no value", async () => {
    const h = await makeCliHarness();
    await runCli(["--settings", h.settingsPath, "--raw-dir"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing --outputs value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h).slice(0, -1), "--outputs"]);

    expect(err).toContain("--outputs needs a path value");
  });

  it("exits 1 when --outputs has no value", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h).slice(0, -1), "--outputs"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr when the value is missing", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...queryArgs(h), "--timeout"]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout without a value", async () => {
    const h = await makeCliHarness();
    await runCli([...queryArgs(h), "--timeout"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for zero", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "0"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout zero", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "0"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for a negative value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "-5"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout negative", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "-5"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for a non-numeric value", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "abc"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout non-numeric", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "abc"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout value rule on stderr for trailing junk", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--timeout", "5x"]));

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "5x"]));

    expect(process.exitCode).toBe(1);
  });

  it("names the unreadable settings file on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      "q",
    ]);

    expect(err).toContain(
      "cannot read agent settings at /no/such/settings.yml",
    );
  });

  it("exits 1 when settings cannot be read", async () => {
    const h = await makeCliHarness();
    await runCli([
      "--settings",
      "/no/such/settings.yml",
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      "q",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the agent's answer to stdout", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h));

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("prints no Filed line in stage 1", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h));

    expect(out).not.toContain("Filed:");
  });

  it("announces the agent invocation on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("wiki-query: invoking agent");
  });

  it("prints the --file-last hint on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("wiki-query --file-last");
  });

  it("saves the question in the stage-1 artifact", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h));

    const artifact = await readQueryArtifact(
      join(h.outputsDir, "last-query.md"),
    );

    expect(artifact.question).toBe(
      "When should I prefer RAG over fine-tuning?",
    );
  });

  it("writes nothing under wiki/ in stage 1", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h));

    const { stdout } = await run(
      "git",
      ["-C", h.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");
  });

  it("leaves the exit code unset after a successful query", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("passes the question through to the agent payload", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const prompt = await readFile(join(h.dataRoot, "stub-prompt.txt"), "utf8");

    expect(prompt).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h, ["--timeout", "1800"]));

    expect(out).toContain("Prefer RAG when");
  });

  it("leaves the exit code unset for a valid --timeout", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--timeout", "1800"]));

    expect(process.exitCode).toBeUndefined();
  });

  /** A CLI harness whose stub agent writes a rogue page under wiki/. */
  async function makeRogueCliHarness(): Promise<Harness> {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "queries", "rogue.md"), "rogue");
console.log("An answer.");
`,
      { mode: 0o755 },
    );

    return h;
  }

  it("names the revert on stderr when the CLI agent writes under wiki/", async () => {
    const h = await makeRogueCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("reverted");
  });

  it("exits 1 when the CLI agent writes under wiki/", async () => {
    const h = await makeRogueCliHarness();
    await runCli(queryArgs(h));

    expect(process.exitCode).toBe(1);
  });

  it("writes nothing under wiki/ after the revert", async () => {
    const h = await makeRogueCliHarness();
    await runCli(queryArgs(h));

    const { stdout } = await run(
      "git",
      ["-C", h.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");
  });

  it("saves no artifact after a reverted CLI wiki write", async () => {
    const h = await makeRogueCliHarness();
    await runCli(queryArgs(h));

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the no-question rule for --file-last on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli([...fileLastArgs(h), "a question?"]);

    expect(err).toContain("--file-last takes no <question>");
  });

  it("exits 1 when --file-last is given a question", async () => {
    const h = await makeCliHarness();
    await runCli([...fileLastArgs(h), "a question?"]);

    expect(process.exitCode).toBe(1);
  });

  it("states that no saved answer exists on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toContain("no saved answer");
  });

  it("names the wiki-query remedy on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toContain("wiki-query");
  });

  it("exits 1 when --file-last finds no saved answer", async () => {
    const h = await makeCliHarness();
    await runCli(fileLastArgs(h));

    expect(process.exitCode).toBe(1);
  });

  /** A harness holding a saved stage-1 answer whose settings file is
   *  gone — exactly the state --file-last must work from. */
  async function harnessWithSavedAnswer(): Promise<Harness> {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));
    await rm(h.settingsPath);

    return h;
  }

  it("files the saved answer under wiki/queries/ with --file-last", async () => {
    const h = await harnessWithSavedAnswer();
    const { out } = await runCli(fileLastArgs(h));

    expect(out).toContain(
      "Filed: wiki/queries/when-should-i-prefer-rag-over-fine-tuning.md",
    );
  });

  it("prints nothing on stderr when filing succeeds", async () => {
    const h = await harnessWithSavedAnswer();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toBe("");
  });

  it("leaves the exit code unset when filing without a settings file", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("writes the answer into the filed query page", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    const page = await readFile(
      join(
        h.dataRoot,
        "wiki",
        "queries",
        "when-should-i-prefer-rag-over-fine-tuning.md",
      ),
      "utf8",
    );

    expect(page).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("links the filed query from the index", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    const index = await readFile(join(h.dataRoot, "wiki", "index.md"), "utf8");

    expect(index).toContain(
      "- [[when-should-i-prefer-rag-over-fine-tuning]] — When should I prefer RAG over fine-tuning?",
    );
  });

  it("appends the query to the log", async () => {
    const h = await harnessWithSavedAnswer();
    await runCli(fileLastArgs(h));

    const log = await readFile(join(h.dataRoot, "wiki", "log.md"), "utf8");

    expect(log).toMatch(
      /## \[\d{4}-\d{2}-\d{2}\] query \| When should I prefer RAG over fine-tuning\?/,
    );
  });

  it("files the saved answer from the checkout's default outputs directory when --outputs is omitted", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const cliOutputs = join(repoRoot, "outputs");
    const defaultArtifact = join(cliOutputs, "last-query.md");
    const previous = await readFile(defaultArtifact).catch(() => null);

    await mkdir(cliOutputs, { recursive: true });
    await writeFile(
      defaultArtifact,
      await readFile(join(h.outputsDir, "last-query.md")),
    );

    try {
      const { out } = await runCli([
        "--file-last",
        "--raw-dir",
        join(h.dataRoot, "raw"),
      ]);

      expect(out).toContain(
        "Filed: wiki/queries/when-should-i-prefer-rag-over-fine-tuning.md",
      );
    } finally {
      if (previous === null) {
        await rm(defaultArtifact, { force: true });
      } else {
        await writeFile(defaultArtifact, previous);
      }
    }
  });

  it("bolds the Filed line", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const prior = process.env.NO_COLOR;

    delete process.env.NO_COLOR;

    try {
      const { out } = await runCli(fileLastArgs(h));
      const filed = out.split("\n").find((line) => line.includes("Filed:"));

      expect(filed).toContain("\u001b[1m");
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  /** A harness holding a saved answer whose data repo received a
   *  wiki commit dated after the saved answer — the drift state. */
  async function harnessWithDriftedWiki(): Promise<Harness> {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const artifactPath = join(h.outputsDir, "last-query.md");
    const artifact = await readQueryArtifact(artifactPath);

    await writeFile(
      join(h.dataRoot, "wiki", "index.md"),
      "# Index\n\n<!-- later -->\n",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    const driftDate = new Date(
      Date.parse(artifact.timestamp) + 60_000,
    ).toISOString();

    await run(
      "git",
      [
        "-C",
        h.dataRoot,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--quiet",
        "-m",
        "wiki moved",
      ],
      { env: { ...process.env, GIT_COMMITTER_DATE: driftDate } },
    );

    return h;
  }

  it("still files when the data repo drifted after the saved answer", async () => {
    const h = await harnessWithDriftedWiki();
    const { out } = await runCli(fileLastArgs(h));

    expect(out).toContain("Filed:");
  });

  it("prints the drift warning on stderr", async () => {
    const h = await harnessWithDriftedWiki();
    const { err } = await runCli(fileLastArgs(h));

    expect(err).toContain(
      "warning: the data repo changed after the saved answer",
    );
  });

  it("leaves the exit code unset when filing despite drift", async () => {
    const h = await harnessWithDriftedWiki();
    await runCli(fileLastArgs(h));

    expect(process.exitCode).toBeUndefined();
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    const { err } = await runCli(queryArgs(h, ["--timeout", "1"]));

    expect(err).toMatch(/timed out after 1 second/);
  });

  it("exits 1 after the --timeout kills the agent", async () => {
    const h = await makeCliHarness();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    await runCli(queryArgs(h, ["--timeout", "1"]));

    expect(process.exitCode).toBe(1);
  });

  it("makes no console.error call in stage 2 when nothing drifted", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h));

    const argv = process.argv;
    let calls = 0;

    process.argv = [...argv.slice(0, 2), ...fileLastArgs(h)];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      calls += 1;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main();
    } finally {
      process.argv = argv;
      spy.mockRestore();
      logSpy.mockRestore();
    }

    expect(calls).toBe(0);
  });

  it("fails at the data repo guardrail, not at settings, when --settings is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-query-nogit-"));

    localTempDirs.push(dir);

    const { err } = await runCli([
      "--raw-dir",
      join(dir, "raw"),
      "a question?",
    ]);

    expect(err).toContain("the data repo has no commit to revert to");
  });

  it.skipIf(existsSync(defaultLastQuery))(
    "names the repo's outputs/last-query.md when --outputs is omitted",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "k-wiki-query-"));

      localTempDirs.push(dir);

      const { err } = await runCli([
        "--file-last",
        "--raw-dir",
        join(dir, "raw"),
      ]);

      expect(err).toContain(`no saved answer at ${defaultLastQuery}`);
    },
  );

  /** Run a failing agent query on a fake TTY with color forced on;
   *  returns everything written to stderr. */
  async function runFailingQueryOnTty(h: Harness): Promise<string> {
    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => process.exit(3), 250);\n",
      { mode: 0o755 },
    );

    const argv = process.argv;
    const isTTY = process.stderr.isTTY;
    const noColor = process.env.NO_COLOR;
    const writes: string[] = [];

    process.argv = [...argv.slice(0, 2), ...queryArgs(h)];
    process.stderr.isTTY = true;
    delete process.env.NO_COLOR;

    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));

        return true;
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main();
    } finally {
      process.argv = argv;
      process.stderr.isTTY = isTTY;

      if (noColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = noColor;
      }

      writeSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return writes.join("");
  }

  it("erases the live heartbeat line before printing a failure", async () => {
    const h = await makeCliHarness();
    const written = await runFailingQueryOnTty(h);

    expect(written).toMatch(/\r +\r/);
  });

  it("exits 1 after the failing TTY query", async () => {
    const h = await makeCliHarness();
    await runFailingQueryOnTty(h);

    expect(process.exitCode).toBe(1);
  });

  it("documents the --wiki switch in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("--wiki <name>");
  });

  it("documents the stem convention in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("sync-<name>.json");
  });

  it("documents the alias registry key in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("instances");
  });

  it("documents the precedence rule in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("always");
  });

  it("names the missing --wiki value on stderr", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--wiki"]).slice(0, -1));

    expect(err).toContain("--wiki needs a name value");
  });

  it("exits 1 for a missing --wiki value", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h, ["--wiki"]).slice(0, -1));

    expect(process.exitCode).toBe(1);
  });

  it("rejects a --wiki name with a path separator at parse", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--wiki", "../x"]));

    expect(err).toContain("--wiki must be a wiki name");
  });

  it("exits 1 for a --wiki name with a path separator", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h, ["--wiki", "../x"]));

    expect(process.exitCode).toBe(1);
  });

  it("names an unknown --wiki name in the failure", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--wiki", "nope"]));

    expect(err).toContain('unknown wiki name "nope"');
  });

  it("lists the known names for an unknown --wiki name", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--wiki", "nope"]));

    expect(err).toContain("known names:");
  });

  it("runs nothing for an unknown --wiki name", async () => {
    const h = await makeCliHarness();

    await runCli(queryArgs(h, ["--wiki", "nope"]));

    await expect(
      readFile(join(h.dataRoot, "stub-prompt.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("echoes --wiki in the stage-1 filing hint", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["--wiki", "meta"]));

    expect(err).toContain("wiki-query --wiki meta --file-last");
  });

  it("keeps the plain filing hint without --wiki", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h));

    expect(err).toContain("To file this answer: k-wiki wiki-query --file-last");
  });

  it("runs the explicit --settings stub over the --wiki-derived settings", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h, ["--wiki", "meta"]));

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("announces the filing under --wiki with --file-last", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--wiki", "meta"]));
    const { out } = await runCli(fileLastArgs(h, ["--wiki", "meta"]));

    expect(out).toContain("Filed:");
  });

  it("echoes the canonical --wiki in the stage-1 filing hint under -w", async () => {
    const h = await makeCliHarness();
    const { err } = await runCli(queryArgs(h, ["-w", "meta"]));

    expect(err).toContain("wiki-query --wiki meta --file-last");
  });

  it("answers through the -w short alias like --wiki", async () => {
    const h = await makeCliHarness();
    const { out } = await runCli(queryArgs(h, ["-w", "meta"]));

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("files the saved answer through -w in stage 2", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["-w", "meta"]));
    const { out } = await runCli(fileLastArgs(h, ["-w", "meta"]));

    expect(out).toContain("Filed:");
  });

  it("writes the filed page into the --wiki-resolved data repo", async () => {
    const h = await makeCliHarness();
    await runCli(queryArgs(h, ["--wiki", "meta"]));
    await runCli(fileLastArgs(h, ["--wiki", "meta"]));

    await expect(
      readFile(
        join(
          h.dataRoot,
          "wiki",
          "queries",
          "when-should-i-prefer-rag-over-fine-tuning.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Prefer RAG");
  });
});

describe("wiki-query CLI stderr surface", () => {
  it("prints the filing hint after a blank stderr line", async () => {
    const h = await makeHarness();
    const stub = join(h.dataRoot, "stub-agent.mjs");

    await writeFile(join(h.dataRoot, ".cli-test-repo"), "");
    await writeFile(stub, '#!/usr/bin/env node\nconsole.log("A.");\n', {
      mode: 0o755,
    });
    await writeFile(
      h.settingsPath,
      `command: ${stub}\nmodel: M\nreasoning: low\n`,
    );

    const argv = process.argv;
    const err: string[] = [];

    process.argv = [
      ...argv.slice(0, 2),
      "--settings",
      h.settingsPath,
      "--raw-dir",
      join(h.dataRoot, "raw"),
      "--outputs",
      h.outputsDir,
      "q",
    ];

    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      await main();
    } finally {
      process.argv = argv;
      spy.mockRestore();
      logSpy.mockRestore();

      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }

    expect(
      err
        .join("\n")
        .endsWith("\n\nTo file this answer: k-wiki wiki-query --file-last"),
    ).toBe(true);
  });
});
