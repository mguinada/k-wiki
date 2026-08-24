import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

import {
  cleanupWorkspaces,
  collectFiles,
  HEALTH_SCRIPT,
  runCli,
  SYNC_REPO_SCRIPT,
} from "./helpers.ts";

/**
 * sync-repo e2e (issue #74): the real CLI as a child process,
 * projecting a fixture git repository — with a stray data-repo
 * checkout and an unlisted node_modules inside it — into a raw dir,
 * then the health CLI over the result, including the freshness
 * warning after the source moves forward.
 */

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: "k-wiki e2e",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "k-wiki e2e",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
  HOME: process.env.HOME,
};

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all([
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    cleanupWorkspaces(),
  ]);
});

const ALLOWLIST = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "docs/*.md",
  "src/**/*.ts",
];

const SELECTED = [
  "AGENTS.md",
  "README.md",
  "docs/guide.md",
  "package.json",
  "src/a.ts",
  "src/deep/b.ts",
];

interface RepoWorkspace {
  readonly dir: string;
  readonly sourceRoot: string;
  readonly configPath: string;
  readonly rawDir: string;
}

async function put(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const path = join(root, ...relPath.split("/"));

  await mkdir(join(root, ...relPath.split("/").slice(0, -1)), {
    recursive: true,
  });
  await writeFile(path, content);
}

async function git(root: string, ...args: string[]): Promise<void> {
  await run("git", ["-C", root, ...args], { env: GIT_ENV });
}

async function makeWorkspace(): Promise<RepoWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-repo-e2e-"));
  const sourceRoot = join(dir, "source");

  tempDirs.push(dir);

  await put(sourceRoot, "README.md", "readme body\n");
  await put(sourceRoot, "AGENTS.md", "agents contract\n");
  await put(sourceRoot, "package.json", '{ "name": "k-wiki" }\n');
  await put(sourceRoot, "docs/guide.md", "guide\n");
  await put(sourceRoot, "src/a.ts", "export const a = 1;\n");
  await put(sourceRoot, "src/deep/b.ts", "export const b = 2;\n");
  await put(sourceRoot, "tests/unit.test.ts", "unlisted\n");
  await put(sourceRoot, "node_modules/pkg/index.js", "unlisted\n");
  await put(sourceRoot, "k-wiki-meta-data/src/stray.ts", "stray\n");
  await git(sourceRoot, "init", "--quiet");
  await git(sourceRoot, "add", "-A");
  await git(sourceRoot, "commit", "--quiet", "-m", "fixture");

  const configPath = join(dir, "sync-meta.json");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [
        {
          source: "repo",
          name: "k-wiki",
          root: sourceRoot,
          include: ALLOWLIST,
        },
      ],
    }),
    "utf8",
  );

  return { dir, sourceRoot, configPath, rawDir: join(dir, "raw") };
}

describe("sync-repo e2e", () => {
  it("prints help and exits 0 without side effects", async () => {
    const result = await runCli(SYNC_REPO_SCRIPT, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: sync-repo");
    expect(result.out).toContain("Default: the repo's own sync-meta.json.");
  });

  it("projects the allowlisted tree verbatim and namespaced, excluding a stray checkout", async () => {
    const ws = await makeWorkspace();

    const result = await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(result.code).toBe(0);
    expect(await collectFiles(join(ws.rawDir, "notes", "k-wiki"))).toEqual(
      SELECTED,
    );
    expect(
      await readFile(
        join(ws.rawDir, "notes", "k-wiki", "src/deep/b.ts"),
        "utf8",
      ),
    ).toBe("export const b = 2;\n");
  });

  it("records the source commit and root in the manifest", async () => {
    const ws = await makeWorkspace();

    await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);

    const manifest = JSON.parse(
      await readFile(join(ws.rawDir, "manifest.json"), "utf8"),
    );
    const { stdout } = await run(
      "git",
      ["-C", ws.sourceRoot, "rev-parse", "HEAD"],
      {
        env: GIT_ENV,
      },
    );

    expect(manifest.source_commit).toBe(stdout.trim());
    expect(manifest.source_root).toBe(ws.sourceRoot);
  });

  it("copies nothing on an unchanged second run", async () => {
    const ws = await makeWorkspace();

    await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);
    const second = await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(second.code).toBe(0);
    expect(second.out).toContain("sync complete: no changes");
  });

  it("fails loudly on a dirty source tree, writing nothing", async () => {
    const ws = await makeWorkspace();

    await put(ws.sourceRoot, "README.md", "dirty\n");

    const result = await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("uncommitted changes");
    await expect(readdir(ws.rawDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly on a vault config instead of a repo config", async () => {
    const ws = await makeWorkspace();
    const vaultConfig = join(ws.dir, "sync.json");

    await writeFile(
      vaultConfig,
      JSON.stringify({
        vaults: [
          { name: "Engineering", root: ws.sourceRoot, exclude: "wiki:false" },
        ],
      }),
      "utf8",
    );

    const result = await runCli(SYNC_REPO_SCRIPT, [vaultConfig, ws.rawDir]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("sync-vault");
  });

  it("health passes on the fresh projection and warns after the source moves", async () => {
    const ws = await makeWorkspace();

    await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);

    const fresh = await runCli(HEALTH_SCRIPT, [ws.rawDir]);

    expect(fresh.code).toBe(0);
    expect(fresh.out).toContain("healthy:");
    expect(fresh.err).toBe("");

    await put(ws.sourceRoot, "README.md", "readme body v2\n");
    await git(ws.sourceRoot, "add", "-A");
    await git(ws.sourceRoot, "commit", "--quiet", "-m", "move forward");

    const stale = await runCli(HEALTH_SCRIPT, [ws.rawDir]);

    expect(stale.code).toBe(0);
    expect(stale.err).toContain("check-raw: stale projection");

    const blocking = await runCli(HEALTH_SCRIPT, [
      "--fail-on-stale",
      ws.rawDir,
    ]);

    expect(blocking.code).toBe(1);
  });

  it("health stays quiet when the manifest carries no repo stamp", async () => {
    const ws = await makeWorkspace();

    await runCli(SYNC_REPO_SCRIPT, [ws.configPath, ws.rawDir]);

    const manifest = JSON.parse(
      await readFile(join(ws.rawDir, "manifest.json"), "utf8"),
    );

    delete manifest.source_commit;
    delete manifest.source_root;
    await writeFile(
      join(ws.rawDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const result = await runCli(HEALTH_SCRIPT, ["--fail-on-stale", ws.rawDir]);

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });
});
