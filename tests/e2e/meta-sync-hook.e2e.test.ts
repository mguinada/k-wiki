import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  HOOK_NAMES,
  metaSyncLogPath,
} from "../../src/schedule/meta-sync-hook.ts";
import { cleanupWorkspaces, repoRoot, runCli } from "./helpers.ts";

/**
 * setup-meta-sync e2e: the real installer and the real generated
 * hooks against a temp source repository with a stubbed cycle
 * runner — the fires a real LLM cycle stays a human check. The
 * installed hook's guard table runs against real git: merges
 * landing on main (fast-forward and merge commits) and
 * `pull --rebase` fire the detached cycle with the baked config;
 * a feature-branch merge, a linked-worktree merge, or an
 * untracked-laden tree log-and-skips. The
 * lock-skip and two-instance edges are scheduled-run behaviors,
 * covered by its own e2e lane. A temp HOME keeps the fire log
 * inside the workspace — the operator's ~/Library/Logs is never
 * touched.
 */

const SETUP_SCRIPT = join(repoRoot, "bin", "setup-meta-sync");

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all([
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    cleanupWorkspaces(),
  ]);
});

/** The stubbed cycle runner: records its argv and log override for
 *  the assertions; the real wrapper's behavior has its own lane. */
const STUB_RUNNER = `#!/usr/bin/env node
const fs = require("node:fs");
const dest = process.env.KWIKI_META_E2E_MARKER;
if (dest !== undefined) {
  fs.appendFileSync(
    dest,
    JSON.stringify({ argv: process.argv.slice(2), log: process.env.KWIKI_SCHEDULED_LOG }) + "\\n",
  );
}
`;

interface Workspace {
  readonly dir: string;
  readonly source: string;
  readonly dataRoot: string;
  readonly home: string;
  readonly logPath: string;
  readonly marker: string;
}

/** A temp source repo (branch main) with the meta configs, the stub
 *  runner, and an isolated HOME carrying the fire log. */
async function makeWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-meta-hook-e2e-"));
  const source = join(dir, "source");
  const dataRoot = join(dir, "k-wiki-meta-data");
  const home = join(dir, "home");
  const space: Workspace = {
    dir,
    source,
    dataRoot,
    home,
    logPath: metaSyncLogPath(home, process.platform),
    marker: join(dir, "cycle-fired.txt"),
  };

  tempDirs.push(dir);

  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(source, "sync-meta.json"),
    `${JSON.stringify({ dataRoot, vaults: [] }, null, 2)}\n`,
  );
  await writeFile(join(source, "settings-meta.yml"), "command: pi\n");
  await writeFile(join(source, "bin", "scheduled-run"), STUB_RUNNER);
  await writeFile(join(source, "README.md"), "readme\n");
  await git(space, source, "init", "--quiet", "--initial-branch=main");
  await git(space, source, "add", "-A");
  await git(space, source, "commit", "--quiet", "-m", "base");

  return space;
}

/** git with an isolated environment: empty HOME (no global config),
 *  no system config, an explicit identity — stock behavior on every
 *  machine, and the fire log lands in the workspace. */
async function git(
  space: Workspace,
  root: string,
  ...args: string[]
): Promise<{ readonly stdout: string }> {
  return run("git", ["-C", root, ...args], {
    env: gitEnv(space),
  });
}

/** The shared isolated env for git and the installer children — the
 *  marker reaches the stubbed cycle through the hook's inherited
 *  environment, exactly as launchd/operator shells pass it through. */
function gitEnv(space: Workspace): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: space.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "k-wiki e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "k-wiki e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
    KWIKI_META_E2E_MARKER: space.marker,
  };
}

/** Install (or uninstall) the hooks from the real launcher against
 *  the temp source repo, with the same isolated env the git calls
 *  use — the log path and ~ expansion key off that HOME. */
async function runInstaller(
  space: Workspace,
  args: readonly string[] = [],
  cwd: string = space.source,
): Promise<{
  readonly out: string;
  readonly err: string;
  readonly code: number | null;
}> {
  return runCli(SETUP_SCRIPT, args, {
    cwd,
    env: gitEnv(space),
  });
}

/** The fire log's contents, undefined until it exists non-empty. */
async function readLog(space: Workspace): Promise<string | undefined> {
  const text = (await readFile(space.logPath, "utf8").catch(() => "")).trim();

  return text === "" ? undefined : text;
}

/** Wait for the detached cycle's marker (or log line) to land. */
async function waitFor(
  probe: () => Promise<string | undefined>,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = await probe().catch(() => undefined);

    if (found !== undefined) {
      return found;
    }

    if (Date.now() > deadline) {
      return undefined;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Land a feature commit on main via a merge (fast-forward by
 *  default, "--no-ff" for a merge commit) — the post-merge trigger. */
async function mergeFeatureOnMain(
  space: Workspace,
  ...mergeArgs: string[]
): Promise<void> {
  await git(space, space.source, "checkout", "--quiet", "-b", "feature");
  await writeFile(join(space.source, "README.md"), "readme edited\n");
  await git(space, space.source, "commit", "--quiet", "-am", "feat");
  await git(space, space.source, "checkout", "--quiet", "main");
  await git(
    space,
    space.source,
    "merge",
    "--quiet",
    ...(mergeArgs.length > 0 ? mergeArgs : ["feature"]),
  );
}

/** The recorded cycle invocations, if any fired. */
async function fires(space: Workspace): Promise<string | undefined> {
  const raw = await readFile(space.marker, "utf8").catch(() => undefined);

  return raw === undefined || raw === "" ? undefined : raw;
}

describe("setup-meta-sync e2e", () => {
  it("installs both hooks into the source repo", async () => {
    const space = await makeWorkspace();

    const { out, code } = await runInstaller(space);
    const installed = await Promise.all(
      HOOK_NAMES.map(async (name) =>
        (
          await readFile(
            join(space.source, ".git", "hooks", name),
            "utf8",
          ).catch(() => undefined)
        )?.startsWith("#!/bin/sh"),
      ),
    );

    expect({ code, out, installed }).toEqual({
      code: 0,
      out: expect.stringContaining("installed post-merge, post-rewrite"),
      installed: [true, true],
    });
  });

  it("fires the detached cycle when a merge lands on main", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);
    await mergeFeatureOnMain(space);

    const raw = await waitFor(() => fires(space));
    const log = await waitFor(() => readLog(space));

    expect({ fired: raw !== undefined, log: log?.split("\n") ?? [] }).toEqual({
      fired: true,
      log: [
        expect.stringContaining(
          "[post-merge] merge on main, clean tree — firing detached meta cycle",
        ),
      ],
    });
  });

  it("passes the baked config to the fired cycle", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);
    await mergeFeatureOnMain(space);

    const raw = await waitFor(() => fires(space));

    // git resolves the canonical checkout through physical paths
    // (/private/var on macOS) — the baked paths follow git's answer.
    const { stdout } = await run(
      "git",
      [
        "-C",
        space.source,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { env: gitEnv(space) },
    );
    const canonical = dirname(stdout.trim());

    expect(JSON.parse(raw ?? "{}")).toEqual({
      argv: [
        "--settings",
        join(canonical, "settings-meta.yml"),
        join(canonical, "sync-meta.json"),
        join(space.dataRoot, "raw"),
      ],
      log: space.logPath,
    });
  });

  it("fires on a merge commit (--no-ff) landing on main", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);
    await mergeFeatureOnMain(space, "--no-ff", "feature");

    const raw = await waitFor(() => fires(space));

    expect(raw).toBeDefined();
  });

  it("skips, logged, when the merge lands on a feature branch", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);
    await git(space, space.source, "checkout", "--quiet", "-b", "feature");
    await writeFile(join(space.source, "README.md"), "readme edited\n");
    await git(space, space.source, "commit", "--quiet", "-am", "feat");
    await git(
      space,
      space.source,
      "checkout",
      "--quiet",
      "-b",
      "integration",
      "main",
    );
    await git(space, space.source, "merge", "--quiet", "--no-ff", "feature");

    const log = await waitFor(async () => {
      const text = await readLog(space);

      return text?.includes("skip") === true ? text : undefined;
    });

    expect({
      skipped: log,
      fired: await fires(space),
    }).toEqual({
      skipped: expect.stringContaining(
        "[post-merge] skip: current branch is integration, not main",
      ),
      fired: undefined,
    });
  });

  it("skips, logged, when the merge lands on main in a linked worktree", async () => {
    const space = await makeWorkspace();
    const worktree = join(space.dir, "linked-worktree");

    await runInstaller(space);

    // The finding's layout: the canonical checkout sits on a
    // feature branch while main is merged in a linked worktree —
    // the shared hooks dir serves that worktree too, and the
    // unguarded hook would project the canonical checkout's
    // feature-branch tree into the meta data repo.
    await git(space, space.source, "checkout", "--quiet", "-b", "feature");
    await git(
      space,
      space.source,
      "worktree",
      "add",
      "--quiet",
      worktree,
      "main",
    );
    await git(space, worktree, "checkout", "--quiet", "-b", "side");
    await writeFile(join(worktree, "README.md"), "readme via worktree\n");
    await git(space, worktree, "commit", "--quiet", "-am", "side");
    await git(space, worktree, "checkout", "--quiet", "main");
    await git(space, worktree, "merge", "--quiet", "--no-ff", "side");

    const log = await waitFor(async () => {
      const text = await readLog(space);

      return text?.includes("skip") === true ? text : undefined;
    });

    expect({
      skipped: log,
      fired: await fires(space),
    }).toEqual({
      skipped: expect.stringContaining("[post-merge] skip: fired in "),
      fired: undefined,
    });
  });

  it("skips, logged, when the tree carries untracked files", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);
    await writeFile(join(space.source, "scratch.txt"), "operator scratch\n");
    await mergeFeatureOnMain(space);

    const log = await waitFor(async () => {
      const text = await readLog(space);

      return text?.includes("skip") === true ? text : undefined;
    });

    expect({
      skipped: log,
      fired: await fires(space),
    }).toEqual({
      skipped: expect.stringContaining(
        "[post-merge] skip: working tree not clean",
      ),
      fired: undefined,
    });
  });

  it("fires on a pull --rebase landing commits on main", async () => {
    const space = await makeWorkspace();
    const origin = join(space.dir, "origin.git");
    const clone = join(space.dir, "clone");

    await run("git", ["clone", "--quiet", "--bare", space.source, origin], {
      env: gitEnv(space),
    });
    await git(space, space.source, "remote", "add", "origin", origin);
    await git(space, space.source, "push", "--quiet", "origin", "HEAD:main");
    await run("git", ["clone", "--quiet", origin, clone], {
      env: gitEnv(space),
    });

    // The clone carries its own hooks: the installer runs with
    // cwd = clone, so SRC bakes to the clone itself.
    await runInstaller(space, [], clone);
    await writeFile(join(clone, "local.txt"), "local\n");
    await git(space, clone, "add", "-A");
    await git(space, clone, "commit", "--quiet", "-m", "local");
    await writeFile(join(space.source, "README.md"), "remote edit\n");
    await git(space, space.source, "commit", "--quiet", "-am", "remote");
    await git(space, space.source, "push", "--quiet", origin, "HEAD:main");
    await git(space, clone, "pull", "--quiet", "--rebase");

    const raw = await waitFor(() => fires(space));

    expect(raw).toBeDefined();
  });

  it("re-install is a no-op when the hooks are current", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);

    const { out, code } = await runInstaller(space);

    expect({ code, out }).toEqual({
      code: 0,
      out: expect.stringContaining("already current"),
    });
  });

  it("uninstalls both hooks and leaves nothing behind", async () => {
    const space = await makeWorkspace();

    await runInstaller(space);

    const { out, code } = await runInstaller(space, ["--uninstall"]);
    const gone = await Promise.all(
      HOOK_NAMES.map(
        async (name) =>
          (await readFile(
            join(space.source, ".git", "hooks", name),
            "utf8",
          ).catch((error: NodeJS.ErrnoException) => error.code)) === "ENOENT",
      ),
    );

    expect({ code, out, gone }).toEqual({
      code: 0,
      out: expect.stringContaining("removed post-merge, post-rewrite"),
      gone: [true, true],
    });
  });

  it("uninstall reports cleanly when nothing is installed", async () => {
    const space = await makeWorkspace();

    const { out, code } = await runInstaller(space, ["--uninstall"]);

    expect({ code, out }).toEqual({
      code: 0,
      out: expect.stringContaining("nothing (not installed)"),
    });
  });
});
