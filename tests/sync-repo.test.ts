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
import { afterAll, describe, expect, it, vi } from "vitest";
import { runGit } from "../src/data/init-data-repo.ts";
import { loadSyncConfig } from "../src/sync/config.ts";
import { parseManifest } from "../src/sync/manifest.ts";
import { compileAllowlistPattern, runRepoSync } from "../src/sync/sync-repo.ts";

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
});

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

/** Every file below a directory, POSIX-style, sorted. */
async function collectFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(join(root, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files.sort();
}

describe("compileAllowlistPattern", () => {
  it("matches an exact path pattern only at that path", () => {
    const pattern = compileAllowlistPattern("README.md");

    expect(pattern.test("README.md")).toBe(true);
    expect(pattern.test("docs/README.md")).toBe(false);
    expect(pattern.test("README.md2")).toBe(false);
  });

  it("escapes regex metacharacters in a pattern", () => {
    const pattern = compileAllowlistPattern("package.json");

    expect(pattern.test("package.json")).toBe(true);
    expect(pattern.test("packageXjson")).toBe(false);
  });

  it("matches a single star within one path segment only", () => {
    const pattern = compileAllowlistPattern("docs/*.md");

    expect(pattern.test("docs/a.md")).toBe(true);
    expect(pattern.test("docs/sub/a.md")).toBe(false);
    expect(pattern.test("docsX/a.md")).toBe(false);
  });

  it("matches a double star across path segments", () => {
    const pattern = compileAllowlistPattern("src/**/*.ts");

    expect(pattern.test("src/a.ts")).toBe(true);
    expect(pattern.test("src/x/y/a.ts")).toBe(true);
    expect(pattern.test("srcx/a.ts")).toBe(false);
  });

  it("matches a leading double star at every depth", () => {
    const pattern = compileAllowlistPattern("**/*.md");

    expect(pattern.test("a.md")).toBe(true);
    expect(pattern.test("x/y/a.md")).toBe(true);
  });

  it("matches a trailing double star for everything below a prefix", () => {
    const pattern = compileAllowlistPattern("docs/**");

    expect(pattern.test("docs/a.md")).toBe(true);
    expect(pattern.test("docs/x/b.ts")).toBe(true);
    expect(pattern.test("docsX/a.md")).toBe(false);
  });
});

describe("runRepoSync first run", () => {
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

  it("excludes unlisted subtrees and files from the projection", async () => {
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
    expect(projected).not.toContain("node_modules");
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

  it("reports the namespace, the commit, and per-file counts", async () => {
    const ws = await makeWorkspace();

    const report = await runRepoSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      env: GIT_ENV,
    });

    expect(report.source).toBe(NAME);
    expect(report.commit).toBe(await head(ws.sourceRoot));
    expect(report.selected).toBe(SELECTED.length);
    expect([...report.copied].sort()).toEqual(SELECTED);
    expect(report.removed).toEqual([]);
  });
});

describe("runRepoSync second run", () => {
  it("copies nothing when neither the tree nor the commit changed", async () => {
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

    expect(second.copied).toEqual([]);
    expect(second.removed).toEqual([]);
    expect([...second.unchanged].sort()).toEqual(SELECTED);
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

    expect(second.copied).toEqual(["src/a.ts"]);
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

    expect(second.removed).toEqual(["src/deep/b.ts"]);
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

    expect([...second.removed].sort()).toEqual(
      SELECTED.filter((path) => !path.startsWith("src/")),
    );
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
  it("prints usage and exits 0 without side effects", async () => {
    const { main } = await import("../src/sync/sync-repo.ts");
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
    expect(process.exitCode).toBeUndefined();
  });
});

describe("shipped sync-meta.json (issue #74)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("parses as one repo source for the k-wiki namespace", async () => {
    const config = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );

    expect(config.vaults).toHaveLength(1);
    expect(config.vaults[0]?.kind).toBe("repo");
    expect(config.vaults[0]?.name).toBe("k-wiki");
  });

  it("selects the implementation tree and excludes tests, scripts, and dependencies", async () => {
    const { vaults } = await loadSyncConfig(
      join(repoRoot, "sync-meta.json"),
      homedir(),
    );
    const source = vaults[0];

    if (source?.kind !== "repo") {
      throw new Error("sync-meta.json must hold one repo source");
    }

    const matchers = source.include.map(compileAllowlistPattern);
    const matches = (path: string) =>
      matchers.some((matcher) => matcher.test(path));

    expect(matches("src/sync/sync-vault.ts")).toBe(true);
    expect(matches("wiki/AGENTS.md")).toBe(true);
    expect(matches("prompts/ingest.md")).toBe(true);
    expect(matches("docs/karpathy_wiki_implementation_guide.md")).toBe(true);
    expect(matches("package.json")).toBe(true);
    expect(matches("tests/sync-repo.test.ts")).toBe(false);
    expect(matches("scripts/check-links.ts")).toBe(false);
    expect(matches("node_modules/vitest/index.js")).toBe(false);
    expect(matches("k-wiki-meta-data/wiki/index.md")).toBe(false);
  });
});
