import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runQueryCli } from "../../src/query/query-shell.ts";

/**
 * The shared query CLI shell (finding D-8): one runner owns the sink
 * construction, the runWikiQuery option mapping, the answer print
 * with its dim filing hint, and the red prefixed failure path — the
 * surface k-wiki and wiki-query used to duplicate line-for-line.
 * Only the prefix and the hint text differ between the two CLIs.
 */

const run = promisify(execFile);

const STUB_AGENT = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];
await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt ?? "");
console.log("Prefer RAG when the knowledge base changes often.");
`;

const FAILING_AGENT = `#!/usr/bin/env node
console.error("boom");
process.exit(1);
`;

interface Harness {
  readonly dataRoot: string;
  readonly promptsDir: string;
  readonly outputsDir: string;
  readonly settingsPath: string;
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function makeHarness(agent: string): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-query-shell-"));

  tempDirs.push(dataRoot);

  const promptsDir = join(dataRoot, "prompts");
  const outputsDir = join(dataRoot, "outputs");

  await mkdir(promptsDir, { recursive: true });
  await mkdir(outputsDir, { recursive: true });
  await writeFile(
    join(promptsDir, "query.md"),
    "You answer questions about the wiki.\n",
  );

  const stub = join(dataRoot, "stub-agent.mjs");

  await writeFile(stub, agent, { mode: 0o755 });
  await writeFile(
    join(dataRoot, "settings.yml"),
    `command: ${stub}\nmodel: M\nreasoning: low\n`,
  );

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run(
    "git",
    ["-C", dataRoot, "commit", "--quiet", "--allow-empty", "-m", "seed"],
  );

  return {
    dataRoot,
    promptsDir,
    outputsDir,
    settingsPath: join(dataRoot, "settings.yml"),
  };
}

/** Run the CLI shell in-process, capturing the console. */
async function runShell(
  h: Harness,
  extra: { readonly prefix?: string; readonly hint?: string } = {},
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await runQueryCli({
      prefix: extra.prefix ?? "k-wiki",
      settingsPath: h.settingsPath,
      rawDir: join(h.dataRoot, "raw"),
      promptsDir: h.promptsDir,
      outputsDir: h.outputsDir,
      question: "When should I prefer RAG?",
      hint: extra.hint ?? "To file this answer: wiki-query --file-last",
    });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join("\n"), err: err.join("\n") };
}

describe("runQueryCli", () => {
  it("prints the agent's answer to stdout", async () => {
    const h = await makeHarness(STUB_AGENT);
    const { out } = await runShell(h);

    expect(out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );
  });

  it("prints the caller's filing hint after a blank stderr line", async () => {
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const h = await makeHarness(STUB_AGENT);
      const { err } = await runShell(h, {
        hint: "To file this answer (human step): wiki-query --file-last",
      });

      expect(
        err.includes("\n\nTo file this answer (human step)"),
      ).toBe(true);
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("saves the run to the outputs dir's last-query.md", async () => {
    const h = await makeHarness(STUB_AGENT);

    await runShell(h);

    const artifact = await readFile(
      join(h.outputsDir, "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain('question: "When should I prefer RAG?"');
  });

  it("passes the question to the agent inside the composed prompt", async () => {
    const h = await makeHarness(STUB_AGENT);

    await runShell(h);

    const prompt = await readFile(join(h.dataRoot, "stub-prompt.txt"), "utf8");

    expect(prompt).toContain("Question: When should I prefer RAG?");
  });

  it("prints a failure red under the caller's prefix and sets exit 1", async () => {
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const h = await makeHarness(FAILING_AGENT);
      const { err } = await runShell(h, { prefix: "wiki-query" });

      expect(err).toContain("wiki-query: agent exited with code 1");
      expect(process.exitCode).toBe(1);
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("leaves the exit code unset after a successful run", async () => {
    const h = await makeHarness(STUB_AGENT);

    await runShell(h);

    expect(process.exitCode).toBeUndefined();
  });
});
