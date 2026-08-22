import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { QUERY_SCRIPT, runCli } from "./helpers.ts";

/**
 * wiki-query e2e: the real CLI as a child process, driving a stub
 * agent through both modes. The stub receives the exact argv the real
 * agent would (pi flags from settings.yml), inspects the composed
 * prompt to learn the mode, files a query page like the real agent in
 * file mode, writes nothing in answer-only mode, and ends its output
 * with the QUERY status line the wrapper parses. A real LLM run stays
 * a human check (issue #67 acceptance): it costs money and is not
 * deterministic.
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
 * name it as the command. It records the --print payload, then files
 * a query page (file mode) or writes nothing (answer-only mode), and
 * answers with the trailing QUERY status line. Exits 3 when the
 * payload is missing — the wrapper must pass the prompt.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);

if (prompt.includes("answer-only")) {
  console.log("Graph engineering is the discipline of…\\n\\nQUERY: meets-bar — synthesizes 3 pages");
} else {
  await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
  await writeFile(
    join(process.cwd(), "wiki", "queries", "rag-vs-finetuning.md"),
    "---\\ntype: query\\n---\\nPrefer RAG when…\\n",
  );
  await writeFile(join(process.cwd(), "wiki", "index.md"), "# Index v2\\n");
  await appendFile(join(process.cwd(), "wiki", "log.md"), "- filed rag-vs-finetuning\\n");
  console.log("Prefer RAG when the knowledge base changes often.\\n\\nQUERY: filed — wiki/queries/rag-vs-finetuning.md");
}
`;

interface Repo {
  readonly dataRoot: string;
  readonly settingsPath: string;
}

/** A temp data repo: git-tracked wiki/, empty raw/, stub agent. */
async function makeRepo(): Promise<Repo> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-query-e2e-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Log\n");
  await writeFile(join(dataRoot, "wiki", "concepts", "rag.md"), "RAG\n");

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

  return { dataRoot, settingsPath };
}

function query(repo: Repo, extra: string[] = []) {
  return runCli(QUERY_SCRIPT, [
    "--settings",
    repo.settingsPath,
    "--raw-dir",
    join(repo.dataRoot, "raw"),
    ...extra,
    "When should I prefer RAG over fine-tuning?",
  ]);
}

describe("wiki-query e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(QUERY_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: wiki-query/);
  });

  it("files the query page and prints the answer with the Filed verdict", async () => {
    const repo = await makeRepo();
    const result = await query(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );
    expect(result.out).toContain("Filed: wiki/queries/rag-vs-finetuning.md");
    expect(result.out).not.toContain("Not filed");
    expect(result.err).toContain("wiki-query: invoking agent");

    const page = await readFile(
      join(repo.dataRoot, "wiki", "queries", "rag-vs-finetuning.md"),
      "utf8",
    );

    expect(page).toContain("type: query");

    const prompt = await readFile(
      join(repo.dataRoot, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("You are answering questions");
    expect(prompt).toContain(
      "Question: When should I prefer RAG over fine-tuning?",
    );
    expect(prompt).toContain("Mode: file");
  });

  it("answers without writing when --no-file is passed", async () => {
    const repo = await makeRepo();
    const result = await query(repo, ["--no-file"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Graph engineering is the discipline of…");
    expect(result.out).toContain(
      "Meets the filing bar (synthesizes 3 pages); rerun without --no-file to file it.",
    );

    const { stdout } = await run(
      "git",
      ["-C", repo.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");

    const prompt = await readFile(
      join(repo.dataRoot, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("Mode: answer-only");
  });

  it("exits 1 with the agent error when the agent fails", async () => {
    const repo = await makeRepo();

    await writeFile(
      join(repo.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nprocess.exit(4);\n",
      { mode: 0o755 },
    );

    const result = await query(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("code 4");
  });
});
