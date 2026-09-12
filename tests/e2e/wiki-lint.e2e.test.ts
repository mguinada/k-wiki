import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers.ts";

/**
 * wiki-lint e2e: the standalone lint door as a real child process,
 * driving a stub agent in a temp data repo. The completed run keeps
 * its edits uncommitted (the next cycle commits them); a tripped
 * guardrail auto-reverts and exits 1. A real LLM run stays a human
 * check.
 */

const run = promisify(execFile);
const LINT_SCRIPT = join(repoRoot, "bin", "wiki-lint");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The stub agent: the lint prompt dispatches on "Audit the wiki";
 *  STUB_MODE rebel writes a forbidden raw/ file (guardrail 1). */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

if (process.env.STUB_MODE === "rebel") {
  await writeFile("raw/rogue.md", "forbidden\\n");

  process.exit(0);
}

await mkdir("outputs", { recursive: true });
await writeFile(process.env.LINT_REPORT, "# lint report\\n");
await writeFile("wiki/index.md", [
  "---",
  'title: "Index"',
  "type: topic",
  "created: 2026-08-20",
  "updated: 2026-08-20",
  "tags:",
  "  - llm",
  "---",
  "",
  "audited",
  "",
].join("\\n"));
console.log("lint: all pages audited, no problems");
`;

interface Repo {
  readonly dataRoot: string;
  readonly rawDir: string;
  readonly settingsPath: string;
  readonly reportFile: string;
}

/** A temp data repo (git, wiki/, raw/) plus the stub agent and its
 *  settings file. */
async function makeRepo(): Promise<Repo> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-lint-e2e-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "raw", "manifest.json"), "{}\n");
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

  const reportPath = `outputs/lint-${new Date().toISOString().slice(0, 10)}.md`;

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
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });

  return {
    dataRoot,
    rawDir: join(dataRoot, "raw"),
    settingsPath,
    reportFile: join(dataRoot, reportPath),
  };
}

function runLint(repo: Repo, env: NodeJS.ProcessEnv = {}) {
  return runCli(LINT_SCRIPT, ["--settings", repo.settingsPath, repo.rawDir], {
    env,
  });
}

describe("wiki-lint e2e", () => {
  it("runs the agent, writes the report, and exits 0", async () => {
    const repo = await makeRepo();
    const result = await runLint(repo);
    const report = await readFile(repo.reportFile, "utf8");

    expect(
      result.code === 0 &&
        result.out.includes("# wiki-lint digest") &&
        result.out.includes("lint: all pages audited") &&
        report === "# lint report\n",
    ).toBe(true);
  });

  it("keeps the lint edits uncommitted for the next cycle", async () => {
    const repo = await makeRepo();

    await runLint(repo);

    const status = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });
    const page = await readFile(
      join(repo.dataRoot, "wiki", "index.md"),
      "utf8",
    );

    expect(
      status.stdout.includes("?? outputs/") &&
        status.stdout.includes(" M wiki/index.md") &&
        page.includes("audited"),
    ).toBe(true);
  });

  it("reverts and exits 1 when a guardrail trips", async () => {
    const repo = await makeRepo();
    const result = await runLint(repo, { STUB_MODE: "rebel" });
    const status = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });

    expect(
      result.code === 1 &&
        result.err.includes(
          "lint guardrail check 1 (immutability) failed; reverted to",
        ) &&
        status.stdout.trim() === "",
    ).toBe(true);
  });
});
