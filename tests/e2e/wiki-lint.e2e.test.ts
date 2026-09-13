import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { makeStubDataRepo, repoRoot, runCli } from "./helpers.ts";

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
 *  it also records the exact prompt it received under outputs/ so
 *  the tests can assert the audit mode; STUB_MODE rebel writes a
 *  forbidden raw/ file (guardrail 1). */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

if (process.env.STUB_MODE === "rebel") {
  await writeFile("raw/rogue.md", "forbidden\\n");

  process.exit(0);
}

const promptIndex = process.argv.indexOf("--print");
const prompt = promptIndex === -1 ? "" : process.argv[promptIndex + 1];

await mkdir("outputs", { recursive: true });
await writeFile("outputs/received-prompt.txt", prompt);
const reportPath = prompt
  .match(/outputs\\/lint-\\d{4}-\\d{2}-\\d{2}(-full)?\\.md/)?.[0];

if (reportPath === undefined) process.exit(6);

await writeFile(reportPath, "# lint report\\n");
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

/** A stub data repo from the shared helpers (absolute report paths
 *  for reads), registered for this file's cleanup. */
interface LintRepo {
  readonly dataRoot: string;
  readonly rawDir: string;
  readonly settingsPath: string;
  readonly reportFile: string;
  readonly fullReportFile: string;
}

async function makeRepo(): Promise<LintRepo> {
  const repo = await makeStubDataRepo({
    stubAgent: STUB_AGENT,
    prefix: "k-wiki-lint-e2e-",
    model: "E2E-MODEL",
  });

  tempDirs.push(repo.tmp);

  return {
    dataRoot: repo.dataRoot,
    rawDir: repo.rawDir,
    settingsPath: repo.settingsPath,
    reportFile: join(repo.dataRoot, repo.reportPath),
    fullReportFile: join(repo.dataRoot, repo.fullReportPath),
  };
}

function runLint(repo: LintRepo, env: NodeJS.ProcessEnv = {}) {
  return runCli(LINT_SCRIPT, ["--settings", repo.settingsPath, repo.rawDir], {
    env,
  });
}

describe("wiki-lint e2e", () => {
  it("runs the agent, writes the report, and exits 0", async () => {
    const repo = await makeRepo();
    const result = await runLint(repo);
    const report = await readFile(repo.fullReportFile, "utf8");

    expect(result.code).toBe(0);
    expect(result.out).toContain("# wiki-lint digest");
    expect(result.out).toContain("lint: all pages audited");
    expect(report).toBe("# lint report\n");
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

    expect(status.stdout).toContain("?? outputs/");
    expect(status.stdout).toContain(" M wiki/index.md");
    expect(page).toContain("audited");
  });

  it("reverts and exits 1 when a guardrail trips", async () => {
    const repo = await makeRepo();
    const result = await runLint(repo, { STUB_MODE: "rebel" });
    const status = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "lint guardrail check 1 (immutability) failed; reverted to",
    );
    expect(status.stdout.trim()).toBe("");
  });
});

describe("wiki-lint e2e — windowed audits (issue #359)", () => {
  it("runs a full audit first, then a windowed audit, then honors --full", async () => {
    const repo = await makeRepo();
    const promptPath = join(repo.dataRoot, "outputs", "received-prompt.txt");
    const snapshotPath = join(repo.dataRoot, "outputs", "lint-window.json");

    // First run: no snapshot — the full audit prompt, then the
    // snapshot lands.
    await runLint(repo);
    const firstPrompt = await readFile(promptPath, "utf8");

    expect(firstPrompt.startsWith("Audit the wiki for quality problems.")).toBe(
      true,
    );
    expect(firstPrompt).toContain("Deterministic worklists");
    expect(firstPrompt).not.toContain("Pages in this audit window");
    expect(await readFile(snapshotPath, "utf8")).toContain('"snapshotFor"');

    // Edit one page: the next door run is windowed to it (plus its
    // reverse-link neighbors — index links to nothing here, so the
    // window is the edited page alone).
    await writeFile(
      join(repo.dataRoot, "wiki", "index.md"),
      "# Index\n\nedited by hand\n",
      "utf8",
    );

    await runLint(repo);

    const secondPrompt = await readFile(promptPath, "utf8");

    expect(secondPrompt.startsWith("Audit the wiki pages listed")).toBe(true);
    expect(secondPrompt).toContain("Pages in this audit window");
    expect(secondPrompt).toContain("- wiki/index.md");
    expect(secondPrompt).not.toContain("Audit the wiki for quality problems.");

    // --full forces the whole-wiki prompt whatever the snapshot says.
    await runLint(repo, {});
    await writeFile(
      join(repo.dataRoot, "wiki", "index.md"),
      "# Index\n\nedited again\n",
      "utf8",
    );

    const result = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });

    const full = await runCli(LINT_SCRIPT, [
      "--full",
      "--settings",
      repo.settingsPath,
      repo.rawDir,
    ]);

    const thirdPrompt = await readFile(promptPath, "utf8");

    expect(full.code).toBe(0);
    expect(thirdPrompt.startsWith("Audit the wiki for quality problems.")).toBe(
      true,
    );
    expect(result.stdout).toContain(" M wiki/index.md");
  });

  it("keeps the lint-window snapshot out of the data repo history", async () => {
    const repo = await makeRepo();

    await runLint(repo);

    const exclude = await readFile(
      join(repo.dataRoot, ".git", "info", "exclude"),
      "utf8",
    );
    const status = await run("git", ["status", "--porcelain"], {
      cwd: repo.dataRoot,
    });

    expect(exclude).toContain("outputs/lint-window.json");
    expect(exclude).toContain("outputs/lint-window.json.tmp");
    expect(status.stdout).not.toContain("lint-window.json");
  });
});
