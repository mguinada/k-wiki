import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runSandboxRun } from "../../src/sandbox/sandbox-run.ts";
import type { WikiInstance } from "../../src/sync/instance.ts";

const run = promisify(execFile);

/**
 * sandbox e2e (issue #336): the run primitive driving a real stub
 * agent child process (the exact argv the real agent would receive)
 * over a real git data repo — the three acceptance flows: a
 * sandbox-only run lands as one atomic stamped commit, a
 * main-tree-touching run is path-scoped-reverted and fails loudly,
 * and a run whose instance resolution names another data repo is
 * refused before anything runs. The `propose` verb that will drive
 * this primitive is family 6 (#340); a real LLM run stays a human
 * check.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The fixed run clock: stamps and log dates stay byte-exact. */
const NOW = () => new Date("2026-08-20T12:00:00.000Z");

/**
 * The stub agent: an executable script (shebang) so it can be named
 * as settings.command — it receives the exact argv the real agent
 * would (pi flags), and writes per the marker embedded in the
 * prompt: SANDBOX_ONLY writes the proposal note, MAIN_TREE also
 * mangles wiki/index.md (the gate must revert), DIRTY_TARGET
 * pre-writes into the sandbox namespace. Exits 3 when the payload is
 * missing — the primitive must pass the prompt through.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

const root = process.cwd();

if (prompt.includes("SANDBOX_ONLY")) {
  await mkdir(join(root, "wiki", "sandbox"), { recursive: true });
  await writeFile(
    join(root, "wiki", "sandbox", "attention-notes.md"),
    [
      "---",
      'title: "Attention notes"',
      "type: concept",
      "via: human",
      "expires: 1999-01-01",
      "---",
      "",
      "Proposal body.",
      "",
    ].join("\\n"),
  );
} else if (prompt.includes("MAIN_TREE")) {
  await mkdir(join(root, "wiki", "sandbox"), { recursive: true });
  await writeFile(
    join(root, "wiki", "sandbox", "attention-notes.md"),
    "sandbox note\\n",
  );
  await writeFile(join(root, "wiki", "index.md"), "# Index (mangled)\\n");
} else if (prompt.includes("WRITE_NOTHING")) {
  // An empty run: write nothing at all.
}

console.log("stub agent finished");
`;

/** A temp data repo: committed wiki/index.md plus the stub agent. */
async function makeRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-sandbox-e2e-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: dataRoot });
  // Repo-local identity: the primitive's own commit must not lean
  // on a global git identity — the CI runner has none.
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

/** A resolved instance for the repo, as resolveWikiInstance derives. */
function instanceAt(dataRoot: string): WikiInstance {
  return {
    name: "eng",
    configPath: join(dataRoot, "sync-eng.json"),
    stem: "eng",
    outputsDir: join(dataRoot, "outputs-eng"),
    settingsPath: join(dataRoot, "settings.yml"),
    rawDir: join(dataRoot, "raw"),
  };
}

/** Drive the primitive over one repo with the stub agent command. */
function sandboxRun(
  dataRoot: string,
  input: {
    readonly instance?: WikiInstance;
    readonly slug?: string;
    readonly prompt?: string;
  } = {},
) {
  return runSandboxRun({
    instance: input.instance ?? instanceAt(dataRoot),
    run: {
      dataRoot,
      rawDir: join(dataRoot, "raw"),
      wikiDir: join(dataRoot, "wiki"),
      env: process.env,
      now: NOW,
      onProgress: () => {},
    },
    settings: {
      command: join(dataRoot, "stub-agent.mjs"),
      model: "E2E-MODEL",
      reasoning: "low",
    },
    slug: input.slug ?? "attention-notes",
    prompt: input.prompt ?? "SANDBOX_ONLY",
  });
}

describe("sandbox e2e", () => {
  it("lands a sandbox-only run as one atomic stamped commit with an audit entry", async () => {
    const dataRoot = await makeRepo();

    const result = await sandboxRun(dataRoot);

    expect(result.status).toBe("committed");
    expect(result.status === "committed" && result.message).toBe(
      "sandbox: attention-notes",
    );

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(subjects.trim().split("\n")).toEqual([
      "sandbox: attention-notes",
      "init",
    ]);

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "attention-notes.md"),
      "utf8",
    );

    expect(note).toContain("via: agent");
    expect(note).toContain("expires: 2026-08-27");
    expect(note).not.toContain("via: human");

    const logMd = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(logMd).toContain("## [2026-08-20] sandbox | attention-notes");
    expect(logMd).toContain("expires 2026-08-27");

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status).toBe("");
  });

  it("reverts a main-tree-touching run path-scoped and fails loudly", async () => {
    const dataRoot = await makeRepo();

    // A wiki-sync-era commit and pre-existing dirty work: neither may
    // be destroyed by the gate's revert.
    await writeFile(join(dataRoot, "wiki", "synced.md"), "synced v1\n");
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
        "wiki-sync: cycle",
      ],
      { cwd: dataRoot },
    );
    await writeFile(join(dataRoot, "wiki", "synced.md"), "synced v2 dirty\n");

    const failure = await sandboxRun(dataRoot, { prompt: "MAIN_TREE" }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(/accept-gate failed/);
    expect(failure?.message).toContain("wiki/index.md");

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );
    expect(await readFile(join(dataRoot, "wiki", "synced.md"), "utf8")).toBe(
      "synced v2 dirty\n",
    );

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(subjects.trim().split("\n")).toEqual(["wiki-sync: cycle", "init"]);

    await expect(
      readFile(join(dataRoot, "wiki", "sandbox", "attention-notes.md")),
    ).rejects.toThrow();
  });

  it("refuses the wrong-repo accept-gate before the agent runs", async () => {
    const dataRoot = await makeRepo();
    const otherRoot = await makeRepo();

    const failure = await sandboxRun(dataRoot, {
      instance: instanceAt(otherRoot),
    }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("wrong-repo accept-gate");
    expect(failure?.message).toContain(otherRoot);

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: otherRoot },
    );

    expect(status).toBe("");
  });

  it("commits nothing for an empty run", async () => {
    const dataRoot = await makeRepo();
    const { stdout: before } = await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    const result = await sandboxRun(dataRoot, { prompt: "WRITE_NOTHING" });

    expect(result).toEqual({ status: "empty" });

    const { stdout: after } = await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    expect(after).toBe(before);
  });
});
