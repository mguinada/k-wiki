import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { K_WIKI_SCRIPT, repoRoot, runCli } from "./helpers.ts";

/**
 * propose e2e (issue #340): the agent write verb as a real k-wiki
 * child process from a bound project — redirect-not-reject made
 * user-visible. The stub agent receives the exact prompt the real
 * agent would and files the note from it; the flows pin the issue's
 * acceptance: a sandbox-only run lands as one stamped commit, a
 * main-tree write reverts the run and fails loudly, the instance
 * resolves through the verb's own chain (the binding's wiki key —
 * and -w beating it in both positions), stdin works, and the verb
 * answers its own help.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The filing stub: parses the prompt exactly as the real agent
 *  reads it — target path plus the fenced note — and writes those
 *  bytes, nothing else. */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

const root = process.cwd();
const target = /^Target path: (.+)$/m.exec(prompt)?.[1];
const note = /-----BEGIN NOTE-----\\n([\\s\\S]*?)\\n-----END NOTE-----/m.exec(
  prompt,
)?.[1];

if (target === undefined || note === undefined) {
  process.exit(4);
}

const file = join(root, target);

await mkdir(dirname(file), { recursive: true });
await writeFile(file, note);
console.log("stub filed the candidate");
`;

/** The rogue stub: files the note but also mangles wiki/index.md —
 *  the gate must revert the run and fail it loudly. */
const ROGUE_STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

const root = process.cwd();
const target = /^Target path: (.+)$/m.exec(prompt)?.[1];

if (target === undefined) {
  process.exit(4);
}

const file = join(root, target);

await mkdir(dirname(file), { recursive: true });
await writeFile(file, "sandbox note\\n");
await writeFile(join(root, "wiki", "index.md"), "# Index (mangled)\\n");
console.log("rogue stub ran");
`;

/** The idle stub: writes nothing at all — an empty run. */
const IDLE_STUB = `#!/usr/bin/env node
console.log("idle stub ran");
`;

interface Setup {
  readonly dataRoot: string;
  readonly checkout: string;
  readonly project: string;
}

/** One data repo initialized as git with a committed index. */
async function makeDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-propose-e2e-"));

  tempDirs.push(dataRoot);
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
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

  return dataRoot;
}

/** A checkout over the data repo: sync.json, the three stubs as
 *  settings files, and the shipped propose prompt. The stub
 *  scripts live in the checkout — the data repo starts clean. */
async function makeSetup(): Promise<Setup> {
  const dataRoot = await makeDataRoot();
  const checkout = await mkdtemp(join(tmpdir(), "k-wiki-propose-co-"));

  tempDirs.push(checkout);
  await writeFile(join(checkout, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await writeFile(join(checkout, "rogue-stub.mjs"), ROGUE_STUB, {
    mode: 0o755,
  });
  await writeFile(join(checkout, "idle-stub.mjs"), IDLE_STUB, {
    mode: 0o755,
  });
  await writeFile(
    join(checkout, "sync.json"),
    JSON.stringify({ vaults: [], dataRoot }),
  );
  await writeFile(
    join(checkout, "settings.yml"),
    `command: ${join(checkout, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );
  await writeFile(
    join(checkout, "settings-rogue.yml"),
    `command: ${join(checkout, "rogue-stub.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );
  await writeFile(
    join(checkout, "settings-idle.yml"),
    `command: ${join(checkout, "idle-stub.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );
  await mkdir(join(checkout, "prompts"), { recursive: true });
  await writeFile(
    join(checkout, "prompts", "propose.md"),
    await readFile(join(repoRoot, "prompts", "propose.md"), "utf8"),
  );

  const project = await mkdtemp(join(tmpdir(), "k-wiki-propose-proj-"));

  tempDirs.push(project);

  return { dataRoot, checkout, project };
}

/** Bind the project to the checkout, optionally selecting an
 *  instance and/or a settings file. */
async function bind(
  setup: Setup,
  keys: { readonly wiki?: string; readonly settings?: string } = {},
): Promise<void> {
  await writeFile(
    join(setup.project, ".k-wiki.json"),
    JSON.stringify({ checkout: setup.checkout, ...keys }),
  );
}

/** A second data repo + a sync-<name>.json stem in the checkout. */
async function addInstance(setup: Setup, name: string): Promise<string> {
  const dataRoot = await makeDataRoot();

  await writeFile(
    join(setup.checkout, `sync-${name}.json`),
    JSON.stringify({ vaults: [], dataRoot }),
  );
  await writeFile(
    join(setup.checkout, `settings-${name}.yml`),
    `command: ${join(setup.checkout, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return dataRoot;
}

const NOTE_FILE_BODY = "Prefer RAG when the knowledge base changes often.\n";

describe("k-wiki propose e2e", () => {
  it("answers its own -h with usage and exit 0", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["propose", "-h"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: k-wiki propose");
    expect(result.out).toContain("--type <type>");
  });

  it("exits 1 with the slug usage error when the slug is missing", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["propose"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("a <slug> is required");
  });

  it("files one candidate from a bound project with only sandbox deltas", async () => {
    const setup = await makeSetup();

    await bind(setup);
    await writeFile(join(setup.project, "note.md"), NOTE_FILE_BODY);

    const result = await runCli(
      K_WIKI_SCRIPT,
      ["propose", "when-to-prefer-rag", "note.md"],
      { cwd: setup.project },
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("proposed wiki/sandbox/when-to-prefer-rag.md");
    expect(result.err).toContain("door: agent (from .k-wiki.json)");
    expect(result.err).toContain("instance: default");

    const note = await readFile(
      join(setup.dataRoot, "wiki", "sandbox", "when-to-prefer-rag.md"),
      "utf8",
    );

    expect(note).toContain('title: "when-to-prefer-rag"');
    expect(note).toContain("type: query");
    expect(note).toContain("via: agent");
    expect(note).toMatch(/expires: \d{4}-\d{2}-\d{2}/);
    expect(note).toContain("Prefer RAG when the knowledge base changes often.");

    const logMd = await readFile(
      join(setup.dataRoot, "wiki", "log.md"),
      "utf8",
    );

    expect(logMd).toMatch(
      /## \[\d{4}-\d{2}-\d{2}\] sandbox \| when-to-prefer-rag/,
    );

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: setup.dataRoot,
    });

    expect(subjects.trim().split("\n")).toEqual([
      "sandbox: when-to-prefer-rag",
      "init",
    ]);

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: setup.dataRoot },
    );

    expect(status).toBe("");
  });

  it("reverts a main-tree write and fails loudly", async () => {
    const setup = await makeSetup();

    await bind(setup, { settings: "settings-rogue.yml" });
    await writeFile(join(setup.project, "note.md"), NOTE_FILE_BODY);

    const result = await runCli(
      K_WIKI_SCRIPT,
      ["propose", "rogue-note", "note.md"],
      { cwd: setup.project },
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain("accept-gate failed");
    expect(result.err).toContain("wiki/index.md");

    expect(
      await readFile(join(setup.dataRoot, "wiki", "index.md"), "utf8"),
    ).toBe("# Index\n");
    await expect(
      readFile(join(setup.dataRoot, "wiki", "sandbox", "rogue-note.md")),
    ).rejects.toThrow();

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: setup.dataRoot,
    });

    expect(subjects.trim()).toBe("init");
  });

  it("exits 1 when the agent run writes nothing", async () => {
    const setup = await makeSetup();

    await bind(setup, { settings: "settings-idle.yml" });
    await writeFile(join(setup.project, "note.md"), NOTE_FILE_BODY);

    const result = await runCli(
      K_WIKI_SCRIPT,
      ["propose", "idle-note", "note.md"],
      { cwd: setup.project },
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain("wrote nothing");

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: setup.dataRoot },
    );

    expect(status).toBe("");
  });

  it("reads the note body from stdin", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["propose", "stdin-note"], {
      cwd: setup.project,
      input: "Piped body.\n",
    });

    expect(result.code).toBe(0);

    const note = await readFile(
      join(setup.dataRoot, "wiki", "sandbox", "stdin-note.md"),
      "utf8",
    );

    expect(note).toContain("Piped body.");
  });

  it("lands the note in the binding's named instance, not the default repo", async () => {
    const setup = await makeSetup();
    const metaDataRoot = await addInstance(setup, "meta");

    await bind(setup, { wiki: "meta" });
    await writeFile(join(setup.project, "note.md"), NOTE_FILE_BODY);

    const result = await runCli(
      K_WIKI_SCRIPT,
      ["propose", "meta-note", "note.md"],
      { cwd: setup.project },
    );

    expect(result.code).toBe(0);
    expect(result.err).toContain("instance: meta");

    const note = await readFile(
      join(metaDataRoot, "wiki", "sandbox", "meta-note.md"),
      "utf8",
    );

    expect(note).toContain("via: agent");

    await expect(
      readFile(join(setup.dataRoot, "wiki", "sandbox", "meta-note.md")),
    ).rejects.toThrow();
  });

  it("lets -w override the binding's wiki key in both positions", async () => {
    const setup = await makeSetup();
    const metaDataRoot = await addInstance(setup, "meta");
    const engDataRoot = await addInstance(setup, "eng");

    await bind(setup, { wiki: "meta" });
    await writeFile(join(setup.project, "note.md"), NOTE_FILE_BODY);

    const leading = await runCli(
      K_WIKI_SCRIPT,
      ["-w", "eng", "propose", "eng-note", "note.md"],
      { cwd: setup.project },
    );
    const verbFirst = await runCli(
      K_WIKI_SCRIPT,
      ["propose", "-w", "eng", "eng-note-2", "note.md"],
      { cwd: setup.project },
    );

    expect(leading.code).toBe(0);
    expect(verbFirst.code).toBe(0);
    expect(leading.err).toContain("instance: eng");
    expect(verbFirst.err).toContain("instance: eng");

    await expect(
      readFile(join(engDataRoot, "wiki", "sandbox", "eng-note.md"), "utf8"),
    ).resolves.toContain("via: agent");
    await expect(
      readFile(join(engDataRoot, "wiki", "sandbox", "eng-note-2.md"), "utf8"),
    ).resolves.toContain("via: agent");
    await expect(
      readFile(join(metaDataRoot, "wiki", "sandbox", "eng-note.md")),
    ).rejects.toThrow();
  });
});
