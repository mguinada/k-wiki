import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRunner } from "../../src/ingest/agent-run.ts";
import { runSandboxRun, slugError } from "../../src/sandbox/sandbox-run.ts";
import type { WikiInstance } from "../../src/sync/instance.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A fixed clock: 2026-08-20T12:00:00Z — deterministic stamps. */
const NOW = () => new Date("2026-08-20T12:00:00.000Z");

/** The minimal agent settings the primitive spawns with. */
const SETTINGS = {
  command: "stub",
  model: "test-model",
  reasoning: "low",
};

/** A resolved instance pointing at dataRoot (as resolveWikiInstance
 *  would for the default instance of a checkout there). */
function instanceAt(dataRoot: string): WikiInstance {
  return {
    name: undefined,
    configPath: join(dataRoot, "sync.json"),
    stem: undefined,
    outputsDir: join(dataRoot, "outputs"),
    settingsPath: join(dataRoot, "settings.yml"),
    rawDir: join(dataRoot, "raw"),
  };
}

/** A temp data repo: committed wiki/index.md, empty sandbox. */
async function makeRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-sandbox-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: dataRoot });
  await gitCommitAll(dataRoot, "init");

  return dataRoot;
}

async function gitCommitAll(dataRoot: string, message: string) {
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
      message,
    ],
    { cwd: dataRoot },
  );
}

/** The repo's current porcelain status, one "XY path" line per entry. */
async function statusOf(dataRoot: string): Promise<string> {
  const { stdout } = await run("git", ["status", "--porcelain", "-uall"], {
    cwd: dataRoot,
  });

  return stdout;
}

/** An agent runner that performs the writes the test names. */
function agentWriting(writes: Record<string, string>): AgentRunner {
  return async (_command, _args, options) => {
    for (const [path, content] of Object.entries(writes)) {
      const target = join(options.cwd, path);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    return { stdout: "stub agent done", stderr: "" };
  };
}

/** An agent runner that fails without writing. */
const failingAgent: AgentRunner = async () => {
  throw new Error("stub agent exploded");
};

/** Run the primitive with the default plumbing over one repo. */
function sandboxRun(
  dataRoot: string,
  input: {
    readonly slug?: string;
    readonly instance?: WikiInstance;
    readonly runAgent?: AgentRunner;
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
    settings: SETTINGS,
    slug: input.slug ?? "note-slug",
    prompt: input.prompt ?? "write the proposal",
    runAgent: input.runAgent,
  });
}

describe("slugError", () => {
  it("accepts lowercase kebab-case", () => {
    expect(slugError("attention-notes-2")).toBeUndefined();
  });

  it("rejects separators, case, and empty slugs", () => {
    expect(slugError("a/b")).toBeDefined();
    expect(slugError("Note")).toBeDefined();
    expect(slugError("")).toBeDefined();
    expect(slugError("-a")).toBeDefined();
  });
});

describe("runSandboxRun", () => {
  it("commits a sandbox-only run atomically with stamps and audit entry", async () => {
    const dataRoot = await makeRepo();

    const result = await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    expect(result.status).toBe("committed");
    const { stdout: log } = await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    expect(log.trim()).toBe("sandbox: note-slug");

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "note-slug.md"),
      "utf8",
    );

    expect(note).toContain("via: agent");
    expect(note).toContain("expires: 2026-08-27");

    const logMd = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(logMd).toContain("## [2026-08-20] sandbox | note-slug");

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("overwrites caller-supplied via and expires stamps", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md":
          '---\ntitle: "Note"\nvia: human\nexpires: 1999-01-01\n---\nBody.\n',
      }),
    });

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "note-slug.md"),
      "utf8",
    );

    expect(note).not.toContain("via: human");
    expect(note).not.toContain("1999-01-01");
    expect(note).toContain("via: agent");
    expect(note).toContain("expires: 2026-08-27");
  });

  it("commits nothing and reports empty for a run that wrote nothing", async () => {
    const dataRoot = await makeRepo();
    const { stdout: before } = await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    const result = await sandboxRun(dataRoot, { runAgent: agentWriting({}) });

    expect(result).toEqual({ status: "empty" });

    const { stdout: after } = await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    expect(after).toBe(before);
    expect(await statusOf(dataRoot)).toBe("");
    await expect(readFile(join(dataRoot, "wiki", "log.md"))).rejects.toThrow();
  });

  it("reverts a main-tree-touching run path-scoped and fails loudly", async () => {
    const dataRoot = await makeRepo();

    // A pre-existing dirty page outside the sandbox: the revert must
    // preserve it (no whole-repo reset), and the run must not touch it.
    await writeFile(
      join(dataRoot, "wiki", "dirty-page.md"),
      "pre-run dirty work\n",
    );

    const promise = sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": "sandbox note\n",
        "wiki/index.md": "# Index (mangled)\n",
      }),
    });

    await expect(promise).rejects.toThrow(
      /accept-gate failed.*wiki\/index\.md/s,
    );

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );
    expect(
      await readFile(join(dataRoot, "wiki", "dirty-page.md"), "utf8"),
    ).toBe("pre-run dirty work\n");
    await expect(
      readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md")),
    ).rejects.toThrow();

    const { stdout: log } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(log.trim().split("\n")).toEqual(["init"]);
  });

  it("keeps a wiki-sync-era commit that landed mid-window (no whole-repo reset)", async () => {
    const dataRoot = await makeRepo();
    const agent = async (
      _command: string,
      _args: readonly string[],
      options: { cwd: string },
    ) => {
      // A wiki-sync cycle commits mid-window, then the agent writes.
      await writeFile(join(options.cwd, "wiki", "synced.md"), "synced\n");
      await gitCommitAll(options.cwd, "wiki-sync: cycle");

      await mkdir(join(options.cwd, "wiki", "sandbox"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "sandbox", "note-slug.md"),
        "sandbox note\n",
      );
      await writeFile(join(options.cwd, "wiki", "index.md"), "# Mangled\n");

      return { stdout: "", stderr: "" };
    };

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /accept-gate failed/,
    );

    const { stdout: log } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(log.trim().split("\n")).toEqual(["wiki-sync: cycle", "init"]);
    expect(await readFile(join(dataRoot, "wiki", "synced.md"), "utf8")).toBe(
      "synced\n",
    );
    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );
  });

  it("refuses before any write when the sandbox namespace is already dirty", async () => {
    const dataRoot = await makeRepo();
    await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });
    await writeFile(
      join(dataRoot, "wiki", "sandbox", "other-note.md"),
      "uncommitted earlier work\n",
    );

    let invoked = false;
    const agent: AgentRunner = async () => {
      invoked = true;

      return { stdout: "", stderr: "" };
    };

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /sandbox namespace is already dirty.*wiki\/sandbox\/other-note\.md/s,
    );

    expect(invoked).toBe(false);
    expect(
      await readFile(
        join(dataRoot, "wiki", "sandbox", "other-note.md"),
        "utf8",
      ),
    ).toBe("uncommitted earlier work\n");
  });

  it("refuses a colliding slug without overwriting", async () => {
    const dataRoot = await makeRepo();
    await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "old\n");
    await gitCommitAll(dataRoot, "seed sandbox note");

    await expect(
      sandboxRun(dataRoot, { runAgent: agentWriting({}) }),
    ).rejects.toThrow(/already exists.*identity/s);

    expect(
      await readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "utf8"),
    ).toBe("old\n");
  });

  it("refuses a run whose instance and context name different data repos", async () => {
    const dataRoot = await makeRepo();
    const otherRoot = await makeRepo();

    await expect(
      sandboxRun(dataRoot, {
        instance: instanceAt(otherRoot),
        runAgent: agentWriting({ "wiki/sandbox/note-slug.md": "x\n" }),
      }),
    ).rejects.toThrow(/wrong-repo accept-gate/);

    expect(await statusOf(otherRoot)).toBe("");
  });

  it("reverts the run's sandbox writes when the agent itself fails", async () => {
    const dataRoot = await makeRepo();
    const agent: AgentRunner = async (_c, _a, options) => {
      await mkdir(join(options.cwd, "wiki", "sandbox"), { recursive: true });
      await writeFile(
        join(options.cwd, "wiki", "sandbox", "note-slug.md"),
        "half-written\n",
      );

      throw new Error("agent died mid-run");
    };

    const failure = await sandboxRun(dataRoot, { runAgent: agent }).then(
      () => undefined,
      (error: Error) => error,
    );

    if (failure === undefined) {
      throw new Error("expected the agent run to fail");
    }

    expect(failure.message).toMatch(/agent run failed.*were reverted/s);
    expect((failure.cause as Error).message).toBe("agent died mid-run");

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("surfaces a failing agent error even when nothing was written", async () => {
    const dataRoot = await makeRepo();

    const failure = await sandboxRun(dataRoot, {
      runAgent: failingAgent,
    }).then(
      () => undefined,
      (error: Error) => error,
    );

    if (failure === undefined) {
      throw new Error("expected the agent run to fail");
    }

    expect(failure.message).toMatch(/agent run failed/);
    expect((failure.cause as Error).message).toBe("stub agent exploded");
  });

  it("rejects an invalid slug before any work", async () => {
    const dataRoot = await makeRepo();

    await expect(sandboxRun(dataRoot, { slug: "Not A Slug" })).rejects.toThrow(
      /kebab-case/,
    );
  });

  it("stamps and commits multiple sandbox pages of one run", async () => {
    const dataRoot = await makeRepo();

    const result = await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "A"\n---\nA.\n',
        "wiki/sandbox/note-slug-annex.md": "B.\n",
      }),
    });

    expect(result.status).toBe("committed");
    expect(
      result.status === "committed" ? [...result.pages].sort() : [],
    ).toEqual(["wiki/sandbox/note-slug-annex.md", "wiki/sandbox/note-slug.md"]);

    const { stdout: names } = await run(
      "git",
      ["show", "--name-only", "--format=", "HEAD"],
      { cwd: dataRoot },
    );

    expect(names.trim().split("\n").sort()).toEqual([
      "wiki/log.md",
      "wiki/sandbox/note-slug-annex.md",
      "wiki/sandbox/note-slug.md",
    ]);
  });

  it("restores a re-edited pre-dirty page to its pre-run bytes on violation", async () => {
    const dataRoot = await makeRepo();
    await writeFile(join(dataRoot, "wiki", "index.md"), "dirty before run\n");
    const agent = agentWriting({ "wiki/index.md": "mangled by run\n" });

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /accept-gate failed/,
    );

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "dirty before run\n",
    );
  });
});
