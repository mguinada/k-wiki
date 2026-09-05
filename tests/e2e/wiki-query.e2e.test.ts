import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { QUERY_SCRIPT, runCli } from "./helpers.ts";

/**
 * wiki-query e2e: the real CLI as a child process, driving a stub
 * agent through both stages. The stub receives the exact argv the
 * real agent would (pi flags from settings.yml), records the
 * composed prompt, and answers plainly — no filing protocol: stage 1
 * is answer-only by default and mechanically enforced, stage 2
 * (--file-last) is deterministic templating with no agent at all. A
 * real LLM run stays a human check (issue #67 acceptance): it costs
 * money and is not deterministic.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * The stub agent: an executable script (shebang) so settings.yml can
 * name it as the command. It records the --print payload and answers
 * plainly. ROGUE_STUB also writes a wiki page — the stage-1 guardrail
 * must catch, revert, and fail the run. Exits 3 when the payload is
 * missing — the wrapper must pass the prompt.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);
console.log("Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].");
`;

const ROGUE_STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "queries", "rogue.md"), "rogue");
console.log("An answer.");
`;

interface Repo {
  readonly dataRoot: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
}

/** A temp data repo: git-tracked wiki/, empty raw/, stub agent. */
async function makeRepo(): Promise<Repo> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-query-e2e-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(
    join(dataRoot, "wiki", "index.md"),
    [
      "# Wiki Index",
      "",
      "## Concepts",
      "",
      "<!-- concepts here -->",
      "",
      "## Queries",
      "",
      "<!-- Add filed query answers here -->",
      "",
    ].join("\n"),
  );
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log\n");
  await writeFile(
    join(dataRoot, "wiki", "concepts", "rag.md"),
    "---\ntype: concept\n---\nRAG\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "sources", "retrieval-augmented-generation.md"),
    "---\ntype: source\n---\nRAG source\n",
  );

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
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

  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { dataRoot, settingsPath, outputsDir: join(dataRoot, "outputs") };
}

function stage1(repo: Repo, extra: string[] = []) {
  return runCli(QUERY_SCRIPT, [
    "--settings",
    repo.settingsPath,
    "--raw-dir",
    join(repo.dataRoot, "raw"),
    "--outputs",
    repo.outputsDir,
    ...extra,
    "When should I prefer RAG over fine-tuning?",
  ]);
}

function stage2(repo: Repo, extra: string[] = []) {
  return runCli(QUERY_SCRIPT, [
    "--file-last",
    "--raw-dir",
    join(repo.dataRoot, "raw"),
    "--outputs",
    repo.outputsDir,
    ...extra,
  ]);
}

async function wikiStatus(repo: Repo): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-C", repo.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
    { env: process.env },
  );

  return stdout.trim();
}

describe("wiki-query e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(QUERY_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: wiki-query/);
    expect(result.out).toContain("--file-last");
    expect(result.out).not.toContain("--no-filing");
  });

  it("stage 1 answers, writes nothing under wiki/, and saves the artifact", async () => {
    const repo = await makeRepo();
    const result = await stage1(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );
    expect(result.err).toContain("wiki-query: invoking agent");
    expect(result.err).toContain("wiki-query --file-last");

    expect(await wikiStatus(repo)).toBe("");

    const artifact = await readFile(
      join(repo.outputsDir, "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(
      'question: "When should I prefer RAG over fine-tuning?"',
    );
    expect(artifact).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );

    const prompt = await readFile(
      join(repo.dataRoot, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("You are answering questions");
    expect(prompt).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
    expect(prompt).toContain("Mode: answer-only");
    expect(prompt).not.toContain("QUERY:");
  });

  it("stage 1 under --wiki answers and echoes the flag in the filing hint", async () => {
    const repo = await makeRepo();
    const result = await stage1(repo, ["--wiki", "meta"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );
    expect(result.err).toContain("wiki-query --wiki meta --file-last");

    const artifact = await readFile(
      join(repo.outputsDir, "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(
      'question: "When should I prefer RAG over fine-tuning?"',
    );
  });

  it("stage 2 under --wiki files the saved answer into the resolved data repo", async () => {
    const repo = await makeRepo();
    await stage1(repo, ["--wiki", "meta"]);
    const result = await stage2(repo, ["--wiki", "meta"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Filed:");

    const page = await readFile(
      join(
        repo.dataRoot,
        "wiki",
        "queries",
        "when-should-i-prefer-rag-over-fine-tuning.md",
      ),
      "utf8",
    );

    expect(page).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("exits 1 listing the known names for an unknown --wiki", async () => {
    const repo = await makeRepo();
    const result = await stage1(repo, ["--wiki", "nope"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown wiki name "nope"');
    expect(result.err).toContain("known names:");
    expect(result.err).toContain("meta");

    await expect(
      readFile(join(repo.dataRoot, "stub-prompt.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a --wiki name with a path separator at parse", async () => {
    const repo = await makeRepo();
    const result = await stage1(repo, ["--wiki", "../x"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--wiki must be a wiki name");
  });

  it("documents the --wiki switch and the resolution chain in the help", async () => {
    const result = await runCli(QUERY_SCRIPT, ["--help"]);

    expect(result.out).toContain("--wiki <name>");
    expect(result.out).toContain("sync-<name>.json");
    expect(result.out).toContain("instances");
  });

  it("stage 1 reverts and exits 1 when the agent writes under wiki/", async () => {
    const repo = await makeRepo();

    await writeFile(join(repo.dataRoot, "stub-agent.mjs"), ROGUE_STUB, {
      mode: 0o755,
    });

    const result = await stage1(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("reverted");

    expect(await wikiStatus(repo)).toBe("");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "queries", "rogue.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      readFile(join(repo.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the removed --no-filing switch", async () => {
    const repo = await makeRepo();
    const result = await stage1(repo, ["--no-filing"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown option "--no-filing"');
  });

  it("exits 1 with the remedy when --file-last finds no saved answer", async () => {
    const repo = await makeRepo();
    const result = await stage2(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("no saved answer");
  });

  it("stage 2 files the saved answer byte-exactly with index and log entries", async () => {
    const repo = await makeRepo();
    await stage1(repo);

    const result = await stage2(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Filed: wiki/queries/when-should-i-prefer-rag-over-fine-tuning.md",
    );

    const page = await readFile(
      join(
        repo.dataRoot,
        "wiki",
        "queries",
        "when-should-i-prefer-rag-over-fine-tuning.md",
      ),
      "utf8",
    );

    expect(page).toContain("type: query");
    expect(page).toContain(
      "Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].",
    );

    const index = await readFile(
      join(repo.dataRoot, "wiki", "index.md"),
      "utf8",
    );

    expect(index).toContain(
      "- [[when-should-i-prefer-rag-over-fine-tuning]] — When should I prefer RAG over fine-tuning?",
    );

    const log = await readFile(join(repo.dataRoot, "wiki", "log.md"), "utf8");

    expect(log).toMatch(
      /## \[\d{4}-\d{2}-\d{2}\] query \| When should I prefer RAG over fine-tuning\?/,
    );
  });

  it("stage 2 prints nothing to stderr when nothing drifted", async () => {
    const repo = await makeRepo();
    await stage1(repo);

    const result = await stage2(repo);

    expect(result.err).toBe("");
  });

  it("stage 2 warns on drift but still files", async () => {
    const repo = await makeRepo();
    await stage1(repo);

    const artifact = await readFile(
      join(repo.outputsDir, "last-query.md"),
      "utf8",
    );
    const timestamp = /timestamp: "(.+?)"/.exec(artifact)?.[1];

    expect(timestamp).toBeDefined();

    await writeFile(
      join(repo.dataRoot, "wiki", "concepts", "rag.md"),
      "---\ntype: concept\n---\nRAG v2\n",
    );
    await run("git", ["-C", repo.dataRoot, "add", "-A"]);
    const driftDate = new Date(
      Date.parse(timestamp ?? "") + 60_000,
    ).toISOString();

    await run(
      "git",
      [
        "-C",
        repo.dataRoot,
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

    const result = await stage2(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Filed:");
    expect(result.err).toContain(
      "warning: the data repo changed after the saved answer",
    );
  });

  it("exits 1 with the agent error when the agent fails", async () => {
    const repo = await makeRepo();

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nprocess.exit(4);\n",
      { mode: 0o755 },
    );

    const result = await stage1(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("code 4");
  });
});
