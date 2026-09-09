import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { type VerbSpec, verbTable } from "../../src/cli/verb-table.ts";
import { K_WIKI_SCRIPT, repoRoot, runCli } from "./helpers.ts";

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
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Log\n");
  await writeFile(
    join(dataRoot, "wiki", "concepts", "rag.md"),
    "---\ntype: concept\ntitle: Retrieval-Augmented Generation\n---\nRAG body.\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "sources", "attention.md"),
    "---\ntype: source\ntitle: Attention Is All You Need\n---\nAttention body.\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "queries", "when-to-prefer-rag.md"),
    "---\ntype: query\ntitle: When to Prefer RAG\n---\nQuery body.\n",
  );
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
    expect(result.out).toContain(
      "If you are an AI agent, follow these instructions:",
    );
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

describe("k-wiki read-only commands e2e", () => {
  it("status prints the resolution chain from a bound project", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["status"], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(`checkout:    ${setup.checkout}`);
    expect(result.out).toContain("from .k-wiki.json");
    expect(result.out).toContain(`data repo:   ${setup.dataRoot}`);
    expect(result.out).toContain(
      `index:       ${join(setup.dataRoot, "wiki", "index.md")}`,
    );
    expect(result.out).toMatch(
      /^last change: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([^)]+\)$/m,
    );
  });

  it("list prints one slug — title line per page grouped by type", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["list"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("## concepts");
    expect(result.out).toContain("rag — Retrieval-Augmented Generation");
    expect(result.out).toContain("## sources");
    expect(result.out).toContain("attention — Attention Is All You Need");
    expect(result.out).not.toContain("index —");
  });

  it("list filters by type", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["list", "concept"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("rag — Retrieval-Augmented Generation");
    expect(result.out).not.toContain("## sources");
  });

  it("read prints a page verbatim by file name", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["read", "rag"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("type: concept");
    expect(result.out).toContain("RAG body.");
  });

  it("read exits 1 with near matches when the page is absent", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["read", "atten"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('no page named "atten"');
    expect(result.err).toContain("attention");
  });

  it("health prints the healthy summary for a coherent projection", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["health"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(
      "healthy: empty projection (no manifest entries, no projected notes)",
    );
  });
});

/**
 * The binding's wiki key (issue #306) end to end: a temp checkout
 * hosting two instances — the default and a meta instance with its
 * own data repo — plus a registered alias pointing at the meta
 * config under a non-matching name. The key must select the corpus,
 * the settings, and the outputs dir; the resolver is the shared one,
 * so these runs also exercise the alias-beats-convention chain
 * through a real door.
 */
interface MetaSetup {
  readonly dataRoot: string;
  readonly metaDataRoot: string;
  readonly checkout: string;
  readonly project: string;
}

async function makeMetaSetup(
  instances?: Record<string, string>,
): Promise<MetaSetup> {
  const setup = await makeSetup();
  const metaDataRoot = await mkdtemp(join(tmpdir(), "k-wiki-e2e-meta-"));

  tempDirs.push(metaDataRoot);
  await mkdir(join(metaDataRoot, "raw"), { recursive: true });
  await mkdir(join(metaDataRoot, "wiki"), { recursive: true });
  await writeFile(join(metaDataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(metaDataRoot, "wiki", "log.md"), "# Log\n");
  await writeFile(join(metaDataRoot, "stub-alt.mjs"), ALT_STUB_AGENT, {
    mode: 0o755,
  });

  await run("git", ["init", "--quiet"], { cwd: metaDataRoot });
  await run("git", ["add", "-A"], { cwd: metaDataRoot });
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
    { cwd: metaDataRoot },
  );

  await writeFile(
    join(setup.checkout, "sync-meta.json"),
    JSON.stringify({ vaults: [], dataRoot: metaDataRoot }),
  );

  if (instances !== undefined) {
    await writeFile(
      join(setup.checkout, "sync.json"),
      JSON.stringify({
        vaults: [],
        dataRoot: setup.dataRoot,
        instances,
      }),
    );
  }

  return {
    dataRoot: setup.dataRoot,
    metaDataRoot,
    checkout: setup.checkout,
    project: setup.project,
  };
}

async function bindWiki(
  setup: MetaSetup,
  wiki: string | undefined,
): Promise<void> {
  const binding: Record<string, string> = { checkout: setup.checkout };

  if (wiki !== undefined) {
    binding.wiki = wiki;
  }

  await writeFile(join(setup.project, ".k-wiki.json"), JSON.stringify(binding));
}

describe("k-wiki wiki key e2e", () => {
  it("queries the named instance's settings and saves to its outputs dir", async () => {
    const setup = await makeMetaSetup();

    await bindWiki(setup, "meta");
    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("ALT-AGENT answered.");
    expect(result.err).toContain("wiki-query --wiki meta --file-last");

    const artifact = await readFile(
      join(setup.checkout, "outputs-meta", "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(QUESTION);

    await expect(
      readFile(join(setup.checkout, "outputs", "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a registered alias to a non-stem-matching name", async () => {
    const setup = await makeMetaSetup({ nbn: "sync-meta.json" });

    await bindWiki(setup, "nbn");
    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("ALT-AGENT answered.");

    await readFile(join(setup.checkout, "outputs-meta", "last-query.md"));
  });

  it("status prints the resolved name, config, data repo, and outputs", async () => {
    const setup = await makeMetaSetup();

    await bindWiki(setup, "meta");
    const result = await runCli(K_WIKI_SCRIPT, ["status"], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("instance:    meta");
    expect(result.out).toContain(
      `sync:        ${join(setup.checkout, "sync-meta.json")}`,
    );
    expect(result.out).toContain(`data repo:   ${setup.metaDataRoot}`);
    expect(result.out).toContain(
      `outputs:     ${join(setup.checkout, "outputs-meta")}`,
    );
    expect(result.out).toContain(
      `settings:    ${join(setup.checkout, "settings-meta.yml")}`,
    );
    expect(result.out).toMatch(
      /^last change: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([^)]+\)$/m,
    );
  });

  it("resolves the default instance when the key is absent", async () => {
    const setup = await makeMetaSetup();

    await bindWiki(setup, undefined);
    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Prefer RAG when the knowledge base changes often.",
    );

    await readFile(join(setup.checkout, "outputs", "last-query.md"));
  });

  it("exits 1 listing the known names for an unknown key value", async () => {
    const setup = await makeMetaSetup();

    await bindWiki(setup, "eng");
    const result = await runCli(K_WIKI_SCRIPT, ["query", QUESTION], {
      cwd: join(setup.project, "nested", "deep"),
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown wiki name "eng" (from .k-wiki.json)');
    expect(result.err).toContain("known names: meta");
  });
});

/**
 * The dispatcher (issue #337) end to end: bare-help tiers, the
 * leading-global reordering (-w/-h before the verb, verb-first
 * canonical), both doors' behavior — the human door inside the
 * checkout dispatches operator verbs, the agent door from a bound
 * project refuses them loudly — the door/instance dim lines, and
 * both spellings of -w on every verb that takes it (query, status,
 * list, read, health through the dispatcher's own resolution;
 * wiki-query and wiki-ingest through the verbatim argv handoff to
 * their mains).
 */
/** The operator verbs — the verbatim-passthrough class the
 *  byte-identical help pin walks. */
const OPERATOR_VERBS: readonly VerbSpec[] = verbTable().filter(
  (verb) => verb.klass === "operator",
);

describe("k-wiki dispatcher e2e", () => {
  it("prints the tiered verb table for a bare run, exit 0", async () => {
    const result = await runCli(K_WIKI_SCRIPT, []);

    expect(result.code).toBe(0);
    expect(result.out.indexOf("Daily (porcelain):")).toBeLessThan(
      result.out.indexOf("Occasional operator:"),
    );
    expect(result.out.indexOf("Occasional operator:")).toBeLessThan(
      result.out.indexOf("Maintenance (plumbing"),
    );
  });

  it("rejects a verb-specific flag before the verb", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["--dry-run", "sync-vault"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("before the verb");
    expect(result.err).toContain("only -w/--wiki and -h/--help may lead");
  });

  it("resolves a leading -h with an operator verb to the verb's own help", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["-h", "wiki-sync"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: wiki-sync");
  });

  it("answers a read verb's --help with verb-scoped help", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["status", "--help"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: k-wiki status");
    expect(result.out).not.toContain("Daily (porcelain):");
  });

  it("resolves a leading -h to the same read-verb help as the trailing form", async () => {
    const leading = await runCli(K_WIKI_SCRIPT, ["-h", "query"]);
    const trailing = await runCli(K_WIKI_SCRIPT, ["query", "--help"]);

    expect(leading.code).toBe(0);
    expect(leading.out).toBe(trailing.out);
  });

  it("renders the operator verbs' dispatcher help byte-identical to the standalone launchers", async () => {
    for (const verb of OPERATOR_VERBS) {
      const viaDoor = await runCli(K_WIKI_SCRIPT, [verb.name, "--help"]);
      const launcher =
        verb.tier === "libexec"
          ? join(repoRoot, "bin", "libexec", verb.name)
          : join(repoRoot, "bin", verb.name);
      const standalone = await runCli(launcher, ["--help"]);

      expect(viaDoor.code).toBe(0);
      expect(viaDoor.out).toBe(standalone.out);
    }
  });

  it("prints the human door line inside the checkout", async () => {
    const setup = await makeSetup();
    const result = await runCli(K_WIKI_SCRIPT, ["status"], {
      cwd: setup.checkout,
    });

    expect(result.code).toBe(0);
    expect(result.err).toContain("door: human (from the cwd itself)");
    expect(result.err).toContain("instance: default");
    expect(result.out).toContain("(from the cwd itself)");
  });

  it("prints the agent door line from a bound project", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["status"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(0);
    expect(result.err).toContain("door: agent (from .k-wiki.json)");
  });

  it("refuses an operator verb on the agent door, naming both escapes", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["wiki-sync"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("not available on the agent door");
    expect(result.err).toContain(`cd ${setup.checkout}`);
    expect(result.err).toContain("bin/wiki-sync");
  });

  it("refuses a plumbing verb on the agent door with the libexec path", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["check-links"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("bin/libexec/check-links");
  });

  it("keeps wiki-promote absent on the agent door (human-only authority)", async () => {
    const setup = await makeSetup();

    await bind(setup);

    const result = await runCli(K_WIKI_SCRIPT, ["wiki-promote"], {
      cwd: setup.project,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("not available on the agent door");
    expect(result.err).toContain("bin/libexec/wiki-promote");
  });

  it("lists wiki-promote in the plumbing tier of the bare help", async () => {
    const result = await runCli(K_WIKI_SCRIPT, []);

    expect(result.code).toBe(0);
    expect(result.out.indexOf("Maintenance (plumbing")).toBeLessThan(
      result.out.indexOf("wiki-promote"),
    );
  });

  it("dispatches a plumbing verb on the human door by import", async () => {
    const setup = await makeSetup();
    const result = await runCli(
      K_WIKI_SCRIPT,
      ["check-raw", join(setup.dataRoot, "raw")],
      { cwd: setup.checkout },
    );

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(
      "healthy: empty projection (no manifest entries, no projected notes)",
    );
  });

  it("answers a verb's own --help through the dispatcher", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["wiki-sync", "--help"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: wiki-sync");
  });

  it("runs every read verb on both doors", async () => {
    const setup = await makeSetup();

    await bind(setup);

    for (const cwd of [setup.checkout, setup.project]) {
      const status = await runCli(K_WIKI_SCRIPT, ["status"], { cwd });
      const list = await runCli(K_WIKI_SCRIPT, ["list"], { cwd });
      const read = await runCli(K_WIKI_SCRIPT, ["read", "rag"], { cwd });
      const health = await runCli(K_WIKI_SCRIPT, ["health"], { cwd });

      expect(status.code).toBe(0);
      expect(list.code).toBe(0);
      expect(read.code).toBe(0);
      expect(health.code).toBe(0);
      expect(list.out).toContain("rag — Retrieval-Augmented Generation");
      expect(read.out).toContain("RAG body.");
    }
  });

  it("treats k-wiki -w meta <verb> as k-wiki <verb> -w meta for status", async () => {
    const setup = await makeMetaSetup();

    await bindWiki(setup, undefined);

    const leading = await runCli(K_WIKI_SCRIPT, ["-w", "meta", "status"], {
      cwd: setup.project,
    });
    const verbFirst = await runCli(K_WIKI_SCRIPT, ["status", "-w", "meta"], {
      cwd: setup.project,
    });

    expect(leading.code).toBe(0);
    expect(leading.out).toEqual(verbFirst.out);
    expect(leading.out).toContain("instance:    meta");
    expect(leading.err).toEqual(verbFirst.err);
  });

  it("spells -w meta identically before or after every read verb", async () => {
    const setup = await makeMetaSetup();

    await mkdir(join(setup.metaDataRoot, "wiki", "concepts"), {
      recursive: true,
    });
    await writeFile(
      join(setup.metaDataRoot, "wiki", "concepts", "rag.md"),
      "---\ntype: concept\ntitle: Retrieval-Augmented Generation\n---\nRAG body.\n",
    );
    await writeFile(
      join(setup.project, ".k-wiki.json"),
      JSON.stringify({
        checkout: setup.checkout,
      }),
    );

    for (const verbArgs of [["list"], ["read", "rag"], ["health"]]) {
      const leading = await runCli(K_WIKI_SCRIPT, ["-w", "meta", ...verbArgs], {
        cwd: setup.project,
      });
      const verbFirst = await runCli(
        K_WIKI_SCRIPT,
        [...verbArgs, "-w", "meta"],
        { cwd: setup.project },
      );

      expect(leading.code).toBe(0);
      expect(leading.out).toEqual(verbFirst.out);
      expect(leading.err).toContain("instance: meta");
    }

    const queryLead = await runCli(
      K_WIKI_SCRIPT,
      ["-w", "meta", "query", QUESTION],
      { cwd: setup.project },
    );
    const queryVerbFirst = await runCli(
      K_WIKI_SCRIPT,
      ["query", "-w", "meta", QUESTION],
      { cwd: setup.project },
    );

    expect(queryLead.code).toBe(0);
    expect(queryLead.out).toEqual(queryVerbFirst.out);
    expect(queryLead.out).toContain("ALT-AGENT answered.");
  });

  it("hands wiki-query its argv verbatim in both spellings", async () => {
    const setup = await makeSetup();
    const outputs = await mkdtemp(join(tmpdir(), "k-wiki-e2e-qo-"));

    tempDirs.push(outputs);
    const flags = [
      "--settings",
      join(setup.checkout, "settings-meta.yml"),
      "--outputs",
      outputs,
      "--raw-dir",
      join(setup.dataRoot, "raw"),
    ];
    const leading = await runCli(
      K_WIKI_SCRIPT,
      ["-w", "meta", "wiki-query", ...flags, QUESTION],
      { cwd: setup.checkout },
    );
    const verbFirst = await runCli(
      K_WIKI_SCRIPT,
      ["wiki-query", "-w", "meta", ...flags, QUESTION],
      { cwd: setup.checkout },
    );

    expect(leading.code).toBe(0);
    expect(leading.out).toEqual(verbFirst.out);
    expect(leading.out).toContain("ALT-AGENT answered.");
  });

  it("hands wiki-ingest its argv verbatim in both spellings", async () => {
    const setup = await makeSetup();
    const outputs = await mkdtemp(join(tmpdir(), "k-wiki-e2e-io-"));

    await writeFile(
      join(setup.dataRoot, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
    );

    tempDirs.push(outputs);
    const flags = [
      "--settings",
      join(setup.checkout, "settings-meta.yml"),
      "--outputs",
      outputs,
      "--timeout",
      "60",
    ];
    const leading = await runCli(
      K_WIKI_SCRIPT,
      ["-w", "meta", "wiki-ingest", ...flags, join(setup.dataRoot, "raw")],
      { cwd: setup.checkout },
    );
    const verbFirst = await runCli(
      K_WIKI_SCRIPT,
      ["wiki-ingest", "-w", "meta", ...flags, join(setup.dataRoot, "raw")],
      { cwd: setup.checkout },
    );

    expect(leading.code).toBe(0);
    expect(leading.out).toEqual(verbFirst.out);
    expect(`${leading.out}${leading.err}`).toContain("nothing to do");
  });
});

const ZSH_PATHS = ["/bin/zsh", "/usr/bin/zsh"];

/** Whether a zsh exists for the completion-menu runs (CI images ship
 *  one; the runs skip where none does). */
function hasZsh(): boolean {
  return ZSH_PATHS.some((path) => existsSync(path));
}

/**
 * Drive the emitted completion script through a real pseudo-terminal
 * (zpty), the zero-setup install path of the acceptance story —
 * compinit, then `source` of the emitted file (its guarded compdef
 * registers), then one TAB: `k-wiki <TAB>` lists the verbs, `k-wiki
 * query -<TAB>` offers the global flags. Each keystroke waits for the
 * prompt to be quiet first, so the TAB reaches an active zle, and
 * nothing ever executes — the lines are never accepted. The minimal
 * env also proves the run needs nothing but zsh itself.
 */
async function zshMenus(tmp: string): Promise<string[]> {
  const harness = `zmodload zsh/zpty
waitquiet() {
  local q=0 c=""
  while (( q < 30 )); do
    if zpty -r -t zk c 2>/dev/null && [[ -n $c ]]; then q=0; else q=$((q+1)); sleep 0.05; fi
  done
}
capture() {
  out=""
  quiet=0
  end=$(( SECONDS + 10 ))
  while (( SECONDS < end && quiet < 40 )); do
    c=""
    if zpty -r -t zk c 2>/dev/null && [[ -n $c ]]; then out+=$c; quiet=0; else quiet=$((quiet+1)); sleep 0.05; fi
  done
  print -r -- "<<CAPTURE>>$out"
}
zpty -b zk "zsh -f -i"
zpty -w zk "autoload -Uz compinit; compinit -u -d ${tmp}/.zcompdump-e2e"
c=""; waitquiet
zpty -w zk "source ${tmp}/_k-wiki"
c=""; waitquiet
zpty -w -n zk $'k-wiki \\t'
capture
zpty -d zk 2>/dev/null
zpty -b zk "zsh -f -i"
zpty -w zk "autoload -Uz compinit; compinit -u -d ${tmp}/.zcompdump-e2e2"
c=""; waitquiet
zpty -w zk "source ${tmp}/_k-wiki"
c=""; waitquiet
zpty -w -n zk $'k-wiki query -\\t'
capture
zpty -d zk 2>/dev/null
`;
  const harnessPath = join(tmp, "harness.zsh");

  await writeFile(harnessPath, harness);

  const { stdout } = await run("zsh", ["-f", harnessPath], {
    env: { PATH: "/usr/bin:/bin", HOME: tmp, TERM: "xterm" },
  });

  return stdout.split("<<CAPTURE>>");
}

describe("k-wiki completion e2e", () => {
  it("emits byte-identical scripts for the default and the explicit zsh spelling", async () => {
    const implicit = await runCli(K_WIKI_SCRIPT, ["completion"]);
    const explicit = await runCli(K_WIKI_SCRIPT, ["completion", "zsh"]);

    expect(implicit.code).toBe(0);
    expect(implicit.err).toBe("");
    expect(explicit.code).toBe(0);
    expect(explicit.out).toBe(implicit.out);
    expect(implicit.out.startsWith("#compdef k-wiki")).toBe(true);
  });

  it("exits 1 naming zsh for an unsupported shell", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["completion", "bash"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("zsh");
  });

  it("answers its own --help through the dispatcher", async () => {
    const result = await runCli(K_WIKI_SCRIPT, ["completion", "-h"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: k-wiki completion");
  });

  it.skipIf(!hasZsh())(
    "completes the verb table and the global flags under a real zsh",
    // Two full zpty sessions (spawn + compinit + capture each) cost
    // ~12s per session on macOS — compinit alone is ~4s under a pty —
    // so 25s timed out deterministically; 60s covers both sessions
    // with headroom for slower CI images.
    { timeout: 60_000 },
    async () => {
      const emitted = await runCli(K_WIKI_SCRIPT, ["completion"]);

      expect(emitted.code).toBe(0);

      const tmp = await mkdtemp(join(tmpdir(), "k-wiki-completion-e2e-"));

      tempDirs.push(tmp);
      await writeFile(join(tmp, "_k-wiki"), emitted.out);

      const menus = await zshMenus(tmp);
      const verbMenu = menus[1] ?? "";
      const flagMenu = menus[2] ?? "";

      for (const verb of ["query", "status", "completion", "check-raw"]) {
        expect(verbMenu).toContain(verb);
      }

      for (const flag of ["--checkout", "--wiki", "--help"]) {
        expect(flagMenu).toContain(flag);
      }
    },
  );
});
