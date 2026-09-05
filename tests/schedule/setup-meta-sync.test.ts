import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BRANCH,
  metaSyncHookScript,
} from "../../src/schedule/meta-sync-hook.ts";
import { main, parseMetaSyncArgs } from "../../src/schedule/setup-meta-sync.ts";

/**
 * The setup-meta-sync installer over injected git + temp dirs — the
 * real ~/Library/Logs and the repo's own .git/hooks are never
 * touched. The hook content itself is tests/schedule/
 * meta-sync-hook.test.ts; real git merges firing the stubbed cycle
 * are tests/e2e/meta-sync-hook.e2e.test.ts.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));

  tempDirs.push(dir);

  return dir;
}

describe("parseMetaSyncArgs", () => {
  it("defaults to install with no flags", () => {
    expect(parseMetaSyncArgs([])).toEqual({
      print: false,
      uninstall: false,
      error: undefined,
    });
  });

  it("parses --print and --uninstall", () => {
    expect([
      parseMetaSyncArgs(["--print"]).print,
      parseMetaSyncArgs(["--uninstall"]).uninstall,
    ]).toEqual([true, true]);
  });

  it("rejects unknown flags", () => {
    expect(parseMetaSyncArgs(["--nonsense"]).error).toContain("--nonsense");
  });

  it("rejects positionals", () => {
    expect(parseMetaSyncArgs(["extra"]).error).toContain("no positionals");
  });
});

/** A fake git answering the installer's two rev-parse questions for
 *  a temp repo whose shared dir sits at <root>/.git. */
function fakeGit(root: string) {
  return async (_dir: string, args: readonly string[]): Promise<string> => {
    if (args.includes("--git-common-dir")) {
      return join(root, ".git");
    }

    if (args.includes("hooks")) {
      return join(root, ".git", "hooks");
    }

    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

interface Checkout {
  readonly root: string;
  readonly home: string;
  readonly deps: NonNullable<Parameters<typeof main>[1]>;
}

/** One temp checkout with a valid sync-meta.json; deps wired to it. */
async function tempCheckout(prefix = "k-wiki-setup-meta-"): Promise<Checkout> {
  const root = await tempDir(prefix);
  const home = await tempDir(`${prefix}home-`);
  const dataRoot = join(home, "k-wiki-meta-data");

  await writeFile(
    join(root, "sync-meta.json"),
    JSON.stringify({ dataRoot, vaults: [] }),
  );

  return {
    root,
    home,
    deps: { platform: "darwin", home, cwd: root, git: fakeGit(root) },
  };
}

/** Run main() with console captured and the exit code read back. */
async function runMain(
  args: readonly string[],
  deps: NonNullable<Parameters<typeof main>[1]>,
): Promise<{
  readonly out: string;
  readonly err: string;
  readonly exitCode: string | number | undefined;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  process.exitCode = undefined;

  try {
    await main(args, deps);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const exitCode = process.exitCode;

  process.exitCode = undefined;

  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

/** Seed a foreign operator hook (the hooks dir may not exist yet). */
async function putForeign(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\n# operator-owned hook\n");
}

/** The node path the installer baked into an installed hook. */
async function bakedNodePath(hookPath: string): Promise<string> {
  const line = (await readFile(hookPath, "utf8"))
    .split("\n")
    .find((candidate) => candidate.startsWith("NODE="));

  return line?.slice("NODE='".length, -1) ?? "";
}

beforeEach(() => {
  process.exitCode = undefined;
});

describe("main install", () => {
  it("writes both hooks executable with the generated content", async () => {
    const { deps, home, root } = await tempCheckout();

    await runMain([], deps);

    const nodePath = await bakedNodePath(
      join(root, ".git", "hooks", "post-merge"),
    );
    const expected = metaSyncHookScript({
      nodePath,
      sourceRoot: root,
      settingsPath: join(root, "settings-meta.yml"),
      configPath: join(root, "sync-meta.json"),
      rawDir: join(home, "k-wiki-meta-data", "raw"),
      logPath: join(home, "Library", "Logs", "kwiki", "meta-sync.log"),
      branch: DEFAULT_BRANCH,
    });
    const modes = await Promise.all(
      ["post-merge", "post-rewrite"].map(async (name) => {
        const info = await stat(join(root, ".git", "hooks", name));

        return [
          info.mode & 0o777,
          await readFile(join(root, ".git", "hooks", name), "utf8"),
        ] as const;
      }),
    );

    expect(modes).toEqual([
      [0o755, expected],
      [0o755, expected],
    ]);
  });

  it("is a no-op when both hooks are current", async () => {
    const { deps, root } = await tempCheckout();

    await runMain([], deps);

    const before = await readFile(
      join(root, ".git", "hooks", "post-merge"),
      "utf8",
    );
    const { out } = await runMain([], deps);
    const after = await readFile(
      join(root, ".git", "hooks", "post-merge"),
      "utf8",
    );

    expect({ report: out, unchanged: after === before }).toEqual({
      report: expect.stringContaining("already current"),
      unchanged: true,
    });
  });

  it("replaces an older generation of its own hook", async () => {
    const { deps, root } = await tempCheckout();

    await runMain([], deps);

    const hookPath = join(root, ".git", "hooks", "post-merge");
    const current = await readFile(hookPath, "utf8");

    await writeFile(hookPath, `${current}\n# old generation\n`);

    const { out } = await runMain([], deps);

    expect({
      report: out,
      rewritten: (await readFile(hookPath, "utf8")) === current,
    }).toEqual({
      report: expect.stringContaining("installed post-merge"),
      rewritten: true,
    });
  });

  it("refuses to overwrite a foreign hook, naming it", async () => {
    const { deps, root } = await tempCheckout();

    const foreign = join(root, ".git", "hooks", "post-merge");

    await putForeign(foreign);

    const { err, exitCode } = await runMain([], deps);

    expect({
      exitCode,
      err,
      untouched: (await readFile(foreign, "utf8")).includes("operator-owned"),
    }).toEqual({
      exitCode: 1,
      err: expect.stringContaining(foreign),
      untouched: true,
    });
  });

  it("fails loud outside a git repository", async () => {
    const { deps } = await tempCheckout();

    const throwing = {
      ...deps,
      git: async () => {
        throw new Error("fatal: not a git repository");
      },
    };

    const { err, exitCode } = await runMain([], throwing);

    expect({ exitCode, err }).toEqual({
      exitCode: 1,
      err: expect.stringContaining("not inside a git repository"),
    });
  });

  it("fails loud naming the config when dataRoot is absent", async () => {
    const { deps, root } = await tempCheckout();

    await writeFile(
      join(root, "sync-meta.json"),
      JSON.stringify({ vaults: [] }),
    );

    const { err, exitCode } = await runMain([], deps);

    expect({ exitCode, err }).toEqual({
      exitCode: 1,
      err: expect.stringContaining("no dataRoot in"),
    });
  });

  it("prints the hook without a git repo, keyed to the cwd", async () => {
    const { deps, home, root } = await tempCheckout();

    const noRepo = {
      ...deps,
      git: async () => {
        throw new Error("fatal: not a git repository");
      },
    };

    const { out, exitCode } = await runMain(["--print"], noRepo);

    expect({ exitCode, out }).toEqual({
      exitCode: undefined,
      out: expect.stringContaining(
        `SRC='${root}'\nSETTINGS='${join(root, "settings-meta.yml")}'\nCONFIG='${join(root, "sync-meta.json")}'\nRAW_DIR='${join(home, "k-wiki-meta-data", "raw")}'`,
      ),
    });
  });
});

describe("main uninstall", () => {
  it("removes exactly what it installed", async () => {
    const { deps, root } = await tempCheckout();

    await runMain([], deps);

    const { out } = await runMain(["--uninstall"], deps);

    const gone = await Promise.all(
      ["post-merge", "post-rewrite"].map(async (name) => {
        const missing = await stat(join(root, ".git", "hooks", name)).catch(
          (error: NodeJS.ErrnoException) => error.code,
        );

        return typeof missing === "string";
      }),
    );

    expect({ report: out, allGone: gone.every(Boolean) }).toEqual({
      report: expect.stringContaining("removed post-merge, post-rewrite"),
      allGone: true,
    });
  });

  it("reports cleanly when nothing is installed", async () => {
    const { deps } = await tempCheckout();

    const { out, exitCode } = await runMain(["--uninstall"], deps);

    expect({ exitCode, out }).toEqual({
      exitCode: undefined,
      out: expect.stringContaining("nothing (not installed)"),
    });
  });

  it("leaves a foreign hook untouched", async () => {
    const { deps, root } = await tempCheckout();

    const foreign = join(root, ".git", "hooks", "post-merge");

    await putForeign(foreign);

    const { err, exitCode } = await runMain(["--uninstall"], deps);

    expect({
      exitCode,
      err,
      untouched: (await readFile(foreign, "utf8")).includes("operator-owned"),
    }).toEqual({
      exitCode: 1,
      err: expect.stringContaining("foreign hook"),
      untouched: true,
    });
  });
});
