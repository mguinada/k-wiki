import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { generateFixtureVault, VAULT_NAME } from "../src/fixtures/generate.ts";
import {
  copyFileTolerant,
  isEagain,
  readFileTolerant,
} from "../src/sync/eagain.ts";
import { runPublishStage } from "../src/sync/publish.ts";
import { runSync } from "../src/sync/sync-vault.ts";

/**
 * EAGAIN materialize-and-retry (issue #216): iCloud dataless files
 * fail Node reads and copies with EAGAIN instead of blocking to
 * materialize. The helpers convert exactly one such failure into a
 * self-healing attempt — a delayed re-read, then a cat-equivalent
 * materializing read; a remove-and-recreate copy retry — while every
 * other error envelope is unchanged. Real filesystems cannot produce
 * EAGAIN, so every test mocks the failing primitive; `cat` stays real
 * wherever it must succeed.
 */

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    readFile: vi.fn(actual.readFile),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

/** The live error shape (2026-08-30 log): no `code`, errno -11. */
function eagainError(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Unknown system error -11, ${operation}`), {
    errno: -11,
  });
}

/** The same error, shaped for the execFile callback parameter. */
function catEagain(): Error & { code: null } {
  return Object.assign(new Error("Unknown system error -11, cat"), {
    errno: -11,
    code: null,
  });
}

/** A pass-through that rejects for `path` with `error`, every call. */
function rejectFor(
  error: Error,
  path: string,
): (candidate: unknown) => Promise<Buffer> {
  const passthrough = actualFs.readFile as (
    candidate: unknown,
  ) => Promise<Buffer>;

  return (candidate) =>
    candidate === path ? Promise.reject(error) : passthrough(candidate);
}

/** The same pass-through, shaped for `mockImplementation*`. */
function rejectReadFor(error: Error, path: string): typeof actualFs.readFile {
  return rejectFor(error, path) as unknown as typeof actualFs.readFile;
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(copyFile).mockReset();
  vi.mocked(execFile).mockReset();
});

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-eagain-"));

  tempDirs.push(dir);

  return dir;
}

describe("isEagain", () => {
  it("recognizes the mapped code form", () => {
    expect(
      isEagain(
        Object.assign(new Error("resource temporarily unavailable"), {
          code: "EAGAIN",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes the unmapped errno -11 form", () => {
    expect(isEagain(eagainError("read"))).toBe(true);
  });

  it("rejects other errors", () => {
    expect(
      isEagain(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      ),
    ).toBe(false);
  });
});

describe("readFileTolerant", () => {
  it("reads a healthy file without retrying", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "note.md");

    await writeFile(path, "# healthy\n");

    expect((await readFileTolerant(path, 0)).toString()).toBe("# healthy\n");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("recovers when EAGAIN strikes once", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "note.md");

    await writeFile(path, "materialized\n");
    vi.mocked(readFile).mockImplementationOnce(
      rejectReadFor(eagainError("read"), path),
    );

    expect((await readFileTolerant(path, 0)).toString()).toBe("materialized\n");
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to a cat-equivalent read when EAGAIN persists", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "note.md");

    await writeFile(path, "cat materializes me\n");
    vi.mocked(readFile).mockImplementation(
      rejectReadFor(eagainError("read"), path),
    );

    expect((await readFileTolerant(path, 0)).toString()).toBe(
      "cat materializes me\n",
    );
  });

  it("fails loudly with the EAGAIN error when even cat cannot read", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "note.md");

    vi.mocked(readFile).mockImplementation(async () =>
      Promise.reject(eagainError("read")),
    );
    vi.mocked(execFile).mockImplementationOnce(
      (_file, _args, _options, callback) => {
        callback?.(catEagain(), Buffer.alloc(0), Buffer.alloc(0));

        return undefined as never;
      },
    );

    await expect(readFileTolerant(path, 0)).rejects.toMatchObject({
      errno: -11,
    });
  });

  it("propagates a non-EAGAIN failure without retry", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "gone.md");

    await expect(readFileTolerant(path, 0)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

describe("copyFileTolerant", () => {
  it("copies onto a healthy target without retrying", async () => {
    const dir = await makeTempDir();
    const source = join(dir, "a.md");
    const target = join(dir, "b.md");

    await writeFile(source, "src\n");

    await copyFileTolerant(source, target);

    expect(await readFile(target, "utf8")).toBe("src\n");
    expect(copyFile).toHaveBeenCalledTimes(1);
  });

  it("removes the dataless target and retries once when EAGAIN strikes", async () => {
    const dir = await makeTempDir();
    const source = join(dir, "a.md");
    const target = join(dir, "b.md");

    await writeFile(source, "src\n");
    await writeFile(target, "stale stub\n");
    vi.mocked(copyFile).mockImplementationOnce(async (from, to) =>
      to === target
        ? Promise.reject(eagainError("copyfile"))
        : actualFs.copyFile(from, to),
    );

    await copyFileTolerant(source, target);

    expect(await readFile(target, "utf8")).toBe("src\n");
    expect(copyFile).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when the retried copy fails EAGAIN again", async () => {
    const dir = await makeTempDir();
    const source = join(dir, "a.md");
    const target = join(dir, "b.md");

    await writeFile(source, "src\n");
    vi.mocked(copyFile).mockImplementation(async () =>
      Promise.reject(eagainError("copyfile")),
    );

    await expect(copyFileTolerant(source, target)).rejects.toMatchObject({
      errno: -11,
    });
  });

  it("propagates a non-EAGAIN copy failure without retry", async () => {
    const dir = await makeTempDir();
    const source = join(dir, "gone.md");
    const target = join(dir, "b.md");

    await expect(copyFileTolerant(source, target)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(copyFile).toHaveBeenCalledTimes(1);
  });
});

interface VaultWorkspace {
  readonly configPath: string;
  readonly rawDir: string;
  readonly vaultRoot: string;
}

async function makeVaultWorkspace(): Promise<VaultWorkspace> {
  const dir = await makeTempDir();
  const vaultRoot = await generateFixtureVault(dir);
  const configPath = join(dir, "sync.json");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, exclude: "wiki:false" }],
    }),
  );

  return { configPath, rawDir: join(dir, "raw"), vaultRoot };
}

/** Run sync with the EAGAIN retry delay collapsed to zero, so the
 *  one-shot materialize-and-retry path runs without real waiting. */
async function runSyncAdvancingRetry(
  options: Parameters<typeof runSync>[0],
): Promise<Awaited<ReturnType<typeof runSync>>> {
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => {
    callback();

    return {} as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);

  try {
    return await runSync(options);
  } finally {
    timer.mockRestore();
  }
}

describe("runSync EAGAIN surface", () => {
  it("completes when a note read fails EAGAIN once", async () => {
    const ws = await makeVaultWorkspace();
    const notePath = join(ws.vaultRoot, "AI", "RAG.md");

    vi.mocked(readFile).mockImplementationOnce(
      rejectReadFor(eagainError("read"), notePath),
    );

    const { vaults } = await runSyncAdvancingRetry({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
    });

    expect(vaults[0]?.copied).toContain("AI/RAG.md");
  });

  it("fails loudly through the note-read envelope when EAGAIN persists", async () => {
    const ws = await makeVaultWorkspace();
    const notePath = join(ws.vaultRoot, "AI", "RAG.md");

    vi.mocked(readFile).mockImplementation(
      rejectReadFor(eagainError("read"), notePath),
    );
    vi.mocked(execFile).mockImplementationOnce(
      (_file, _args, _options, callback) => {
        callback?.(catEagain(), Buffer.alloc(0), Buffer.alloc(0));

        return undefined as never;
      },
    );

    await expect(
      runSyncAdvancingRetry({
        configPath: ws.configPath,
        rawDir: ws.rawDir,
      }),
    ).rejects.toThrow(
      `failed to read note "AI/RAG.md" in vault "${VAULT_NAME}"`,
    );
  });
});

interface PublishTree {
  readonly dataRoot: string;
  readonly mirror: string;
}

async function makePublishTree(): Promise<PublishTree> {
  const root = await makeTempDir();
  const dataRoot = join(root, "data");
  const mirror = join(root, "KWiki");

  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

  return { dataRoot, mirror };
}

describe("runPublishStage EAGAIN surface", () => {
  it("completes when the mirror copyfile fails EAGAIN once", async () => {
    const tree = await makePublishTree();
    const target = join(tree.mirror, "wiki", "index.md");

    vi.mocked(copyFile).mockImplementationOnce(async (from, to) =>
      to === target
        ? Promise.reject(eagainError("copyfile"))
        : actualFs.copyFile(from, to),
    );

    const result = await runPublishStage({
      dataRoot: tree.dataRoot,
      mirror: tree.mirror,
      include: ["wiki/**"],
    });

    expect(result.copied).toBe(1);
    expect(await readFile(target, "utf8")).toBe("# Index\n");
  });

  it("fails loudly when the copyfile retry fails EAGAIN again", async () => {
    const tree = await makePublishTree();

    vi.mocked(copyFile).mockImplementation(async () =>
      Promise.reject(eagainError("copyfile")),
    );

    await expect(
      runPublishStage({
        dataRoot: tree.dataRoot,
        mirror: tree.mirror,
        include: ["wiki/**"],
      }),
    ).rejects.toMatchObject({ errno: -11 });
  });
});
