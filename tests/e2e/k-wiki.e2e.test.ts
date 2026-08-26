import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { K_WIKI_SCRIPT, runCli } from "./helpers.ts";

/**
 * k-wiki e2e (issue #76): the agent-facing query entry point as a
 * real child process, run from a bound project directory — zero
 * flags. The stub agent is driven through the checkout's
 * settings.yml exactly as a real agent would be. The answer-only
 * enforcement (#72) is verified end to end: a rogue stub that writes
 * under wiki/ is caught, reverted, and failed.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const STUB_AGENT = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];
if (prompt === undefined || prompt === "") {
  process.exit(3);
}
await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);
console.log("Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].");
`;

const ALT_STUB_AGENT = `#!/usr/bin/env node
console.log("ALT-AGENT answered.");
`;

const ROGUE_STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "queries", "rogue.md"), "rogue");
console.log("An answer.");
`;

interface Setup {
  readonly dataRoot: string;
  readonly checkout: string;
  readonly project: string;
}

/** A data repo (git-tracked wiki/, raw/), a checkout, a project dir. */
async function makeSetup(): Promise<Setup> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-e2e-data-"));

  tempDirs.push(dataRoot);
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Log\n");
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await writeFile(join(dataRoot, "stub-alt.mjs"), ALT_STUB_AGENT, {
    mode: 0o755,
  });

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

  const checkout = await mkdtemp(join(tmpdir(), "k-wiki-e2e-co-"));

  tempDirs.push(checkout);
  await writeFile(
    join(checkout, "sync.json"),
    JSON.stringify({ vaults: [], dataRoot }),
  );
  await writeFile(
    join(checkout, "settings.yml"),
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );
  await writeFile(
    join(checkout, "settings-meta.yml"),
    `command: ${join(dataRoot, "stub-alt.mjs")}\nmodel: ALT\nreasoning: low\n`,
  );
  await mkdir(join(checkout, "prompts"), { recursive: true });
  await writeFile(join(checkout, "prompts", "query.md"), "QUERY PROMPT");
  await mkdir(join(checkout, "outputs"), { recursive: true });

  const project = await mkdtemp(join(tmpdir(), "k-wiki-e2e-proj-"));

  tempDirs.push(project);
  await mkdir(join(project, "nested", "deep"), { recursive: true });

  return { dataRoot, checkout, project };
}

/** Bind a project to a checkout (optionally with a settings file). */
async function bind(setup: Setup, settings?: string): Promise<void> {
  const binding: Record<string, string> = { checkout: setup.checkout };

  if (settings !== undefined) {
    binding.settings = settings;
  }

  await writeFile(join(setup.project, ".k-wiki.json"), JSON.stringify(binding));
}

async function wikiStatus(setup: Setup): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-C", setup.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
    { env: process.env },
  );

  return stdout.trim();
}

const QUESTION = "When should I prefer RAG over fine-tuning?";

describe("k-wiki e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: k-wiki/);
    expect(result.out).toContain(".k-wiki.json");
    expect(result.out).toContain("K_WIKI_CHECKOUT");
    expect(result.out).toContain("If you are an AI agent, follow these instructions:");
    expect(result.out).not.toContain("--file-last <");
  });

  it("queries from a bound project subdirectory with zero flags", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );
    expect(result.err).toContain("To file this answer");
    expect(await wikiStatus(setup)).toBe("");

    const artifact = await readFile(
      join(setup.checkout, "outputs", "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(`question: "${QUESTION}"`);

    const prompt = await readFile(
      join(setup.dataRoot, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain(`Question: ${QUESTION}`);
    expect(prompt).toContain("Mode: answer-only");
  });

  it("reverts and exits 1 when the agent writes under wiki/ (#72 enforcement)", async () => {
    const setup = await makeSetup();

    await bind(setup);
    await writeFile(join(setup.dataRoot, "stub-agent.mjs"), ROGUE_STUB, {
      mode: 0o755,
    });

    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("reverted");
    expect(await wikiStatus(setup)).toBe("");

    await expect(
      readFile(join(setup.checkout, "outputs", "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors the binding's settings override for a second wiki", async () => {
    const setup = await makeSetup();

    await bind(setup, "settings-meta.yml");

    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: setup.project,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("ALT-AGENT answered.");
  });

  it("resolves the checkout from the env var without a binding", async () => {
    const setup = await makeSetup();
    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: setup.project,
      env: { K_WIKI_CHECKOUT: setup.checkout },
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );
  });

  it("rejects a multi-wiki binding with a clear error", async () => {
    const setup = await makeSetup();

    await writeFile(
      join(setup.project, ".k-wiki.json"),
      JSON.stringify([{ checkout: setup.checkout }, { checkout: "/other" }]),
    );

    const result = await runCli(K_WIKI_SCRIPT, ["query", "q"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("one project binds exactly one wiki");
  });

  it("falls back to the cwd when run inside the checkout itself", async () => {
    const setup = await makeSetup();
    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: setup.checkout,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );

    const artifact = await readFile(
      join(setup.checkout, "outputs", "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(`question: "${QUESTION}"`);
  });

  it("rejects the filing passthrough switch", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["query", "--file-last"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--file-last");
  });
});
