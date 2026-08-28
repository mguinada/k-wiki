import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BINDING_FILE,
  CHECKOUT_ENV,
  findBindingFile,
  main,
  parseBinding,
  resolveCheckout,
} from "../src/cli/k-wiki.ts";

const tempDirs: string[] = [];

const run = promisify(execFile);

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("parseBinding", () => {
  it("accepts the single-wiki form and expands ~ in checkout", () => {
    const binding = parseBinding(
      '{ "checkout": "~/k-wiki", "settings": "settings-meta.yml" }',
      "/proj/.k-wiki.json",
      "/home/u",
    );

    expect(binding).toEqual({
      checkout: "/home/u/k-wiki",
      settings: "settings-meta.yml",
    });
  });

  it("makes settings optional", () => {
    const binding = parseBinding(
      '{ "checkout": "/abs/k-wiki" }',
      "/proj/.k-wiki.json",
      "/home/u",
    );

    expect(binding.settings).toBeUndefined();
  });

  it("rejects a top-level array with the one-wiki error", () => {
    expect(() =>
      parseBinding(
        '[{ "checkout": "/a" }, { "checkout": "/b" }]',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow("one project binds exactly one wiki");
  });

  it("rejects a list under checkout", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": ["/a", "/b"] }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"checkout" must be a non-empty string');
  });

  it("rejects unknown keys such as a checkouts list", () => {
    expect(() =>
      parseBinding(
        '{ "checkouts": ["/a", "/b"] }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('unknown key "checkouts"');
  });

  it("names the expected single-object shape when rejecting", () => {
    expect(() =>
      parseBinding('{ "checkouts": ["/a"] }', "/proj/.k-wiki.json", "/home/u"),
    ).toThrow("a single JSON object");
  });

  it("rejects a missing checkout", () => {
    expect(() =>
      parseBinding('{ "settings": "x.yml" }', "/proj/.k-wiki.json", "/home/u"),
    ).toThrow('"checkout" must be a non-empty string');
  });

  it("rejects an empty checkout", () => {
    expect(() =>
      parseBinding('{ "checkout": "" }', "/proj/.k-wiki.json", "/home/u"),
    ).toThrow('"checkout" must be a non-empty string');
  });

  it("rejects text that is not valid JSON", () => {
    expect(() =>
      parseBinding("{ not json", "/proj/.k-wiki.json", "/home/u"),
    ).toThrow("not valid JSON");
  });

  it("carries the JSON syntax error as the rejection cause", () => {
    let thrown: unknown;

    try {
      parseBinding("{ not json", "/proj/.k-wiki.json", "/home/u");
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  });

  it("rejects a non-string settings value", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": "/a", "settings": 3 }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"settings" must be a non-empty string');
  });

  it("rejects an empty settings value", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": "/a", "settings": "" }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"settings" must be a non-empty string');
  });

  it("rejects a null settings value", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": "/a", "settings": null }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"settings" must be a non-empty string');
  });
});

describe("findBindingFile", () => {
  it("finds the binding in the start directory itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(dir);
    await writeFile(join(dir, BINDING_FILE), '{ "checkout": "/a" }');

    expect(await findBindingFile(dir, "/nonexistent/home")).toBe(
      join(dir, BINDING_FILE),
    );
  });

  it("finds the nearest binding walking upward", async () => {
    const base = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(base);
    await mkdir(join(base, "outer", "inner"), { recursive: true });
    await writeFile(
      join(base, "outer", BINDING_FILE),
      '{ "checkout": "/outer" }',
    );
    await writeFile(join(base, BINDING_FILE), '{ "checkout": "/base" }');

    expect(
      await findBindingFile(join(base, "outer", "inner"), "/nonexistent/home"),
    ).toBe(join(base, "outer", BINDING_FILE));
  });

  it("stops at home after checking it", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "k-wiki-home-"));

    tempDirs.push(fakeHome);
    await mkdir(join(fakeHome, "proj"), { recursive: true });
    await writeFile(
      join(fakeHome, BINDING_FILE),
      '{ "checkout": "/home-bound" }',
    );

    expect(await findBindingFile(join(fakeHome, "proj"), fakeHome)).toBe(
      join(fakeHome, BINDING_FILE),
    );
  });

  it("never looks above home", async () => {
    const parent = await mkdtemp(join(tmpdir(), "k-wiki-home-"));
    const fakeHome = join(parent, "home");

    tempDirs.push(parent);
    await mkdir(join(fakeHome, "proj"), { recursive: true });
    await writeFile(
      join(parent, BINDING_FILE),
      '{ "checkout": "/above-home" }',
    );

    expect(await findBindingFile(join(fakeHome, "proj"), fakeHome)).toBe(
      undefined,
    );
  });

  it("climbs toward the root when the start dir is outside home", async () => {
    const base = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(base);
    await mkdir(join(base, "a", "b"), { recursive: true });
    await writeFile(join(base, BINDING_FILE), '{ "checkout": "/base" }');

    expect(
      await findBindingFile(join(base, "a", "b"), "/nonexistent/home"),
    ).toBe(join(base, BINDING_FILE));
  });

  it("returns undefined when no binding exists on the walk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(dir);

    expect(await findBindingFile(dir, "/nonexistent/home")).toBe(undefined);
  });
});

describe("resolveCheckout", () => {
  it("prefers the explicit flag over env and binding file", async () => {
    const h = await makeBoundProject();

    expect(
      await resolveCheckout({
        flag: "/flag/checkout",
        env: { [CHECKOUT_ENV]: h.checkout },
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: "/flag/checkout",
      settings: undefined,
      origin: "flag",
    });
  });

  it("prefers the env var over the binding file", async () => {
    const h = await makeBoundProject();

    expect(
      await resolveCheckout({
        flag: undefined,
        env: { [CHECKOUT_ENV]: "/env/checkout" },
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: "/env/checkout",
      settings: undefined,
      origin: "env",
    });
  });

  it("uses the binding file's checkout and settings before cwd", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.project, BINDING_FILE),
      JSON.stringify({ checkout: h.checkout, settings: "settings-alt.yml" }),
    );

    expect(
      await resolveCheckout({
        flag: undefined,
        env: {},
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: h.checkout,
      settings: "settings-alt.yml",
      origin: "file",
    });
  });

  it("falls back to the cwd when nothing resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-cwd-"));

    tempDirs.push(dir);

    expect(
      await resolveCheckout({
        flag: undefined,
        env: {},
        cwd: dir,
        home: "/nonexistent/home",
      }),
    ).toEqual({ checkout: dir, settings: undefined, origin: "cwd" });
  });

  it("expands ~ in the flag value", async () => {
    expect(
      await resolveCheckout({
        flag: "~/co-flag",
        env: {},
        cwd: "/anywhere",
        home: "/home/u",
      }),
    ).toEqual({
      checkout: "/home/u/co-flag",
      settings: undefined,
      origin: "flag",
    });
  });

  it("expands ~ in the env value", async () => {
    expect(
      await resolveCheckout({
        flag: undefined,
        env: { [CHECKOUT_ENV]: "~/co-env" },
        cwd: "/anywhere",
        home: "/home/u",
      }),
    ).toEqual({
      checkout: "/home/u/co-env",
      settings: undefined,
      origin: "env",
    });
  });

  it("treats an empty env value as unset and falls through to the binding file", async () => {
    const h = await makeBoundProject();

    expect(
      await resolveCheckout({
        flag: undefined,
        env: { [CHECKOUT_ENV]: "" },
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: h.checkout,
      settings: undefined,
      origin: "file",
    });
  });

  it("throws naming the binding file when it is invalid", async () => {
    const h = await makeBoundProject('[{ "checkout": "/a" }]');

    await expect(
      resolveCheckout({
        flag: undefined,
        env: {},
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).rejects.toThrow(`invalid binding at ${join(h.project, BINDING_FILE)}`);
  });
});

/**
 * The stub agent: runs in the data repo (guarded by the marker file),
 * records the --print payload, answers plainly. The alt stub marks
 * its output so the settings-override test can tell them apart.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
if (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];
if (prompt === undefined || prompt === "") {
  process.exit(3);
}
await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);
console.log("Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].");
`;

const ALT_STUB_AGENT = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
if (!existsSync(join(process.cwd(), ".cli-test-repo"))) process.exit(5);
console.log("ALT-AGENT answered.");
`;

interface Harness {
  readonly dataRoot: string;
  readonly checkout: string;
  readonly project: string;
  readonly outputsDir: string;
}

/** A git-tracked data repo with a stub agent, as in wiki-query tests. */
async function makeDataRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-cli-data-"));

  tempDirs.push(dataRoot);
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "comparisons"), { recursive: true });
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
    join(dataRoot, "wiki", "comparisons", "rag-vs-fine-tuning.md"),
    "---\ntype: comparison\ntitle: RAG vs Fine-Tuning\n---\nComparison body.\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "queries", "when-to-prefer-rag.md"),
    "---\ntype: query\ntitle: When to Prefer RAG\n---\nQuery body.\n",
  );
  await writeFile(join(dataRoot, ".cli-test-repo"), "");
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

  return dataRoot;
}

/**
 * A k-wiki checkout (sync.json → data repo, settings, prompts,
 * outputs) plus a bound project directory with a nested subdir.
 * `binding` replaces the default single-wiki binding; null omits it.
 */
async function makeBoundProject(
  binding?: Record<string, string> | string | null,
): Promise<Harness> {
  const dataRoot = await makeDataRepo();
  const checkout = await mkdtemp(join(tmpdir(), "k-wiki-cli-co-"));

  tempDirs.push(checkout);
  await writeFile(
    join(checkout, "sync.json"),
    JSON.stringify({ vaults: [], dataRoot }),
  );
  await writeFile(
    join(checkout, "settings.yml"),
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: M\nreasoning: low\n`,
  );
  await writeFile(
    join(checkout, "settings-alt.yml"),
    `command: ${join(dataRoot, "stub-alt.mjs")}\nmodel: ALT\nreasoning: low\n`,
  );
  await mkdir(join(checkout, "prompts"), { recursive: true });
  await writeFile(join(checkout, "prompts", "query.md"), "QUERY PROMPT");
  await mkdir(join(checkout, "outputs"), { recursive: true });

  const project = await mkdtemp(join(tmpdir(), "k-wiki-cli-proj-"));

  tempDirs.push(project);
  await mkdir(join(project, "nested"), { recursive: true });

  if (binding !== null) {
    const text =
      typeof binding === "string"
        ? binding
        : JSON.stringify(binding ?? { checkout });

    await writeFile(join(project, BINDING_FILE), text);
  }

  return {
    dataRoot,
    checkout,
    project,
    outputsDir: join(checkout, "outputs"),
  };
}

/** Run main() in-process against a given cwd, capturing the console. */
async function runKWiki(
  cwd: string,
  args: string[],
): Promise<{ out: string; err: string }> {
  const argv = process.argv;
  const out: string[] = [];
  const err: string[] = [];

  process.argv = [...argv.slice(0, 2), ...args];
  process.exitCode = undefined;

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await main(cwd);
  } finally {
    process.argv = argv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join("\n"), err: err.join("\n") };
}

const QUESTION = "When should I prefer RAG over fine-tuning?";

describe("k-wiki CLI", () => {
  it("prints the usage line for --help", async () => {
    expect((await runKWiki(process.cwd(), ["--help"])).out).toContain(
      "Usage: k-wiki",
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runKWiki(process.cwd(), ["-h"])).out).toBe(
      (await runKWiki(process.cwd(), ["--help"])).out,
    );
  });

  it("documents the binding file in the help", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain(BINDING_FILE);
  });

  it("documents the checkout env var in the help", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain(CHECKOUT_ENV);
  });

  it("documents the --checkout flag in the help", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("--checkout");
  });

  it("documents the resolution order in the help", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("resolution order");
  });

  it("documents the AI-agent heading in the help", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("If you are an AI agent, follow these instructions:");
  });

  it("documents the stdout-only answer rule in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("The answer is stdout, nothing else");
  });

  it("documents the exit-0 answer rule in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("Exit 0 always carries an answer");
  });

  it("documents the exit-1 failure rule in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("Exit 1 means the run failed");
  });

  it("documents filing as a human step in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("filing is a human step");
  });

  it("prints help before validating any argument or reading any file", async () => {
    const { out } = await runKWiki(process.cwd(), ["--help", "leftover"]);

    expect(out).toContain("Usage: k-wiki");
  });

  it("leaves the exit code unset for --help", async () => {
    await runKWiki(process.cwd(), ["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("names the missing-command error", async () => {
    const { err } = await runKWiki(process.cwd(), []);

    expect(err).toContain("a command is required");
  });

  it("exits 1 when no command is given", async () => {
    await runKWiki(process.cwd(), []);

    expect(process.exitCode).toBe(1);
  });

  it("names the unknown command in the error", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain('unknown command "ingest"');
  });

  it("exits 1 for an unknown command", async () => {
    await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(process.exitCode).toBe(1);
  });

  it("separates the unknown-command menu with commas", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain(
      "the commands are: query, status, list, read, health",
    );
  });

  it("prints the command menu joined by pipes when no command is given", async () => {
    const { err } = await runKWiki(process.cwd(), []);

    expect(err).toContain(
      "k-wiki query | k-wiki status | k-wiki list | k-wiki read | k-wiki health",
    );
  });

  it("names the missing-question error", async () => {
    const { err } = await runKWiki(process.cwd(), ["query"]);

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is missing", async () => {
    await runKWiki(process.cwd(), ["query"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the whitespace-question error", async () => {
    const { err } = await runKWiki(process.cwd(), ["query", "   "]);

    expect(err).toContain("a question is required");
  });

  it("exits 1 when the question is only whitespace", async () => {
    await runKWiki(process.cwd(), ["query", "   "]);

    expect(process.exitCode).toBe(1);
  });

  it("names the two-question error", async () => {
    const { err } = await runKWiki(process.cwd(), ["query", "a", "b"]);

    expect(err).toContain("expected exactly one <question> argument, got 2");
  });

  it("exits 1 for more than one question argument", async () => {
    await runKWiki(process.cwd(), ["query", "a", "b"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout trailing-junk error", async () => {
    const { err } = await runKWiki(process.cwd(), [
      "query",
      "--timeout",
      "5x",
      "q",
    ]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout with trailing junk", async () => {
    await runKWiki(process.cwd(), ["query", "--timeout", "5x", "q"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout leading-junk error", async () => {
    const { err } = await runKWiki(process.cwd(), [
      "query",
      "--timeout",
      "+5",
      "q",
    ]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout with leading junk", async () => {
    await runKWiki(process.cwd(), ["query", "--timeout", "+5", "q"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the unknown option in the error", async () => {
    const { err } = await runKWiki(process.cwd(), [
      "query",
      "--file-last",
      "q",
    ]);

    expect(err).toContain("--file-last");
  });

  it("exits 1 for an unknown option such as the filing passthrough", async () => {
    await runKWiki(process.cwd(), ["query", "--file-last", "q"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout zero error", async () => {
    const { err } = await runKWiki(process.cwd(), [
      "query",
      "--timeout",
      "0",
      "q",
    ]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout zero", async () => {
    await runKWiki(process.cwd(), ["query", "--timeout", "0", "q"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the --timeout non-numeric error", async () => {
    const { err } = await runKWiki(process.cwd(), [
      "query",
      "--timeout",
      "abc",
      "q",
    ]);

    expect(err).toContain(
      "--timeout needs a positive integer number of seconds",
    );
  });

  it("exits 1 for --timeout non-numeric", async () => {
    await runKWiki(process.cwd(), ["query", "--timeout", "abc", "q"]);

    expect(process.exitCode).toBe(1);
  });
});

describe("k-wiki query", () => {
  it("answers from any cwd inside a bound project with zero flags", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("announces the agent invocation on stderr for a zero-flag query", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(err).toContain("invoking agent");
  });

  it("records the question in the last-query artifact", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    const artifact = await readFile(
      join(h.outputsDir, "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(`question: "${QUESTION}"`);
  });

  it("leaves the exit code unset after a successful query", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    expect(process.exitCode).toBeUndefined();
  });

  it("passes the question to the agent inside the composed prompt", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    const prompt = await readFile(join(h.dataRoot, "stub-prompt.txt"), "utf8");

    expect(prompt).toContain(`Question: ${QUESTION}`);
  });

  it("marks the composed prompt answer-only", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    const prompt = await readFile(join(h.dataRoot, "stub-prompt.txt"), "utf8");

    expect(prompt).toContain("Mode: answer-only");
  });

  it("writes nothing under the data repo's wiki/", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    const { stdout } = await run(
      "git",
      ["-C", h.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");
  });

  it("honors the binding's settings override", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.project, BINDING_FILE),
      JSON.stringify({ checkout: h.checkout, settings: "settings-alt.yml" }),
    );
    const { out } = await runKWiki(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(out).toContain("ALT-AGENT answered.");
  });

  it("points the human filing hint at wiki-query --file-last", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(err).toContain("wiki-query --file-last");
  });

  it("states the filing hint is a human step", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(err).toContain("human");
  });

  it("prints the filing hint after a blank stderr line", async () => {
    const h = await makeBoundProject();
    const prior = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { err } = await runKWiki(join(h.project, "nested"), [
        "query",
        QUESTION,
      ]);

      expect(err.includes("\n\nTo file this answer (human step)")).toBe(true);
    } finally {
      if (prior === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prior;
      }
    }
  });

  it("accepts a valid --timeout and runs the agent under it", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), [
      "query",
      "--timeout",
      "1800",
      QUESTION,
    ]);

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("leaves the exit code unset for a query under a valid --timeout", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), [
      "query",
      "--timeout",
      "1800",
      QUESTION,
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("kills a stalled agent at the --timeout deadline", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    const { err } = await runKWiki(join(h.project, "nested"), [
      "query",
      "--timeout",
      "1",
      QUESTION,
    ]);

    expect(err).toMatch(/timed out after 1 second/);
  });

  it("exits 1 when the agent is killed at the deadline", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n",
      { mode: 0o755 },
    );

    await runKWiki(join(h.project, "nested"), [
      "query",
      "--timeout",
      "1",
      QUESTION,
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("animates the progress line on a TTY", async () => {
    const h = await makeBoundProject();
    // The stub must outlive the 100 ms heartbeat interval (2.5×
    // margin): a fast CI child would otherwise finish before the
    // first live frame, making the \r assertion a spawn-speed race.
    const slowStub = join(h.dataRoot, "slow-agent.mjs");

    await writeFile(
      slowStub,
      '#!/usr/bin/env node\nsetTimeout(() => console.log("Slow answer."), 300);\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(h.checkout, "settings.yml"),
      `command: ${slowStub}\nmodel: M\nreasoning: low\n`,
    );

    const { written } = await runKWikiAnimated(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(written).toContain("\r");
  });

  it("prefixes the multi-wiki binding error with the command name", async () => {
    const h = await makeBoundProject(
      '[{ "checkout": "/a" }, { "checkout": "/b" }]',
    );
    const { err } = await runKWiki(join(h.project, "nested"), ["query", "q"]);

    expect(err).toContain("k-wiki:");
  });

  it("names the one-wiki rule in the multi-wiki binding error", async () => {
    const h = await makeBoundProject(
      '[{ "checkout": "/a" }, { "checkout": "/b" }]',
    );
    const { err } = await runKWiki(join(h.project, "nested"), ["query", "q"]);

    expect(err).toContain("one project binds exactly one wiki");
  });

  it("exits 1 for a multi-wiki binding", async () => {
    const h = await makeBoundProject(
      '[{ "checkout": "/a" }, { "checkout": "/b" }]',
    );

    await runKWiki(join(h.project, "nested"), ["query", "q"]);

    expect(process.exitCode).toBe(1);
  });

  it("resolves the checkout from the env var when no binding exists", async () => {
    const h = await makeBoundProject(null);
    const prior = process.env[CHECKOUT_ENV];

    process.env[CHECKOUT_ENV] = h.checkout;

    try {
      const { out } = await runKWiki(h.project, ["query", QUESTION]);

      expect(out).toContain(
        "Prefer RAG when the knowledge base changes often.",
      );
    } finally {
      if (prior === undefined) {
        delete process.env[CHECKOUT_ENV];
      } else {
        process.env[CHECKOUT_ENV] = prior;
      }
    }
  });

  it("answers from the flag-resolved checkout over the binding file", async () => {
    const h = await makeBoundProject();
    const other = await makeBoundProject();

    const { out } = await runKWiki(h.project, [
      "query",
      "--checkout",
      other.checkout,
      QUESTION,
    ]);

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("writes the artifact into the flag-resolved checkout", async () => {
    const h = await makeBoundProject();
    const other = await makeBoundProject();

    await runKWiki(h.project, [
      "query",
      "--checkout",
      other.checkout,
      QUESTION,
    ]);

    const artifact = await readFile(
      join(other.outputsDir, "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(`question: "${QUESTION}"`);
  });

  it("answers from the checkout itself with no binding", async () => {
    const h = await makeBoundProject(null);
    const { out } = await runKWiki(h.checkout, ["query", QUESTION]);

    expect(out).toContain("Prefer RAG when the knowledge base changes often.");
  });

  it("writes the artifact into the checkout when run from it", async () => {
    const h = await makeBoundProject(null);

    await runKWiki(h.checkout, ["query", QUESTION]);

    const artifact = await readFile(
      join(h.outputsDir, "last-query.md"),
      "utf8",
    );

    expect(artifact).toContain(`question: "${QUESTION}"`);
  });

  it("names the sync-config error when the checkout has none", async () => {
    const empty = await mkdtemp(join(tmpdir(), "k-wiki-empty-"));

    tempDirs.push(empty);
    const { err } = await runKWiki(empty, ["query", "q"]);

    expect(err).toContain("cannot read sync config");
  });

  it("exits 1 for a query when the checkout has no sync config", async () => {
    const empty = await mkdtemp(join(tmpdir(), "k-wiki-empty-"));

    tempDirs.push(empty);
    await runKWiki(empty, ["query", "q"]);

    expect(process.exitCode).toBe(1);
  });

  /** A stub agent that writes a rogue page under wiki/ — the
   *  revert-scenario fixture. */
  async function makeRogueAgentHarness(): Promise<Harness> {
    const h = await makeBoundProject();

    await writeFile(
      join(h.dataRoot, "stub-agent.mjs"),
      `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await mkdir(join(process.cwd(), "wiki", "queries"), { recursive: true });
await writeFile(join(process.cwd(), "wiki", "queries", "rogue.md"), "rogue");
console.log("An answer.");
`,
      { mode: 0o755 },
    );

    return h;
  }

  it("reports the revert when the agent writes under wiki/", async () => {
    const h = await makeRogueAgentHarness();

    const { err } = await runKWiki(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(err).toContain("reverted");
  });

  it("exits 1 when the agent writes under wiki/", async () => {
    const h = await makeRogueAgentHarness();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    expect(process.exitCode).toBe(1);
  });

  it("leaves the data repo's wiki/ clean after the revert", async () => {
    const h = await makeRogueAgentHarness();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    const { stdout } = await run(
      "git",
      ["-C", h.dataRoot, "status", "--porcelain", "-uall", "--", "wiki"],
      { env: process.env },
    );

    expect(stdout.trim()).toBe("");
  });

  it("writes no artifact when the query is reverted", async () => {
    const h = await makeRogueAgentHarness();

    await runKWiki(join(h.project, "nested"), ["query", QUESTION]);

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears the animated progress line when the query fails", async () => {
    const h = await makeBoundProject();
    const failingStub = join(h.dataRoot, "failing-agent.mjs");

    await writeFile(
      failingStub,
      "#!/usr/bin/env node\nsetTimeout(() => process.exit(3), 300);\n",
      { mode: 0o755 },
    );
    await writeFile(
      join(h.checkout, "settings.yml"),
      `command: ${failingStub}\nmodel: M\nreasoning: low\n`,
    );

    const { written } = await runKWikiAnimated(join(h.project, "nested"), [
      "query",
      QUESTION,
    ]);

    expect(written).toMatch(/\r +\r/);
  });
});

describe("k-wiki status", () => {
  it("prints the resolved checkout in the status output", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect(out).toContain(`checkout:  ${h.checkout}`);
  });

  it("names the binding file origin in the status output", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect(out).toContain("from .k-wiki.json");
  });

  it("prints the settings path in the status output", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect(out).toContain(`settings:  ${join(h.checkout, "settings.yml")}`);
  });

  it("prints the data repo path in the status output", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect(out).toContain(`data repo: ${h.dataRoot}`);
  });

  it("prints the wiki path in the status output", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect(out).toContain(`wiki:      ${join(h.dataRoot, "wiki")}`);
  });

  it("prints the index path in the status output", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect(out).toContain(`index:     ${join(h.dataRoot, "wiki", "index.md")}`);
  });

  it("leaves the exit code unset after status", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["status"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("names the cwd origin when no binding exists", async () => {
    const h = await makeBoundProject(null);
    const { out } = await runKWiki(h.checkout, ["status"]);

    expect(out).toContain("from the cwd itself");
  });

  it("runs no agent for status", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["status"]);

    await expect(
      readFile(join(h.dataRoot, "stub-prompt.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes no last-query artifact for status", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["status"]);

    await expect(
      readFile(join(h.outputsDir, "last-query.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the sync-config error when the checkout has none", async () => {
    const empty = await mkdtemp(join(tmpdir(), "k-wiki-empty-"));

    tempDirs.push(empty);
    const { err } = await runKWiki(empty, ["status"]);

    expect(err).toContain("cannot read sync config");
  });

  it("exits 1 for a status run in a checkout with no sync config", async () => {
    const empty = await mkdtemp(join(tmpdir(), "k-wiki-empty-"));

    tempDirs.push(empty);
    await runKWiki(empty, ["status"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the no-arguments error for status", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(h.project, ["status", "extra"]);

    expect(err).toContain("takes no arguments");
  });

  it("exits 1 for extra positional arguments to status", async () => {
    const h = await makeBoundProject();
    await runKWiki(h.project, ["status", "extra"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints exactly one error line for an invalid binding", async () => {
    const h = await makeBoundProject('[{ "checkout": "/a" }]');
    const { err } = await runKWiki(join(h.project, "nested"), ["status"]);

    expect((err.match(/k-wiki:/g) ?? []).length).toBe(1);
  });
});

describe("k-wiki list", () => {
  it("prints the concepts group header", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("## concepts");
  });

  it("prints the rag page line in the concepts group", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("rag — Retrieval-Augmented Generation");
  });

  it("prints the sources group header", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("## sources");
  });

  it("prints the attention page line in the sources group", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("attention — Attention Is All You Need");
  });

  it("prints the comparisons group header", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("## comparisons");
  });

  it("prints the rag-vs-fine-tuning page line in the comparisons group", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("rag-vs-fine-tuning — RAG vs Fine-Tuning");
  });

  it("prints the queries group header", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("## queries");
  });

  it("prints the when-to-prefer-rag page line in the queries group", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).toContain("when-to-prefer-rag — When to Prefer RAG");
  });

  it("prints concepts before sources", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.indexOf("## concepts")).toBeLessThan(out.indexOf("## sources"));
  });

  it("prints sources before queries", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.indexOf("## sources")).toBeLessThan(out.indexOf("## queries"));
  });

  it("prints queries before comparisons", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.indexOf("## queries")).toBeLessThan(
      out.indexOf("## comparisons"),
    );
  });

  it("prints the requested type's pages", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), [
      "list",
      "concept",
    ]);

    expect(out).toContain("rag — Retrieval-Augmented Generation");
  });

  it("omits other types' pages from the filtered listing", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), [
      "list",
      "concept",
    ]);

    expect(out).not.toContain("attention —");
  });

  it("omits other type headers from the filtered listing", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), [
      "list",
      "concept",
    ]);

    expect(out).not.toContain("## sources");
  });

  it("omits index from the listing", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).not.toContain("index —");
  });

  it("omits log from the listing", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).not.toContain("log —");
  });

  it("omits overview from the listing", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out).not.toContain("overview —");
  });

  it("names the unknown type in the error", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "list",
      "bogus",
    ]);

    expect(err).toContain("unknown type");
  });

  it("names concept among the valid types in the error", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "list",
      "bogus",
    ]);

    expect(err).toContain("concept");
  });

  it("names comparison among the valid types in the error", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "list",
      "bogus",
    ]);

    expect(err).toContain("comparison");
  });

  it("exits 1 for an unknown type filter", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["list", "bogus"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing wiki dir in the error", async () => {
    const h = await makeBoundProject();

    await rm(join(h.dataRoot, "wiki"), { recursive: true });
    const { err } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(err).toContain("wiki directory does not exist");
  });

  it("exits 1 when the wiki dir does not exist", async () => {
    const h = await makeBoundProject();

    await rm(join(h.dataRoot, "wiki"), { recursive: true });
    await runKWiki(join(h.project, "nested"), ["list"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the valid types joined by pipes for an unknown type filter", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "list",
      "bogus",
    ]);

    expect(err).toContain(
      "valid types: concept|entity|source|query|comparison",
    );
  });

  it("names the one-type-argument error", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "list",
      "concept",
      "entity",
    ]);

    expect(err).toContain("k-wiki list takes at most one <type> argument");
  });

  it("exits 1 when given more than one type argument", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["list", "concept", "entity"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints one line per page for a filtered type", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.dataRoot, "wiki", "concepts", "retrieval.md"),
      "---\ntype: concept\ntitle: Retrieval\n---\nBody.\n",
    );
    const { out } = await runKWiki(join(h.project, "nested"), [
      "list",
      "concept",
    ]);

    expect(out.split("\n")).toEqual(
      expect.arrayContaining([
        "rag — Retrieval-Augmented Generation",
        "retrieval — Retrieval",
      ]),
    );
  });

  it("prints one line per page in the grouped listing", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.dataRoot, "wiki", "concepts", "retrieval.md"),
      "---\ntype: concept\ntitle: Retrieval\n---\nBody.\n",
    );
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.split("\n")).toEqual(
      expect.arrayContaining([
        "## concepts",
        "rag — Retrieval-Augmented Generation",
        "retrieval — Retrieval",
        "## sources",
        "attention — Attention Is All You Need",
      ]),
    );
  });

  it("groups pages without a type under untyped", async () => {
    const h = await makeBoundProject();

    await mkdir(join(h.dataRoot, "wiki", "scratch"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "scratch", "loose-note.md"),
      "No frontmatter.\n",
    );
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.split("\n")).toEqual(
      expect.arrayContaining(["## untyped", "loose-note — loose-note"]),
    );
  });

  it("runs no agent after listing", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["list"]);

    await expect(
      readFile(join(h.dataRoot, "stub-prompt.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/** Run main() capturing raw stdout writes (verbatim page output). */
async function runKWikiStdout(
  cwd: string,
  args: string[],
): Promise<{ out: string; err: string }> {
  const argv = process.argv;
  const out: string[] = [];
  const err: string[] = [];

  process.argv = [...argv.slice(0, 2), ...args];
  process.exitCode = undefined;

  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));

      return true;
    });
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await main(cwd);
  } finally {
    process.argv = argv;
    writeSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join(""), err: err.join("\n") };
}

/** Run main() with a TTY stderr (animated progress), capturing raw
 *  stderr writes so the animated line's lifecycle is observable. */
async function runKWikiAnimated(
  cwd: string,
  args: string[],
): Promise<{ written: string; out: string; err: string }> {
  const argv = process.argv;
  const out: string[] = [];
  const err: string[] = [];
  const writes: string[] = [];

  process.argv = [...argv.slice(0, 2), ...args];
  process.exitCode = undefined;

  const writeSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));

      return true;
    });
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
  const priorNoColor = process.env.NO_COLOR;

  Object.defineProperty(process.stderr, "isTTY", { value: true });
  delete process.env.NO_COLOR;

  try {
    await main(cwd);
  } finally {
    process.argv = argv;
    writeSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", tty ?? {});

    if (priorNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = priorNoColor;
    }
  }

  return { written: writes.join(""), out: out.join("\n"), err: err.join("\n") };
}

describe("k-wiki read", () => {
  it("prints the page's frontmatter verbatim by file name", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWikiStdout(join(h.project, "nested"), [
      "read",
      "rag",
    ]);

    expect(out).toContain("type: concept");
  });

  it("prints the page's body verbatim by file name", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWikiStdout(join(h.project, "nested"), [
      "read",
      "rag",
    ]);

    expect(out).toContain("RAG body.");
  });

  it("resolves a page outside its type directory", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWikiStdout(join(h.project, "nested"), [
      "read",
      "attention",
    ]);

    expect(out).toContain("Attention body.");
  });

  it("reads the navigation page index", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWikiStdout(join(h.project, "nested"), [
      "read",
      "index",
    ]);

    expect(out).toContain("# Index");
  });

  it("names the absent page in the error", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "read",
      "atten",
    ]);

    expect(err).toContain('no page named "atten"');
  });

  it("suggests the near match when the page is absent", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "read",
      "atten",
    ]);

    expect(err).toContain("attention");
  });

  it("exits 1 when the page is absent", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["read", "atten"]);

    expect(process.exitCode).toBe(1);
  });

  it("suggests the existing page when the asked slug extends it", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "read",
      "attention-is-all-you-need-extra",
    ]);

    expect(err).toContain("near matches: attention");
  });

  it("names the absent page when no near match exists", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "read",
      "zzz-void",
    ]);

    expect(err).toContain('no page named "zzz-void"');
  });

  it("omits the near-matches hint when no near match exists", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "read",
      "zzz-void",
    ]);

    expect(err).not.toContain("near matches");
  });

  it("exits 1 plainly when no near match exists", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["read", "zzz-void"]);

    expect(process.exitCode).toBe(1);
  });

  /** Two wiki dirs each holding a page named dup.md — the
   *  ambiguous-name fixture. */
  async function makeAmbiguousNameHarness(): Promise<Harness> {
    const h = await makeBoundProject();

    await mkdir(join(h.dataRoot, "wiki", "dup1"), { recursive: true });
    await mkdir(join(h.dataRoot, "wiki", "dup2"), { recursive: true });
    await writeFile(join(h.dataRoot, "wiki", "dup1", "dup.md"), "one\n");
    await writeFile(join(h.dataRoot, "wiki", "dup2", "dup.md"), "two\n");

    return h;
  }

  it("calls the non-unique file name ambiguous in the error", async () => {
    const h = await makeAmbiguousNameHarness();
    const { err } = await runKWiki(join(h.project, "nested"), ["read", "dup"]);

    expect(err).toContain("ambiguous");
  });

  it("names the first candidate when the file name is not unique", async () => {
    const h = await makeAmbiguousNameHarness();
    const { err } = await runKWiki(join(h.project, "nested"), ["read", "dup"]);

    expect(err).toContain("dup1/dup.md");
  });

  it("names the second candidate when the file name is not unique", async () => {
    const h = await makeAmbiguousNameHarness();
    const { err } = await runKWiki(join(h.project, "nested"), ["read", "dup"]);

    expect(err).toContain("dup2/dup.md");
  });

  it("exits 1 when the file name is not unique", async () => {
    const h = await makeAmbiguousNameHarness();
    await runKWiki(join(h.project, "nested"), ["read", "dup"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the missing-slug error", async () => {
    const { err } = await runKWiki(process.cwd(), ["read"]);

    expect(err).toContain("a <slug> is required");
  });

  it("exits 1 when the slug is missing", async () => {
    await runKWiki(process.cwd(), ["read"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the two-slug error", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(join(h.project, "nested"), [
      "read",
      "rag",
      "attention",
    ]);

    expect(err).toContain("k-wiki read takes exactly one <slug> argument");
  });

  it("exits 1 when given more than one slug", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["read", "rag", "attention"]);

    expect(process.exitCode).toBe(1);
  });

  it("runs no agent after reading a page", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["read", "rag"]);

    await expect(
      readFile(join(h.dataRoot, "stub-prompt.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("k-wiki health", () => {
  it("prints the healthy summary for a coherent projection", async () => {
    const h = await makeBoundProject();
    const { out } = await runKWiki(join(h.project, "nested"), ["health"]);

    expect(out).toContain("healthy");
  });

  it("leaves the exit code unset for a healthy projection", async () => {
    const h = await makeBoundProject();
    await runKWiki(join(h.project, "nested"), ["health"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prints the manifest problem for an incoherent projection", async () => {
    const h = await makeBoundProject();

    await writeFile(join(h.dataRoot, "raw", "manifest.json"), "{ broken json");
    const { out, err } = await runKWiki(join(h.project, "nested"), ["health"]);

    expect(`${out}${err}`).toContain("manifest.json");
  });

  it("exits 1 for an incoherent projection", async () => {
    const h = await makeBoundProject();

    await writeFile(join(h.dataRoot, "raw", "manifest.json"), "{ broken json");
    await runKWiki(join(h.project, "nested"), ["health"]);

    expect(process.exitCode).toBe(1);
  });

  it("names the no-arguments error for health", async () => {
    const h = await makeBoundProject();
    const { err } = await runKWiki(h.project, ["health", "extra"]);

    expect(err).toContain("takes no arguments");
  });

  it("exits 1 for extra positional arguments to health", async () => {
    const h = await makeBoundProject();
    await runKWiki(h.project, ["health", "extra"]);

    expect(process.exitCode).toBe(1);
  });

  it("runs no agent after the health check", async () => {
    const h = await makeBoundProject();

    await runKWiki(join(h.project, "nested"), ["health"]);

    await expect(
      readFile(join(h.dataRoot, "stub-prompt.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/** Stamp the projection's manifest with the data repo's HEAD, then
 *  advance HEAD with a commit so the projection becomes stale. */
async function makeStaleProjection(h: Harness): Promise<void> {
  const { stdout } = await run("git", ["-C", h.dataRoot, "rev-parse", "HEAD"]);

  await writeFile(
    join(h.dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({
      source_commit: stdout.trim(),
      source_root: h.dataRoot,
      vaults: {},
    })}\n`,
  );
  await run("git", ["-C", h.dataRoot, "add", "-A"], { cwd: h.dataRoot });
  await run(
    "git",
    [
      "-C",
      h.dataRoot,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "stamp",
    ],
    { cwd: h.dataRoot },
  );
}

describe("k-wiki health staleness", () => {
  it("warns about a stale projection without --fail-on-stale", async () => {
    const h = await makeBoundProject();

    await makeStaleProjection(h);
    const { out, err } = await runKWiki(join(h.project, "nested"), ["health"]);

    expect(`${out}${err}`).toContain("stale projection");
  });

  it("stays exit 0 for a stale projection without --fail-on-stale", async () => {
    const h = await makeBoundProject();

    await makeStaleProjection(h);
    await runKWiki(join(h.project, "nested"), ["health"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 for a stale projection with --fail-on-stale", async () => {
    const h = await makeBoundProject();

    await makeStaleProjection(h);
    await runKWiki(join(h.project, "nested"), ["health", "--fail-on-stale"]);

    expect(process.exitCode).toBe(1);
  });
});

describe("k-wiki help with the read-only commands", () => {
  it("documents every command in the usage block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    for (const command of ["query", "status", "list", "read", "health"]) {
      expect(out).toContain(`k-wiki ${command}`);
    }
  });

  it("documents the status command in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("k-wiki status shows which wiki you are bound to");
  });

  it("documents the browse commands in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("k-wiki list [type] and k-wiki read <slug> browse");
  });

  it("documents the health command in the AI-agent block", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("k-wiki health checks the projection");
  });

  it("names the valid types in the list command entry", async () => {
    const out = (await runKWiki(process.cwd(), ["--help"])).out;

    expect(out).toContain("concept|entity|source|query|comparison");
  });

  it("names the unknown command in the menu error", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain('unknown command "ingest"');
  });

  it("lists query in the unknown-command menu", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain("query");
  });

  it("lists status in the unknown-command menu", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain("status");
  });

  it("lists list in the unknown-command menu", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain("list");
  });

  it("lists read in the unknown-command menu", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain("read");
  });

  it("lists health in the unknown-command menu", async () => {
    const { err } = await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(err).toContain("health");
  });

  it("exits 1 after printing the unknown-command menu", async () => {
    await runKWiki(process.cwd(), ["ingest", "q"]);

    expect(process.exitCode).toBe(1);
  });
});

describe("k-wiki list custom sections", () => {
  it("groups pages of an unknown type under a pluralized header", async () => {
    const h = await makeBoundProject();
    await mkdir(join(h.dataRoot, "wiki", "essays"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "essays", "on-tools.md"),
      "---\ntype: essay\ntitle: On Tools\n---\nEssay body.\n",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);

    expect((await runKWiki(join(h.project, "nested"), ["list"])).out).toContain(
      "## essays",
    );
  });

  it("lists the unknown-type pages under their pluralized header after the known types", async () => {
    const h = await makeBoundProject();
    await mkdir(join(h.dataRoot, "wiki", "essays"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "essays", "on-tools.md"),
      "---\ntype: essay\ntitle: On Tools\n---\nEssay body.\n",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    const queries = out.indexOf("## queries");
    const essays = out.indexOf("## essays");

    expect(essays).toBeGreaterThan(queries);
  });

  it("prints each known type's section exactly once alongside a custom type", async () => {
    const h = await makeBoundProject();
    await mkdir(join(h.dataRoot, "wiki", "essays"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "essays", "on-tools.md"),
      "---\ntype: essay\ntitle: On Tools\n---\nEssay body.\n",
    );
    await run("git", ["-C", h.dataRoot, "add", "-A"]);
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.match(/## concepts/g)?.length).toBe(1);
  });

  it("lists pages without a type under an untyped section", async () => {
    const h = await makeBoundProject();
    await mkdir(join(h.dataRoot, "wiki", "limbo"), { recursive: true });
    await mkdir(join(h.dataRoot, "wiki", "essays"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "limbo", "loose.md"),
      "---\ntitle: Loose Page\n---\nBody.\n",
    );
    await writeFile(
      join(h.dataRoot, "wiki", "essays", "on-tools.md"),
      "---\ntype: essay\ntitle: On Tools\n---\nEssay body.\n",
    );

    expect((await runKWiki(join(h.project, "nested"), ["list"])).out).toContain(
      "loose — Loose Page",
    );
  });

  it("orders the untyped section after custom type sections", async () => {
    const h = await makeBoundProject();
    await mkdir(join(h.dataRoot, "wiki", "limbo"), { recursive: true });
    await mkdir(join(h.dataRoot, "wiki", "essays"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "limbo", "loose.md"),
      "---\ntitle: Loose Page\n---\nBody.\n",
    );
    await writeFile(
      join(h.dataRoot, "wiki", "essays", "on-tools.md"),
      "---\ntype: essay\ntitle: On Tools\n---\nEssay body.\n",
    );
    const { out } = await runKWiki(join(h.project, "nested"), ["list"]);

    expect(out.indexOf("## untyped")).toBeGreaterThan(out.indexOf("## essays"));
  });

  it("never pluralizes the untyped header", async () => {
    const h = await makeBoundProject();
    await mkdir(join(h.dataRoot, "wiki", "limbo"), { recursive: true });
    await writeFile(
      join(h.dataRoot, "wiki", "limbo", "loose.md"),
      "---\ntitle: Loose Page\n---\nBody.\n",
    );

    expect(
      (await runKWiki(join(h.project, "nested"), ["list"])).out.includes(
        "## untypeds",
      ),
    ).toBe(false);
  });
});
