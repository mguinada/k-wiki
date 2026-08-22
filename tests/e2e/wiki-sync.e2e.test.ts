import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  generateFixtureVault,
  VAULT_NAME,
} from "../../src/fixtures/generate.ts";
import { runCli, SYNC_CYCLE_SCRIPT } from "./helpers.ts";

/**
 * wiki-sync e2e: the real orchestrator CLI as a child process, driving
 * a stub agent through the full cycle — sync → ingest → lint → one
 * data-repo commit — then the no-change rerun (nothing to do) and a
 * tripped lint guardrail (revert, exit 1). The stub dispatches on the
 * real prompt files: the lint prompt starts "Audit the wiki", the
 * ingest prompts do not. A real LLM run stays a human check.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * The stub agent: ingest prompts write valid wiki pages; the lint
 * prompt additionally writes the lint report into the data repo's
 * outputs/ (where prompts/lint.md tells the agent to save it). A lint
 * variant that writes a broken page trips guardrail 2; an ingest
 * variant that fails outright tests the stopped chain.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];
const mode = process.env.STUB_MODE ?? "";

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

if (mode === "fail-ingest") {
  process.exit(4);
}

if (mode === "break-lint" && prompt.startsWith("Audit the wiki")) {
  await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
  await writeFile(join(process.cwd(), "wiki", "concepts", "broken.md"), "no frontmatter\\n");
  console.log("rogue lint");
  process.exit(0);
}

await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await writeFile(
  join(process.cwd(), "wiki", "concepts", "stub.md"),
  [
    "---",
    'title: "Stub"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[index]]"',
    "---",
    "",
    "stub body",
    "",
  ].join("\\n"),
);
await writeFile(
  join(process.cwd(), "wiki", "index.md"),
  [
    "---",
    'title: "Index"',
    "type: topic",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[index]]"',
    "---",
    "",
    "# Index v2",
    "",
  ].join("\\n"),
);

if (prompt.startsWith("Audit the wiki")) {
  await mkdir(join(process.cwd(), "outputs"), { recursive: true });
  await writeFile(
    join(process.cwd(), "outputs", process.env.STUB_LINT_REPORT ?? "lint-stub.md"),
    "# Lint report\\n\\nAll checks passed.\\n",
  );
  console.log("lint: all pages audited, no problems");
} else {
  console.log("stub agent: sources processed; no contradictions; no unresolved questions");
}
`;

interface Repo {
  readonly dataRoot: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
}

/** A temp data repo plus fixture vault, sync.json, and stub agent. */
async function makeRepo(): Promise<Repo> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-sync-e2e-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const vaultRoot = await generateFixtureVault(tmp);
  const configPath = join(tmp, "sync.json");
  const settingsPath = join(tmp, "settings.yml");
  const outputsDir = join(tmp, "outputs");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, exclude: "wiki:false" }],
    }),
  );
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { dataRoot, configPath, settingsPath, outputsDir };
}

function runCycle(repo: Repo, extraEnv: NodeJS.ProcessEnv = {}) {
  return runCli(
    SYNC_CYCLE_SCRIPT,
    [
      "--settings",
      repo.settingsPath,
      "--outputs",
      repo.outputsDir,
      repo.configPath,
      join(repo.dataRoot, "raw"),
    ],
    { env: extraEnv },
  );
}

describe("wiki-sync e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(SYNC_CYCLE_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: wiki-sync/);
  });

  it("runs the full cycle into one readable data-repo commit", async () => {
    const repo = await makeRepo();
    const today = new Date().toISOString().slice(0, 10);
    const result = await runCycle(repo, {
      STUB_LINT_REPORT: `lint-${today}.md`,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("# wiki-sync cycle digest");
    expect(result.out).toContain(
      `**Lint:** report \`outputs/lint-${today}.md\``,
    );
    expect(result.out).toContain("**Commit:** `");

    const { stdout: log } = await run("git", ["log", "-1", "--pretty=%B"], {
      cwd: repo.dataRoot,
    });

    expect(log).toMatch(
      /^wiki-sync: \d+ sources processed, \d+ pages touched$/m,
    );
    expect(log).toContain(`- lint: outputs/lint-${today}.md`);

    await expect(
      readFile(join(repo.dataRoot, "outputs", `lint-${today}.md`), "utf8"),
    ).resolves.toContain("Lint report");
    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "stub.md"), "utf8"),
    ).resolves.toContain("stub body");
    await expect(
      readFile(
        join(repo.dataRoot, "raw", "notes", VAULT_NAME, "AI", "RAG.md"),
        "utf8",
      ),
    ).resolves.toContain("RAG");
  });

  it("prints the cycle's commit hash in the digest", async () => {
    const repo = await makeRepo();
    const result = await runCycle(repo);
    const { stdout: hash } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(result.out).toContain(hash.trim().slice(0, 8));
  });

  it("does nothing on a rerun with no vault changes", async () => {
    const repo = await makeRepo();

    await runCycle(repo);

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to do");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("stops the chain with exit 1 and no commit when the ingest agent fails", async () => {
    const repo = await makeRepo();

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo, { STUB_MODE: "fail-ingest" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("code 4");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("reverts a tripped lint guardrail and leaves no commit", async () => {
    const repo = await makeRepo();

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo, { STUB_MODE: "break-lint" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("lint guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "broken.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "stub.md"), "utf8"),
    ).resolves.toContain("stub body");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });
});
