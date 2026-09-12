import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/shell.ts";
import { LINT_CLI_SPEC, lintFlags, main } from "../../src/sync/wiki-lint.ts";

/**
 * wiki-lint unit tests: the CLI flag derivation on the shared shell
 * (lintFlags) and the standalone door's wiring of the lint stage —
 * digest, door re-labelling, uncommitted edits, the timed-out agent,
 * and the guardrail auto-revert — against a stub agent in a temp
 * data repo.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

afterEach(() => {
  process.exitCode = undefined;
  delete process.env.STUB_MODE;
  vi.restoreAllMocks();
});

/** The stub agent: writes the lint report (the prompt tells the real
 *  agent to); STUB_MODE rebel writes a forbidden raw/ file to trip
 *  guardrail 1; STUB_MODE sleep outlives a --timeout 1 run. */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const mode = process.env.STUB_MODE ?? "";

if (mode === "rebel") {
  await writeFile("raw/rogue.md", "forbidden\\n");

  process.exit(0);
}

if (mode === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, 5000));

  process.exit(0);
}

await mkdir("outputs", { recursive: true });
await writeFile(process.env.LINT_REPORT, "# lint report\\n");
console.log("lint: all pages audited, no problems");
`;

interface Repo {
  readonly dataRoot: string;
  readonly rawDir: string;
  readonly settingsPath: string;
  readonly reportPath: string;
}

/** A temp data repo (git, wiki/, raw/manifest.json) plus a stub
 *  agent and its settings file. */
async function makeRepo(): Promise<Repo> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-lint-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

  const today = new Date().toISOString().slice(0, 10);
  const reportPath = `outputs/lint-${today}.md`;

  await writeFile(
    join(dataRoot, "stub-agent.mjs"),
    STUB_AGENT.replaceAll(
      "process.env.LINT_REPORT",
      JSON.stringify(reportPath),
    ),
    { mode: 0o755 },
  );

  const settingsPath = join(tmp, "settings.yml");

  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: STUB\nreasoning: low\n`,
  );
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });

  return { dataRoot, rawDir: join(dataRoot, "raw"), settingsPath, reportPath };
}

/** Run main() in-process, capturing the console. */
async function runMain(args: readonly string[]): Promise<{
  out: string;
  err: string;
}> {
  const out: string[] = [];
  const err: string[] = [];

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
  }

  return { out: out.join("\n"), err: err.join("\n") };
}

describe("lintFlags", () => {
  it("maps every flag and the positional onto the typed flag set", () => {
    const parsed = parseArgs(
      ["--settings", "s.yml", "--timeout", "5", "-w", "eng", "raw"],
      LINT_CLI_SPEC,
    );
    const { flags, error } = lintFlags(parsed);

    expect(error).toBeUndefined();
    expect(flags).toEqual({
      settings: "s.yml",
      timeoutMs: 5000,
      rawDir: "raw",
      wiki: "eng",
    });
  });

  it("defaults every flag to absent", () => {
    const { flags, error } = lintFlags(parseArgs([], LINT_CLI_SPEC));

    expect(error).toBeUndefined();
    expect(flags).toEqual({
      settings: undefined,
      timeoutMs: undefined,
      rawDir: undefined,
      wiki: undefined,
    });
  });

  it("rejects a --timeout that is not a positive integer", () => {
    const parsed = parseArgs(["--timeout", "0"], LINT_CLI_SPEC);
    const { error } = lintFlags(parsed);

    expect(error).toBe("--timeout needs a positive integer number of seconds");
  });

  it("rejects a second positional", () => {
    const parsed = parseArgs(["a", "b"], LINT_CLI_SPEC);
    const { error } = lintFlags(parsed);

    expect(error).toBe("expected at most one <raw-dir> argument, got 2");
  });
});

describe("wiki-lint CLI", () => {
  it("answers -h with usage and exits clean", async () => {
    const { out, err } = await runMain(["-h"]);

    expect(out.startsWith("Usage: wiki-lint") && err === "").toBe(true);
  });

  it("prints a digest naming the report the agent wrote", async () => {
    const repo = await makeRepo();
    const { out } = await runMain([
      "--settings",
      repo.settingsPath,
      repo.rawDir,
    ]);

    expect(out).toContain(`# wiki-lint digest\n\n- report: ${repo.reportPath}`);
  });

  it("re-labels the stage's progress lines with the door's name", async () => {
    const repo = await makeRepo();
    const { err } = await runMain([
      "--settings",
      repo.settingsPath,
      repo.rawDir,
    ]);

    expect(err).toContain("wiki-lint — guardrails passed");
  });

  it("leaves the lint report uncommitted in the data repo", async () => {
    const repo = await makeRepo();

    await runMain(["--settings", repo.settingsPath, repo.rawDir]);

    const status = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });

    expect(status.stdout).toContain("?? outputs/");
  });

  it("exits 1 when the agent times out, naming the budget", async () => {
    const repo = await makeRepo();

    process.env.STUB_MODE = "sleep";

    const { err } = await runMain([
      "--settings",
      repo.settingsPath,
      "--timeout",
      "1",
      repo.rawDir,
    ]);

    expect(
      err.includes("wiki-lint:") &&
        err.includes("timed out after 1 second") &&
        process.exitCode === 1,
    ).toBe(true);
  });

  it("exits 1 and names the check when a guardrail trips", async () => {
    const repo = await makeRepo();

    process.env.STUB_MODE = "rebel";

    const { err } = await runMain([
      "--settings",
      repo.settingsPath,
      repo.rawDir,
    ]);

    expect(
      err.includes(
        "lint guardrail check 1 (immutability) failed; reverted to",
      ) && process.exitCode === 1,
    ).toBe(true);
  });

  it("reverts the data repo to its pre-run state on a tripped guardrail", async () => {
    const repo = await makeRepo();

    process.env.STUB_MODE = "rebel";

    await runMain(["--settings", repo.settingsPath, repo.rawDir]);

    const status = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });

    expect(status.stdout.trim()).toBe("");
  });
});
