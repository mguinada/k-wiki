import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRunner } from "../../src/ingest/agent-run.ts";
import {
  revertPathsToLastCommit,
  runSandboxRun,
  slugError,
} from "../../src/sandbox/sandbox-run.ts";
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
  // Repo-local identity: the primitive's own commits (and these seed
  // commits) must not lean on a global git identity — CI has none.
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
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

/** A run context for the exported revert primitive. */
function runContextAt(dataRoot: string) {
  return {
    dataRoot,
    rawDir: join(dataRoot, "raw"),
    wikiDir: join(dataRoot, "wiki"),
    env: process.env,
    now: NOW,
    onProgress: () => {},
  };
}

describe("slugError", () => {
  it("accepts lowercase kebab-case", () => {
    expect(slugError("attention-notes-2")).toBeUndefined();
  });

  it("rejects a slash in a slug", () => {
    expect(slugError("a/b")).toBeDefined();
  });

  it("rejects uppercase in a slug", () => {
    expect(slugError("Note")).toBeDefined();
  });

  it("rejects an empty slug", () => {
    expect(slugError("")).toBeDefined();
  });

  it("rejects a leading dash in a slug", () => {
    expect(slugError("-a")).toBeDefined();
  });
});

describe("runSandboxRun", () => {
  it("commits a sandbox-only run", async () => {
    const dataRoot = await makeRepo();

    const result = await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    expect(result.status).toBe("committed");

    await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    await readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "utf8");

    await readFile(join(dataRoot, "wiki", "log.md"), "utf8");
  });

  it("logs the sandbox commit in the audit log", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    const { stdout: log } = await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    expect(log.trim()).toBe("sandbox: note-slug");

    await readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "utf8");

    await readFile(join(dataRoot, "wiki", "log.md"), "utf8");
  });

  it("stamps the committed note with the agent via stamp", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "note-slug.md"),
      "utf8",
    );

    expect(note).toContain("via: agent");

    await readFile(join(dataRoot, "wiki", "log.md"), "utf8");
  });

  it("stamps the committed note with the expiry date", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    const note = await readFile(
      join(dataRoot, "wiki", "sandbox", "note-slug.md"),
      "utf8",
    );

    expect(note).toContain("expires: 2026-08-27");

    await readFile(join(dataRoot, "wiki", "log.md"), "utf8");
  });

  it("records the run in log.md", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    await readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "utf8");

    const logMd = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(logMd).toContain("## [2026-08-20] sandbox | note-slug");
  });

  it("leaves a clean tree after the sandbox commit", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "Note"\n---\nBody.\n',
      }),
    });

    await run("git", ["log", "--format=%s", "-1"], {
      cwd: dataRoot,
    });

    await readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "utf8");

    await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("drops a caller-supplied via stamp", async () => {
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
  });

  it("drops a caller-supplied expiry stamp", async () => {
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

    expect(note).not.toContain("1999-01-01");
  });

  it("stamps the note with the agent via stamp", async () => {
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

    expect(note).toContain("via: agent");
  });

  it("stamps the note with the expiry date", async () => {
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

    expect(note).toContain("expires: 2026-08-27");
  });

  it("reports empty for a run that wrote nothing", async () => {
    const dataRoot = await makeRepo();

    await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    const result = await sandboxRun(dataRoot, { runAgent: agentWriting({}) });

    expect(result).toEqual({ status: "empty" });

    await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });
  });

  it("leaves the tree untouched when nothing was written", async () => {
    const dataRoot = await makeRepo();

    const { stdout: before } = await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    await sandboxRun(dataRoot, { runAgent: agentWriting({}) });

    const { stdout: after } = await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    expect(after).toBe(before);
  });

  it("keeps the tree clean after an empty run", async () => {
    const dataRoot = await makeRepo();

    await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    await sandboxRun(dataRoot, { runAgent: agentWriting({}) });

    await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("writes no log entry for an empty run", async () => {
    const dataRoot = await makeRepo();

    await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    await sandboxRun(dataRoot, { runAgent: agentWriting({}) });

    await run("git", ["rev-parse", "HEAD"], {
      cwd: dataRoot,
    });

    await expect(readFile(join(dataRoot, "wiki", "log.md"))).rejects.toThrow();
  });

  it("fails the run naming the touched main page", async () => {
    const dataRoot = await makeRepo();

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

    await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });
  });

  it("restores the touched main page", async () => {
    const dataRoot = await makeRepo();

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

    await promise.catch(() => undefined);

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );

    await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });
  });

  it("keeps the pre-run dirty bytes of a tracked page", async () => {
    const dataRoot = await makeRepo();

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

    await promise.catch(() => undefined);

    expect(
      await readFile(join(dataRoot, "wiki", "dirty-page.md"), "utf8"),
    ).toBe("pre-run dirty work\n");

    await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });
  });

  it("reverts the run's sandbox page too", async () => {
    const dataRoot = await makeRepo();

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

    await promise.catch(() => undefined);

    await expect(
      readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md")),
    ).rejects.toThrow();

    await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });
  });

  it("keeps the pre-run audit log on violation", async () => {
    const dataRoot = await makeRepo();

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

    await promise.catch(() => undefined);

    const { stdout: log } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(log.trim().split("\n")).toEqual(["init"]);
  });

  it("fails the run whose agent touches the main tree", async () => {
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

    await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });
  });

  it("keeps a wiki-sync-era commit that landed mid-window", async () => {
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

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    const { stdout: log } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(log.trim().split("\n")).toEqual(["wiki-sync: cycle", "init"]);
  });

  it("keeps the mid-window synced page", async () => {
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

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await readFile(join(dataRoot, "wiki", "synced.md"), "utf8")).toBe(
      "synced\n",
    );
  });

  it("restores the main page the run dirtied", async () => {
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

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "# Index\n",
    );
  });

  it("refuses to run when the sandbox namespace is already dirty", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });

    await writeFile(
      join(dataRoot, "wiki", "sandbox", "other-note.md"),
      "uncommitted earlier work\n",
    );

    const agent: AgentRunner = async () => {
      return { stdout: "", stderr: "" };
    };

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /sandbox namespace is already dirty.*wiki\/sandbox\/other-note\.md/s,
    );
  });

  it("runs no agent when the sandbox namespace is dirty", async () => {
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

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(invoked).toBe(false);
  });

  it("keeps the earlier uncommitted sandbox work intact", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });

    await writeFile(
      join(dataRoot, "wiki", "sandbox", "other-note.md"),
      "uncommitted earlier work\n",
    );

    const agent: AgentRunner = async () => {
      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(
      await readFile(
        join(dataRoot, "wiki", "sandbox", "other-note.md"),
        "utf8",
      ),
    ).toBe("uncommitted earlier work\n");
  });

  it("refuses to run when wiki/log.md is already dirty", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "log.md"), "## stale audit entry\n");

    const agent: AgentRunner = async () => {
      return { stdout: "", stderr: "" };
    };

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /wiki\/log\.md is already dirty.*must not absorb/s,
    );
  });

  it("runs no agent when the audit log is dirty", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "log.md"), "## stale audit entry\n");

    let invoked = false;

    const agent: AgentRunner = async () => {
      invoked = true;

      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(invoked).toBe(false);
  });

  it("keeps the stale audit entry intact", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "log.md"), "## stale audit entry\n");

    const agent: AgentRunner = async () => {
      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      "## stale audit entry\n",
    );
  });

  it("refuses a colliding slug", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });

    await writeFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "old\n");

    await gitCommitAll(dataRoot, "seed sandbox note");

    await expect(
      sandboxRun(dataRoot, { runAgent: agentWriting({}) }),
    ).rejects.toThrow(/already exists.*identity/s);
  });

  it("leaves the existing sandbox page untouched", async () => {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "sandbox"), { recursive: true });

    await writeFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "old\n");

    await gitCommitAll(dataRoot, "seed sandbox note");

    await sandboxRun(dataRoot, { runAgent: agentWriting({}) }).catch(
      () => undefined,
    );

    expect(
      await readFile(join(dataRoot, "wiki", "sandbox", "note-slug.md"), "utf8"),
    ).toBe("old\n");
  });

  it("refuses a run whose instance points at another data repo", async () => {
    const dataRoot = await makeRepo();

    const otherRoot = await makeRepo();

    await expect(
      sandboxRun(dataRoot, {
        instance: instanceAt(otherRoot),
        runAgent: agentWriting({ "wiki/sandbox/note-slug.md": "x\n" }),
      }),
    ).rejects.toThrow(/wrong-repo accept-gate/);
  });

  it("leaves the other data repo's tree clean", async () => {
    const dataRoot = await makeRepo();

    const otherRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      instance: instanceAt(otherRoot),
      runAgent: agentWriting({ "wiki/sandbox/note-slug.md": "x\n" }),
    }).catch(() => undefined);

    expect(await statusOf(otherRoot)).toBe("");
  });

  it("fails the run reporting the reverted writes", async () => {
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
  });

  it("names the agent's own failure as the cause", async () => {
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

    expect((failure.cause as Error).message).toBe("agent died mid-run");
  });

  it("reverts the sandbox writes when the agent fails", async () => {
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

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("fails the run when nothing was written", async () => {
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
  });

  it("names the agent's explosion as the cause", async () => {
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

    expect((failure.cause as Error).message).toBe("stub agent exploded");
  });

  it("rejects an invalid slug before any work", async () => {
    const dataRoot = await makeRepo();

    await expect(sandboxRun(dataRoot, { slug: "Not A Slug" })).rejects.toThrow(
      /kebab-case/,
    );
  });

  it("commits a multi-page sandbox run", async () => {
    const dataRoot = await makeRepo();

    const result = await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "A"\n---\nA.\n',
        "wiki/sandbox/note-slug-annex.md": "B.\n",
      }),
    });

    expect(result.status).toBe("committed");
  });

  it("reports the committed pages", async () => {
    const dataRoot = await makeRepo();

    const result = await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "A"\n---\nA.\n',
        "wiki/sandbox/note-slug-annex.md": "B.\n",
      }),
    });

    expect(
      result.status === "committed" ? [...result.pages].sort() : [],
    ).toEqual(["wiki/sandbox/note-slug-annex.md", "wiki/sandbox/note-slug.md"]);
  });

  it("commits exactly the sandbox pages and the audit log", async () => {
    const dataRoot = await makeRepo();

    await sandboxRun(dataRoot, {
      runAgent: agentWriting({
        "wiki/sandbox/note-slug.md": '---\ntitle: "A"\n---\nA.\n',
        "wiki/sandbox/note-slug-annex.md": "B.\n",
      }),
    });

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

  it("fails the run when the agent re-edits a pre-dirty page", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "dirty before run\n");

    const agent = agentWriting({ "wiki/index.md": "mangled by run\n" });

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /accept-gate failed/,
    );
  });

  it("restores the re-edited page to its pre-run bytes", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "dirty before run\n");

    const agent = agentWriting({ "wiki/index.md": "mangled by run\n" });

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      "dirty before run\n",
    );
  });

  it("fails the run when the agent stages an out-of-sandbox file", async () => {
    const dataRoot = await makeRepo();

    const agent: AgentRunner = async (_c, _a, options) => {
      await writeFile(join(options.cwd, "wiki", "rogue.md"), "rogue\n");
      await run("git", ["add", "--", "wiki/rogue.md"], {
        cwd: options.cwd,
      });

      return { stdout: "", stderr: "" };
    };

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /accept-gate failed/,
    );
  });

  it("leaves the tree fully clean after the revert", async () => {
    const dataRoot = await makeRepo();

    const agent: AgentRunner = async (_c, _a, options) => {
      await writeFile(join(options.cwd, "wiki", "rogue.md"), "rogue\n");
      await run("git", ["add", "--", "wiki/rogue.md"], {
        cwd: options.cwd,
      });

      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("removes the staged out-of-sandbox file", async () => {
    const dataRoot = await makeRepo();

    const agent: AgentRunner = async (_c, _a, options) => {
      await writeFile(join(options.cwd, "wiki", "rogue.md"), "rogue\n");
      await run("git", ["add", "--", "wiki/rogue.md"], {
        cwd: options.cwd,
      });

      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    await expect(
      readFile(join(dataRoot, "wiki", "rogue.md")),
    ).rejects.toThrow();
  });

  it("fails the run when the agent stages a pre-run untracked path", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "scratch.md"), "untracked before run\n");

    const agent: AgentRunner = async (_c, _a, options) => {
      await run("git", ["add", "--", "scratch.md"], { cwd: options.cwd });
      await writeFile(join(options.cwd, "scratch.md"), "mangled by run\n");

      return { stdout: "", stderr: "" };
    };

    await expect(sandboxRun(dataRoot, { runAgent: agent })).rejects.toThrow(
      /accept-gate failed/,
    );
  });

  it("restores the staged untracked file's bytes", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "scratch.md"), "untracked before run\n");

    const agent: AgentRunner = async (_c, _a, options) => {
      await run("git", ["add", "--", "scratch.md"], { cwd: options.cwd });
      await writeFile(join(options.cwd, "scratch.md"), "mangled by run\n");

      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await readFile(join(dataRoot, "scratch.md"), "utf8")).toBe(
      "untracked before run\n",
    );
  });

  it("restores the file's untracked status", async () => {
    const dataRoot = await makeRepo();

    await writeFile(join(dataRoot, "scratch.md"), "untracked before run\n");

    const agent: AgentRunner = async (_c, _a, options) => {
      await run("git", ["add", "--", "scratch.md"], { cwd: options.cwd });
      await writeFile(join(options.cwd, "scratch.md"), "mangled by run\n");

      return { stdout: "", stderr: "" };
    };

    await sandboxRun(dataRoot, { runAgent: agent }).catch(() => undefined);

    expect(await statusOf(dataRoot)).toBe("?? scratch.md\n");
  });

  it("fails the run reporting the epilogue failure", async () => {
    const dataRoot = await makeRepo();

    const agent = async () => {
      const note = join(dataRoot, "wiki", "sandbox", "note-slug.md");

      await mkdir(dirname(note), { recursive: true });
      await writeFile(note, "sandbox note\n");
      // The stamp step's write into this note will fail (EACCES for
      // a non-root runner) — the epilogue must revert everything.
      await chmod(note, 0o444);

      return { stdout: "", stderr: "" };
    };

    const failure = await sandboxRun(dataRoot, { runAgent: agent }).then(
      () => undefined,
      (error: Error) => error,
    );

    if (failure === undefined) {
      throw new Error("expected the epilogue to fail");
    }

    expect(failure.message).toMatch(/epilogue failed/);
  });

  it("reverts the run's writes when the epilogue fails", async () => {
    const dataRoot = await makeRepo();

    const agent = async () => {
      const note = join(dataRoot, "wiki", "sandbox", "note-slug.md");

      await mkdir(dirname(note), { recursive: true });
      await writeFile(note, "sandbox note\n");
      // The stamp step's write into this note will fail (EACCES for
      // a non-root runner) — the epilogue must revert everything.
      await chmod(note, 0o444);

      return { stdout: "", stderr: "" };
    };

    const failure = await sandboxRun(dataRoot, { runAgent: agent }).then(
      () => undefined,
      (error: Error) => error,
    );

    if (failure === undefined) {
      throw new Error("expected the epilogue to fail");
    }

    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: dataRoot },
    );

    expect(status).toBe("");
  });

  it("keeps the pre-run audit subjects", async () => {
    const dataRoot = await makeRepo();

    const agent = async () => {
      const note = join(dataRoot, "wiki", "sandbox", "note-slug.md");

      await mkdir(dirname(note), { recursive: true });
      await writeFile(note, "sandbox note\n");
      // The stamp step's write into this note will fail (EACCES for
      // a non-root runner) — the epilogue must revert everything.
      await chmod(note, 0o444);

      return { stdout: "", stderr: "" };
    };

    const failure = await sandboxRun(dataRoot, { runAgent: agent }).then(
      () => undefined,
      (error: Error) => error,
    );

    if (failure === undefined) {
      throw new Error("expected the epilogue to fail");
    }

    const { stdout: subjects } = await run("git", ["log", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(subjects.trim().split("\n")).toEqual(["init"]);
  });
});

describe("revertPathsToLastCommit", () => {
  /** A data repo holding one committed wiki/concepts/old.md page. */
  async function makeRenamedRepo(): Promise<string> {
    const dataRoot = await makeRepo();

    await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
    await writeFile(join(dataRoot, "wiki", "concepts", "old.md"), "page\n");
    await gitCommitAll(dataRoot, "seed page");

    return dataRoot;
  }

  it("restores an unstaged rename's origin to its committed bytes", async () => {
    const dataRoot = await makeRenamedRepo();

    await rm(join(dataRoot, "wiki", "concepts", "old.md"));

    await writeFile(join(dataRoot, "wiki", "concepts", "new.md"), "page\n");

    await revertPathsToLastCommit(runContextAt(dataRoot), [
      "wiki/concepts/new.md",
    ]);

    await expect(
      readFile(join(dataRoot, "wiki", "concepts", "old.md"), "utf8"),
    ).resolves.toBe("page\n");
  });

  it("leaves a clean tree after reverting an untracked rename", async () => {
    const dataRoot = await makeRenamedRepo();

    await rm(join(dataRoot, "wiki", "concepts", "old.md"));

    await writeFile(join(dataRoot, "wiki", "concepts", "new.md"), "page\n");

    await revertPathsToLastCommit(runContextAt(dataRoot), [
      "wiki/concepts/new.md",
    ]);

    expect(await statusOf(dataRoot)).toBe("");
  });

  it("restores a staged rename's origin to its committed bytes", async () => {
    const dataRoot = await makeRenamedRepo();

    await run("git", ["mv", "wiki/concepts/old.md", "wiki/concepts/new.md"], {
      cwd: dataRoot,
    });

    await revertPathsToLastCommit(runContextAt(dataRoot), [
      "wiki/concepts/new.md",
    ]);

    await expect(
      readFile(join(dataRoot, "wiki", "concepts", "old.md"), "utf8"),
    ).resolves.toBe("page\n");
  });

  it("leaves a clean tree after reverting a staged rename", async () => {
    const dataRoot = await makeRenamedRepo();

    await run("git", ["mv", "wiki/concepts/old.md", "wiki/concepts/new.md"], {
      cwd: dataRoot,
    });

    await revertPathsToLastCommit(runContextAt(dataRoot), [
      "wiki/concepts/new.md",
    ]);

    expect(await statusOf(dataRoot)).toBe("");
  });
});
