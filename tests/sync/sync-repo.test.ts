import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../src/data/git.ts";
import { loadSyncConfig } from "../../src/sync/config.ts";
import { parseManifest } from "../../src/sync/manifest.ts";
import {
  compileIncludePattern,
  type RepoSyncReport,
  type SyncReport,
} from "../../src/sync/projection.ts";
import {
  repoRowOf,
  runRepoSync,
  selectRepoFiles,
} from "../../src/sync/sync-repo.ts";
import { collectFiles } from "../e2e/helpers.ts";

/**
 * sync-repo unit tests (issue #74): the repo-as-source adapter. A real
 * (fixture) git repository is projected under raw/notes/<name>/ through
 * the same manifest machinery as vault sync; the allowlist decides
 * selection by construction.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: "k-wiki test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "k-wiki test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  HOME: process.env.HOME,
};

const NAME = "k-wiki";

const ALLOWLIST = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "docs/*.md",
  "prompts/*.md",
  "src/**/*.ts",
];

/** The projected file set of ALLOWLIST against the fixture tree below. */
const SELECTED = [
  "AGENTS.md",
  "README.md",
  "docs/guide.md",
  "package.json",
  "prompts/ingest.md",
  "src/a.ts",
  "src/deep/b.ts",
];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-repo-"));

  tempDirs.push(dir);

  return dir;
}

/** Write a file, creating parent directories. */
async function put(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const path = join(root, ...relPath.split("/"));

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** A committed source repository with allowlisted files, unlisted
 *  files, an unlisted subtree, and a stray data-repo checkout. */
async function makeSourceRepo(dir: string): Promise<string> {
  const root = join(dir, "source");

  await put(root, "README.md", "readme body\n");
  await put(root, "AGENTS.md", "agents contract\n");
  await put(root, "package.json", '{ "name": "k-wiki" }\n');
  await put(root, "docs/guide.md", "guide\n");
  await put(root, "docs/extra/deep.md", "deep doc\n");
  await put(root, "prompts/ingest.md", "prompt\n");
  await put(root, "src/a.ts", "export const a = 1;\n");
  await put(root, "src/deep/b.ts", "export const b = 2;\n");
  await put(root, "tests/unit.test.ts", "unlisted test\n");
  await put(root, "node_modules/pkg/index.js", "unlisted dependency\n");
  await put(root, "k-wiki-meta-data/raw/README.md", "stray\n");
  await put(root, "k-wiki-meta-data/src/x.ts", "stray src\n");

  await commitAll(root);

  return root;
}

async function commitAll(root: string): Promise<void> {
  await runGit(root, ["init", "--quiet"], GIT_ENV);
  await runGit(root, ["add", "-A"], GIT_ENV);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"], GIT_ENV);
}

async function writeConfig(
  dir: string,
  entry: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, "sync.json");

  await writeFile(path, JSON.stringify({ vaults: [entry] }), "utf8");

  return path;
}

interface RepoWorkspace {
  readonly configPath: string;
  readonly rawDir: string;
  readonly sourceRoot: string;
  readonly dir: string;
}

/** A committed source repo plus a matching repo-source config and raw dir. */
async function makeWorkspace(): Promise<RepoWorkspace> {
  const dir = await makeTempDir();
  const sourceRoot = await makeSourceRepo(dir);
  const configPath = await writeConfig(dir, {
    source: "repo",
    name: NAME,
    root: sourceRoot,
    include: ALLOWLIST,
  });

  return { configPath, rawDir: join(dir, "raw"), sourceRoot, dir };
}

async function head(root: string): Promise<string> {
  const { stdout } = await runGit(root, ["rev-parse", "HEAD"], GIT_ENV);

  return stdout.trim();
}

/** Every file below a directory, POSIX-style, sorted — shared with
 *  the e2e suite via tests/e2e/helpers.ts. */

describe("runRepoSync first run", () => {
  it("uses the threaded config instead of re-parsing the file", async () => {
    const ws = await makeWorkspace();
    const config = await loadSyncConfig(ws.configPath);

    // A config file the parser must refuse: only the threaded object
    // can drive the projection (R-1, one sync.json parse per run).
    await writeFile(ws.configPath, "{ not json");

    const report = await runRepoSync({
      configPath: ws.configPath,
      config,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(report.sources).toHaveLength(1);
  });
  it("projects exactly the allowlisted files, namespaced under raw/notes/<name>/", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(await collectFiles(join(ws.rawDir, "notes", NAME))).toEqual(
      SELECTED,
    );
  });

  it("keeps the projected bytes verbatim", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(
      await readFile(join(ws.rawDir, "notes", NAME, "src/a.ts"), "utf8"),
    ).toBe("export const a = 1;\n");
  });

  it("excludes a stray data-repo checkout inside the source repo by construction", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const projected = await collectFiles(join(ws.rawDir, "notes", NAME));

    expect(projected.some((path) => path.startsWith("k-wiki-meta-data/"))).toBe(
      false,
    );
  });

  it("excludes unlisted test files from the projection", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const projected = (await collectFiles(join(ws.rawDir, "notes", NAME))).join(
      "\n",
    );

    expect(projected).not.toContain("tests/unit.test.ts");
  });

  it("excludes dependency subtrees from the projection", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const projected = (await collectFiles(join(ws.rawDir, "notes", NAME))).join(
      "\n",
    );

    expect(projected).not.toContain("node_modules");
  });

  it("excludes an unlisted subtree from the projection", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const projected = (await collectFiles(join(ws.rawDir, "notes", NAME))).join(
      "\n",
    );

    expect(projected).not.toContain("docs/extra/deep.md");
  });

  it("records every projected file in the manifest with its hash", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const manifestPath = join(ws.rawDir, "manifest.json");
    const manifest = parseManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    );

    expect(Object.keys(manifest.vaults[NAME] ?? {}).sort()).toEqual(SELECTED);
  });

  it("records the source repo HEAD commit in the manifest", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const manifest = JSON.parse(
      await readFile(join(ws.rawDir, "manifest.json"), "utf8"),
    );

    expect(manifest.source_commit).toBe(await head(ws.sourceRoot));
  });

  it("records the source repo root in the manifest", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const manifest = JSON.parse(
      await readFile(join(ws.rawDir, "manifest.json"), "utf8"),
    );

    expect(manifest.source_root).toBe(ws.sourceRoot);
  });

  it("names the projected namespace in the run report", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(report).name).toBe(NAME);
  });

  it("stamps the source commit in the run report", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(report).commit).toBe(await head(ws.sourceRoot));
  });

  it("shortens the stamped commit to eight characters in the report line", async () => {
    const ws = await makeWorkspace();

    const lines: string[] = [];
    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      onProgress: (line) => lines.push(line.text),
    });

    expect(lines.join("\n")).toMatch(/selected at commit [0-9a-f]{8}$/m);
  });

  it("counts every candidate file in the run report", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(report).candidates).toBe(8);
  });

  it("counts the selected files in the run report", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(report).selected).toBe(SELECTED.length);
  });

  it("lists the copied files in the run report", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect([...repoRowOf(report).copied].sort()).toEqual(SELECTED);
  });

  it("lists no removed files in the first run report", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(report).removed).toEqual([]);
  });
});

describe("runRepoSync second run", () => {
  it("copies no files when neither the tree nor the commit changed", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });
    const second = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(second).copied).toEqual([]);
  });

  it("removes no files when neither the tree nor the commit changed", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });
    const second = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(second).removed).toEqual([]);
  });

  it("keeps every projection unchanged when neither the tree nor the commit changed", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });
    const second = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect([...repoRowOf(second).unchanged].sort()).toEqual(SELECTED);
  });

  it("recopies a file that changed in a new commit", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    await writeFile(join(ws.sourceRoot, "src/a.ts"), "export const a = 2;\n");
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "edit"], GIT_ENV);

    const second = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(second).copied).toEqual(["src/a.ts"]);
  });

  it("writes the new bytes of a changed file into the projection", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    await writeFile(join(ws.sourceRoot, "src/a.ts"), "export const a = 2;\n");
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "edit"], GIT_ENV);

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(
      await readFile(join(ws.rawDir, "notes", NAME, "src/a.ts"), "utf8"),
    ).toBe("export const a = 2;\n");
  });

  it("records the new commit SHA after the source moved forward", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    await writeFile(join(ws.sourceRoot, "README.md"), "readme body v2\n");
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "edit"], GIT_ENV);

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const manifest = JSON.parse(
      await readFile(join(ws.rawDir, "manifest.json"), "utf8"),
    );

    expect(manifest.source_commit).toBe(await head(ws.sourceRoot));
  });

  it("removes a projection whose source file was deleted", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    await rm(join(ws.sourceRoot, "src/deep/b.ts"));
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "delete"], GIT_ENV);

    const second = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(repoRowOf(second).removed).toEqual(["src/deep/b.ts"]);
  });

  it("deletes the projected file on disk when its source was deleted", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    await rm(join(ws.sourceRoot, "src/deep/b.ts"));
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "delete"], GIT_ENV);

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(await collectFiles(join(ws.rawDir, "notes", NAME))).not.toContain(
      "src/deep/b.ts",
    );
  });

  it("prunes the empty parent directory of a removed projection", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    await rm(join(ws.sourceRoot, "src/deep/b.ts"));
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "delete"], GIT_ENV);

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(await readdir(join(ws.rawDir, "notes", NAME, "src"))).toEqual([
      "a.ts",
    ]);
  });

  it("removes a projection that left the allowlist", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const narrowed = await writeConfig(ws.dir, {
      source: "repo",
      name: NAME,
      root: ws.sourceRoot,
      include: ["src/**/*.ts"],
    });

    const second = await runRepoSync({
      configPath: narrowed,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect([...repoRowOf(second).removed].sort()).toEqual(
      SELECTED.filter((path) => !path.startsWith("src/")),
    );
  });

  it("keeps only the still-allowlisted files after the allowlist narrows", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const narrowed = await writeConfig(ws.dir, {
      source: "repo",
      name: NAME,
      root: ws.sourceRoot,
      include: ["src/**/*.ts"],
    });

    await runRepoSync({
      configPath: narrowed,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(await collectFiles(join(ws.rawDir, "notes", NAME))).toEqual([
      "src/a.ts",
      "src/deep/b.ts",
    ]);
  });
});

describe("runRepoSync guardrails", () => {
  it("rejects a config whose only source is a vault", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfig(dir, {
      name: "Engineering",
      root: join(dir, "vault"),
      exclude: "wiki:false",
    });

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/belongs to sync-vault/);
  });

  it("rejects a config with no sources", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [] }), "utf8");

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/no repo source/);
  });

  it("rejects a config with more than one repo source", async () => {
    const dir = await makeTempDir();
    const sourceRoot = await makeSourceRepo(dir);
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          { source: "repo", name: "one", root: sourceRoot, include: ["*.md"] },
          { source: "repo", name: "two", root: sourceRoot, include: ["*.ts"] },
        ],
      }),
      "utf8",
    );

    await expect(
      runRepoSync({
        configPath,
        rawDir: join(dir, "raw"),
        env: GIT_ENV,
      }),
    ).rejects.toThrow(/exactly one repo source/);
  });

  it("rejects a source root that is not a git repository", async () => {
    const dir = await makeTempDir();
    const plain = join(dir, "plain");

    await put(plain, "README.md", "no git\n");
    await put(plain, ".gitkeep", "");

    const configPath = await writeConfig(dir, {
      source: "repo",
      name: NAME,
      root: plain,
      include: ["README.md"],
    });

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/not a git repository|no commit/);
  });

  it("rejects a source repository whose HEAD cannot be read", async () => {
    const dir = await makeTempDir();
    const commitless = join(dir, "commitless");

    await mkdir(commitless, { recursive: true });
    await runGit(commitless, ["init", "--quiet"], GIT_ENV);

    const configPath = await writeConfig(dir, {
      source: "repo",
      name: NAME,
      root: commitless,
      include: ["README.md"],
    });

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/cannot read HEAD of source repo/);
  });

  it("rejects a source repository with an uncommitted working tree", async () => {
    const dir = await makeTempDir();
    const sourceRoot = await makeSourceRepo(dir);

    await writeFile(join(sourceRoot, "README.md"), "dirty\n");

    const configPath = await writeConfig(dir, {
      source: "repo",
      name: NAME,
      root: sourceRoot,
      include: ALLOWLIST,
    });

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/uncommitted changes/);
  });
});

describe("sync-repo CLI help", () => {
  it("prints usage for --help", async () => {
    const { main } = await import("../../src/sync/sync-repo.ts");
    const argv = process.argv;
    const out: string[] = [];

    process.argv = [...argv.slice(0, 2), "--help"];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
    }

    expect(out.join("\n")).toContain("Usage: sync-repo");
  });

  it("leaves the exit code unset for --help", async () => {
    const { main } = await import("../../src/sync/sync-repo.ts");
    const argv = process.argv;
    const out: string[] = [];

    process.argv = [...argv.slice(0, 2), "--help"];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
    }

    expect(process.exitCode).toBeUndefined();
  });
});

describe("shipped sync-meta.json (issue #74)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  it("parses sync-meta.json as a single vault entry", async () => {
    const config = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );

    expect(config.vaults).toHaveLength(1);
  });

  it("parses the shipped source as a repo source", async () => {
    const config = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );

    expect(config.vaults[0]?.kind).toBe("repo");
  });

  it("parses the shipped repo source for the k-wiki namespace", async () => {
    const config = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );

    expect(config.vaults[0]?.name).toBe("k-wiki");
  });

  it("accepts the implementation tree paths", async () => {
    const { vaults } = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );
    const source = vaults[0];

    if (source?.kind !== "repo") {
      throw new Error("sync-meta.json must hold one repo source");
    }

    const matchers = source.include.map(compileIncludePattern);
    const includes = (path: string) =>
      matchers.some((matcher) => matcher.test(path));

    expect(
      [
        "src/sync/sync-vault.ts",
        "wiki/AGENTS.md",
        "prompts/ingest.md",
        "docs/karpathy_wiki_implementation_guide.md",
        "package.json",
      ].filter(includes),
    ).toEqual([
      "src/sync/sync-vault.ts",
      "wiki/AGENTS.md",
      "prompts/ingest.md",
      "docs/karpathy_wiki_implementation_guide.md",
      "package.json",
    ]);
  });

  it("excludes tests, scripts, and dependencies from the shipped include set", async () => {
    const { vaults } = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );
    const source = vaults[0];

    if (source?.kind !== "repo") {
      throw new Error("sync-meta.json must hold one repo source");
    }

    const matchers = source.include.map(compileIncludePattern);
    const includes = (path: string) =>
      matchers.some((matcher) => matcher.test(path));

    expect(
      [
        "tests/sync/sync-repo.test.ts",
        "scripts/check-links.ts",
        "node_modules/vitest/index.js",
        "k-wiki-meta-data/wiki/index.md",
      ].filter(includes),
    ).toEqual([]);
  });
});

describe("selectRepoFiles walker gaps", () => {
  it("counts every walked file once across overlapping walk roots", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    await put(root, "src/pkg/one.ts", "one\n");
    await put(root, "src/pkg/deeper/two.ts", "two\n");
    await runGit(root, ["add", "-A"], GIT_ENV);
    await runGit(root, ["commit", "--quiet", "-m", "more"], GIT_ENV);

    const { candidates, selected } = await selectRepoFiles(root, [
      "src/**",
      "src/pkg/**",
    ]);

    expect(candidates).toBe(selected.length);
  });

  it("counts an exact file only once when a walk root also covers it", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    await put(root, "src/pkg/one.ts", "one\n");
    await put(root, "src/pkg/deeper/two.ts", "two\n");
    await runGit(root, ["add", "-A"], GIT_ENV);
    await runGit(root, ["commit", "--quiet", "-m", "more"], GIT_ENV);

    const { candidates, selected } = await selectRepoFiles(root, [
      "src/pkg/one.ts",
      "src/**",
    ]);

    expect(candidates).toBe(selected.length);
  });

  it("selects a mid-path single star at exactly one directory level", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    await put(root, "src/pkg/one.ts", "one\n");
    await put(root, "src/pkg/deeper/two.ts", "two\n");
    await runGit(root, ["add", "-A"], GIT_ENV);
    await runGit(root, ["commit", "--quiet", "-m", "more"], GIT_ENV);

    const { selected } = await selectRepoFiles(root, ["src/*/one.ts"]);

    expect(selected).toEqual(["src/pkg/one.ts"]);
  });

  it("skips a missing allowlisted exact file without failing", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    const { selected } = await selectRepoFiles(root, [
      "README.md",
      "ABSENT.md",
    ]);

    expect(selected).toEqual(["README.md"]);
  });

  it("skips a missing allowlisted walk root without failing", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    const { candidates, selected } = await selectRepoFiles(root, [
      "README.md",
      "absent-dir/**",
    ]);

    expect(candidates).toBe(1);
    expect(selected).toEqual(["README.md"]);
  });

  it("skips .git and node_modules while keeping every other markdown file", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    await put(root, "node_modules/x/hidden.md", "hidden\n");
    await put(root, ".git/HEAD.md", "hidden\n");
    await put(root, "loose.md", "loose\n");

    const { selected } = await selectRepoFiles(root, ["**/*.md"]);

    for (const [path, present] of [
      ["README.md", true],
      ["AGENTS.md", true],
      ["docs/guide.md", true],
      ["loose.md", true],
      ["node_modules/x/hidden.md", false],
      [".git/HEAD.md", false],
    ] as const) {
      expect(selected.includes(path)).toBe(present);
    }
  });
});

describe("runRepoSync mixed-source configs", () => {
  it("rejects a config mixing vault and repo sources on the vault entry", async () => {
    const dir = await makeTempDir();
    const sourceRoot = await makeSourceRepo(dir);
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          {
            source: "repo",
            name: NAME,
            root: sourceRoot,
            include: ["README.md"],
          },
          {
            name: "Engineering",
            root: join(dir, "vault"),
            exclude: "wiki:false",
          },
        ],
      }),
      "utf8",
    );

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/"Engineering" is a vault source/);
  });

  it("names the count when several repo sources are configured", async () => {
    const dir = await makeTempDir();
    const sourceRoot = await makeSourceRepo(dir);
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          { source: "repo", name: "one", root: sourceRoot, include: ["*.md"] },
          { source: "repo", name: "two", root: sourceRoot, include: ["*.ts"] },
        ],
      }),
      "utf8",
    );

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/got 2/);
  });
});

describe("sync-repo CLI main", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  interface Captured {
    out: string;
    err: string;
  }

  async function runMainCli(args: string[]): Promise<Captured> {
    const { main } = await import("../../src/sync/sync-repo.ts");
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];
    const hadNoColor = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";
    process.argv = [...argv.slice(0, 2), ...args];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;

      if (hadNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = hadNoColor;
      }

      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("reports sync complete with the raw dir resolved from the config dataRoot", async () => {
    const ws = await makeWorkspace();
    const dataRoot = join(ws.dir, "meta-data");
    const configPath = join(ws.dir, "sync-dataroot.json");

    await writeFile(
      configPath,
      JSON.stringify({
        dataRoot,
        vaults: [
          {
            source: "repo",
            name: NAME,
            root: ws.sourceRoot,
            include: ALLOWLIST,
          },
        ],
      }),
      "utf8",
    );

    const result = await runMainCli([configPath]);

    expect(result.out).toContain("sync complete");
  });

  it("writes the manifest under the config dataRoot when the raw dir arg is absent", async () => {
    const ws = await makeWorkspace();
    const dataRoot = join(ws.dir, "meta-data");
    const configPath = join(ws.dir, "sync-dataroot.json");

    await writeFile(
      configPath,
      JSON.stringify({
        dataRoot,
        vaults: [
          {
            source: "repo",
            name: NAME,
            root: ws.sourceRoot,
            include: ALLOWLIST,
          },
        ],
      }),
      "utf8",
    );

    await runMainCli([configPath]);

    expect(
      await readFile(join(dataRoot, "raw", "manifest.json"), "utf8"),
    ).toContain("source_commit");
  });

  it("reports the source repo commit of the projection", async () => {
    const ws = await makeWorkspace();
    const result = await runMainCli([ws.configPath, ws.rawDir]);

    expect(result.out).toContain("source repo at commit ");
  });

  it("reports the per-namespace selected, copied, unchanged, and removed counts", async () => {
    const ws = await makeWorkspace();
    const result = await runMainCli([ws.configPath, ws.rawDir]);

    expect(result.out).toContain(
      `repo "k-wiki": 7 selected, 7 copied, 0 unchanged, 0 removed`,
    );
  });

  it("reports the total copied count on success", async () => {
    const ws = await makeWorkspace();
    const result = await runMainCli([ws.configPath, ws.rawDir]);

    expect(result.out).toContain("sync complete: 7 copied");
  });

  it("leaves the exit code unset on success", async () => {
    const ws = await makeWorkspace();

    await runMainCli([ws.configPath, ws.rawDir]);

    expect(process.exitCode).toBeUndefined();
  });

  it("prefixes the error line with sync-repo when the config holds no repo source", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: "Engineering", root: dir, exclude: "wiki:false" }],
      }),
      "utf8",
    );

    const result = await runMainCli([configPath, join(dir, "raw")]);

    expect(result.err).toContain("sync-repo:");
  });

  it("names the offending vault source in the error line", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: "Engineering", root: dir, exclude: "wiki:false" }],
      }),
      "utf8",
    );

    const result = await runMainCli([configPath, join(dir, "raw")]);

    expect(result.err).toContain("sync-vault");
  });

  it("exits 1 when the config holds no repo source", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: "Engineering", root: dir, exclude: "wiki:false" }],
      }),
      "utf8",
    );

    await runMainCli([configPath, join(dir, "raw")]);

    expect(process.exitCode).toBe(1);
  });

  it("bolds the repo name of progress lines at the render boundary", async () => {
    const ws = await makeWorkspace();
    const hadNoColor = process.env.NO_COLOR;

    delete process.env.NO_COLOR;

    const argv = process.argv;
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), ws.configPath, ws.rawDir];

    const { main } = await import("../../src/sync/sync-repo.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();

      if (hadNoColor !== undefined) {
        process.env.NO_COLOR = hadNoColor;
      }
    }

    const bold = "\u001b[1m";
    const reset = "\u001b[22m";

    expect(err.join("\n")).toContain(`repo ${bold}"k-wiki"${reset}:`);
  });
});

describe("repoRowOf", () => {
  it("returns the repo row of a report that carries one", () => {
    const row: RepoSyncReport = {
      kind: "repo",
      name: NAME,
      commit: "a1b2c3d4e5f6a7b8",
      candidates: 8,
      selected: 7,
      copied: [],
      unchanged: [],
      removed: [],
    };
    const report: SyncReport = { sources: [row], prunedNamespaces: [] };

    expect(repoRowOf(report)).toBe(row);
  });

  it("rejects a report that carries no repo row", () => {
    const report: SyncReport = { sources: [], prunedNamespaces: [] };

    expect(() => repoRowOf(report)).toThrow(
      "repo sync report carries no repo source row",
    );
  });
});

describe("selectRepoFiles error paths", () => {
  it("rethrows a walk error that is not a missing directory", async () => {
    const dir = await makeTempDir();
    const root = await makeSourceRepo(dir);

    await expect(
      selectRepoFiles(root, ["docs/guide.md/**/*.md"]),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("runRepoSync inaccessible roots", () => {
  it("rejects a source root that does not exist", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfig(dir, {
      source: "repo",
      name: NAME,
      root: join(dir, "missing"),
      include: ALLOWLIST,
    });

    await expect(
      runRepoSync({ configPath, rawDir: join(dir, "raw"), env: GIT_ENV }),
    ).rejects.toThrow(/is not accessible/);
  });
});

describe("runRepoSync manifest entry carry-forward", () => {
  const T1 = "2026-08-23T10:00:00.000Z";
  const T2 = "2026-08-23T12:00:00.000Z";

  it("advances last_synced for the changed file", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      now: () => new Date(T1),
    });

    await put(ws.sourceRoot, "src/a.ts", "export const a = 2;\n");
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "edit"], GIT_ENV);

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      now: () => new Date(T2),
    });

    const manifestPath = join(ws.rawDir, "manifest.json");
    const notes = parseManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    ).vaults[NAME];

    expect(notes?.["src/a.ts"]?.last_synced).toBe(T2);
  });

  it("keeps last_synced for an untouched file", async () => {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      now: () => new Date(T1),
    });

    await put(ws.sourceRoot, "src/a.ts", "export const a = 2;\n");
    await runGit(ws.sourceRoot, ["add", "-A"], GIT_ENV);
    await runGit(ws.sourceRoot, ["commit", "--quiet", "-m", "edit"], GIT_ENV);

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      now: () => new Date(T2),
    });

    const manifestPath = join(ws.rawDir, "manifest.json");
    const notes = parseManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    ).vaults[NAME];

    expect(notes?.["src/deep/b.ts"]?.last_synced).toBe(T1);
  });
});

describe("runRepoSync stale namespace pruning", () => {
  /** The workspace after a first sync, reconfigured to a new name. */
  async function renamedWorkspace(): Promise<{
    ws: RepoWorkspace;
    renamedConfig: string;
  }> {
    const ws = await makeWorkspace();

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const renamedConfig = await writeConfig(ws.dir, {
      source: "repo",
      name: "kw",
      root: ws.sourceRoot,
      include: ALLOWLIST,
    });

    return { ws, renamedConfig };
  }

  it("drops the manifest section of a renamed source", async () => {
    const { ws, renamedConfig } = await renamedWorkspace();

    await runRepoSync({
      configPath: renamedConfig,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    const manifestPath = join(ws.rawDir, "manifest.json");
    const manifest = parseManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    );

    expect(Object.keys(manifest.vaults)).toEqual(["kw"]);
  });

  it("deletes the projected tree of a renamed source", async () => {
    const { ws, renamedConfig } = await renamedWorkspace();

    await runRepoSync({
      configPath: renamedConfig,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual(
      SELECTED.map((rel) => `kw/${rel}`),
    );
  });

  it("deletes an orphan namespace directory without a manifest entry", async () => {
    const ws = await makeWorkspace();

    await mkdir(join(ws.rawDir, "notes", "Retired"), { recursive: true });
    await writeFile(join(ws.rawDir, "notes", "Retired", "Old.md"), "# old\n");
    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(await readdir(join(ws.rawDir, "notes"))).toEqual([NAME]);
  });

  it("lists pruned namespaces in the run report", async () => {
    const { ws, renamedConfig } = await renamedWorkspace();

    const second = await runRepoSync({
      configPath: renamedConfig,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(second.prunedNamespaces).toEqual([NAME]);
  });

  it("announces each removed namespace as progress", async () => {
    const { ws, renamedConfig } = await renamedWorkspace();
    const messages: string[] = [];

    await runRepoSync({
      configPath: renamedConfig,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      onProgress: (message) => messages.push(message.text),
    });

    expect(messages).toContain(
      `repo "${NAME}": removed stale namespace (not configured)`,
    );
  });
});

describe("runRepoSync caller-provided context", () => {
  it("announces the raw dir on the first progress line", async () => {
    const ws = await makeWorkspace();
    const progress: string[] = [];

    await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
      onProgress: (message) => progress.push(message.text),
    });

    expect(progress).toContain(`sync-repo: raw dir ${ws.rawDir}`);
  });

  it("expands a leading ~ in the source root against the given home", async () => {
    const ws = await makeWorkspace();
    const configPath = await writeConfig(ws.dir, {
      source: "repo",
      name: NAME,
      root: "~/source",
      include: ALLOWLIST,
    });

    await runRepoSync({
      configPath,
      rawDir: ws.rawDir,
      home: ws.dir,
      env: GIT_ENV,
    });

    expect(await collectFiles(join(ws.rawDir, "notes", NAME))).toEqual(
      SELECTED,
    );
  });

  it("runs its git commands with the caller's environment", async () => {
    const ws = await makeWorkspace();

    await expect(
      runRepoSync({
        configPath: ws.configPath,
        rawDir: ws.rawDir,
        env: { ...GIT_ENV, GIT_DIR: join(ws.dir, "no-such-git-dir") },
      }),
    ).rejects.toThrow("not a git repository");
  });
});
