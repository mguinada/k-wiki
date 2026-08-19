import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkRaw, displayPath, main } from "../src/health/check-raw.ts";
import {
  type Manifest,
  serializeManifest,
  type VaultNotes,
} from "../src/sync/manifest.ts";

const NOTE = "---\nwiki: true\n---\n\n# Note\n";
const OTHER_NOTE = "---\nwiki: true\n---\n\n# Other note\n";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
});

async function makeRawDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-health-"));

  tempDirs.push(dir);

  return dir;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Write one projected note file under `raw/notes/<vault>/<relPath>`. */
async function projectNote(
  rawDir: string,
  vault: string,
  relPath: string,
  content: string,
): Promise<void> {
  const absolute = join(rawDir, "notes", vault, ...relPath.split("/"));

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function writeManifestFile(
  rawDir: string,
  vaults: Record<string, VaultNotes>,
): Promise<void> {
  const manifest: Manifest = { vaults };

  await mkdir(rawDir, { recursive: true });
  await writeFile(
    join(rawDir, "manifest.json"),
    serializeManifest(manifest),
    "utf8",
  );
}

/** A manifest entry whose hash matches the given content. */
function entryFor(content: string): { hash: string; last_synced: string } {
  return { hash: hashOf(content), last_synced: "2026-08-16T15:00:00.000Z" };
}

describe("checkRaw healthy-empty", () => {
  it("reports a healthy-empty projection when no manifest and no notes exist", async () => {
    const rawDir = await makeRawDir();

    const report = await checkRaw(rawDir);

    expect(report).toMatchObject({
      healthy: true,
      problems: [],
      summary:
        "healthy: empty projection (no manifest entries, no projected notes)",
    });
  });

  it("reports a healthy-empty projection when the manifest is empty and no notes exist", async () => {
    const rawDir = await makeRawDir();

    await writeManifestFile(rawDir, {});

    expect((await checkRaw(rawDir)).summary).toBe(
      "healthy: empty projection (no manifest entries, no projected notes)",
    );
  });

  it("ignores files that sit outside any vault namespace", async () => {
    const rawDir = await makeRawDir();

    await mkdir(join(rawDir, "notes"), { recursive: true });
    await writeFile(join(rawDir, "notes", ".gitkeep"), "");

    expect((await checkRaw(rawDir)).healthy).toBe(true);
  });
});

describe("checkRaw healthy projection", () => {
  it("agrees when every projected note matches its manifest hash", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).healthy).toBe(true);
  });

  it("summarizes the matched notes and vaults in the singular", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).summary).toBe(
      "healthy: manifest and projection agree (1 note, 1 vault)",
    );
  });

  it("returns no problems when every projected note matches its manifest hash", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([]);
  });

  it("does not count a namespace directory that holds no manifest entries and no files", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });
    await mkdir(join(rawDir, "notes", "Junk"), { recursive: true });

    expect((await checkRaw(rawDir)).summary).toBe(
      "healthy: manifest and projection agree (1 note, 1 vault)",
    );
  });

  it("summarizes the matched notes and vaults in the plural", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await projectNote(rawDir, "Journal", "day-1.md", OTHER_NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
      Journal: { "day-1.md": entryFor(OTHER_NOTE) },
    });

    expect((await checkRaw(rawDir)).summary).toBe(
      "healthy: manifest and projection agree (2 notes, 2 vaults)",
    );
  });
});

describe("checkRaw problems", () => {
  it("names the file when a projected note differs from its recorded hash", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(`${NOTE}tampered`) },
    });

    expect(await checkRaw(rawDir)).toMatchObject({
      healthy: false,
      problems: [
        "notes/Documents/AI/RAG.md: hash mismatch (file differs from manifest)",
      ],
    });
  });

  it("names an orphan file that has no manifest entry", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await projectNote(rawDir, "Documents", "AI/orphan.md", OTHER_NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/AI/orphan.md: orphan (no manifest entry)",
    ]);
  });

  it("names a non-markdown file under a namespace as an orphan", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await projectNote(rawDir, "Documents", "stray.txt", "not a projection");
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/stray.txt: orphan (no manifest entry)",
    ]);
  });

  it("names vault-noise file names under a namespace as orphans", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await projectNote(rawDir, "Documents", ".DS_Store", "");
    await projectNote(rawDir, "Documents", "note.md.bak", "old bytes");
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/.DS_Store: orphan (no manifest entry)",
      "notes/Documents/note.md.bak: orphan (no manifest entry)",
    ]);
  });

  it("names a symlink under a namespace as an orphan", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await mkdir(join(rawDir, "notes", "Documents"), { recursive: true });
    await symlink("../../outside", join(rawDir, "notes", "Documents", "leak"));
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/leak: orphan (no manifest entry)",
    ]);
  });

  it("names a missing file whose manifest entry is still present", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: {
        "AI/RAG.md": entryFor(NOTE),
        "Scratch/gone.md": entryFor(OTHER_NOTE),
      },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/Scratch/gone.md: missing (manifest entry without file)",
    ]);
  });

  it("names every entry of a manifest vault whose namespace directory is absent", async () => {
    const rawDir = await makeRawDir();

    await writeManifestFile(rawDir, {
      Documents: { "AI/gone.md": entryFor(NOTE) },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/AI/gone.md: missing (manifest entry without file)",
    ]);
  });

  it("names the orphan files of a namespace directory absent from the manifest", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Journal", "day-1.md", NOTE);

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Journal/day-1.md: orphan (no manifest entry)",
    ]);
  });

  it("names orphans when the manifest file does not exist but notes do", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/AI/RAG.md: orphan (no manifest entry)",
    ]);
  });

  it("reports one problem per line for multiple mismatches in sorted order", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await projectNote(rawDir, "Documents", "AI/orphan.md", OTHER_NOTE);
    await writeManifestFile(rawDir, {
      Documents: {
        "AI/RAG.md": entryFor(`${NOTE}tampered`),
        "Scratch/gone.md": entryFor(NOTE),
      },
    });

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Documents/AI/RAG.md: hash mismatch (file differs from manifest)",
      "notes/Documents/AI/orphan.md: orphan (no manifest entry)",
      "notes/Documents/Scratch/gone.md: missing (manifest entry without file)",
    ]);
  });

  it("lists problems of different vaults in namespace-sorted order", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Zeta", "note.md", NOTE);
    await projectNote(rawDir, "Alpha", "note.md", OTHER_NOTE);
    // Hand-written JSON: insertion order Zeta before Alpha, which a
    // sorted namespace walk must not leak into the report.
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      join(rawDir, "manifest.json"),
      JSON.stringify({
        vaults: {
          Zeta: { "note.md": entryFor(`${NOTE}x`) },
          Alpha: { "note.md": entryFor(`${OTHER_NOTE}x`) },
        },
      }),
    );

    expect((await checkRaw(rawDir)).problems).toEqual([
      "notes/Alpha/note.md: hash mismatch (file differs from manifest)",
      "notes/Zeta/note.md: hash mismatch (file differs from manifest)",
    ]);
  });

  it("returns an empty summary when problems are found", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);

    expect((await checkRaw(rawDir)).summary).toBe("");
  });

  it("reports an unparseable manifest as a problem", async () => {
    const rawDir = await makeRawDir();

    await mkdir(rawDir, { recursive: true });
    await writeFile(join(rawDir, "manifest.json"), "{ not json");

    expect((await checkRaw(rawDir)).problems).toEqual([
      "invalid manifest at manifest.json: not valid JSON",
    ]);
  });

  it("rejects with the raw read error when the manifest path is a directory", async () => {
    const rawDir = await makeRawDir();

    await mkdir(join(rawDir, "manifest.json"), { recursive: true });

    await expect(checkRaw(rawDir)).rejects.toThrow(
      "EISDIR: illegal operation on a directory, read",
    );
  });

  it("rejects with the raw read error when the notes path is a file", async () => {
    const rawDir = await makeRawDir();

    await writeFile(join(rawDir, "notes"), "not a directory");

    await expect(checkRaw(rawDir)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("rejects with the raw scan error when a namespace path is a file", async () => {
    const rawDir = await makeRawDir();

    await mkdir(join(rawDir, "notes"), { recursive: true });
    await writeFile(join(rawDir, "notes", "Journal"), "not a directory");
    await writeManifestFile(rawDir, {
      Journal: { "day-1.md": entryFor(NOTE) },
    });

    await expect(checkRaw(rawDir)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});

describe("checkRaw missing raw directory", () => {
  it("rejects when the raw directory does not exist", async () => {
    const missing = join(tmpdir(), "no-such-raw-dir");

    await expect(checkRaw(missing)).rejects.toThrow(
      `raw directory does not exist: ${missing}`,
    );
  });

  it("rejects when the raw directory is a file rather than a directory", async () => {
    const rawDir = await makeRawDir();
    const filePath = join(rawDir, "a-file.md");

    await writeFile(filePath, NOTE);

    await expect(checkRaw(filePath)).rejects.toThrow(
      "raw directory is not a directory:",
    );
  });
});

describe("displayPath", () => {
  it("prints a path inside the repository relative to the repository root", () => {
    expect(displayPath("/repo/raw/notes/x.md", "/repo/raw", "/repo")).toBe(
      "raw/notes/x.md",
    );
  });

  it("prints a path outside the repository relative to the raw directory", () => {
    expect(displayPath("/tmp/x/raw/notes/x.md", "/tmp/x/raw", "/repo")).toBe(
      "notes/x.md",
    );
  });
});

describe("health CLI", () => {
  async function runHealth(args: string[]): Promise<{
    out: string;
    err: string;
  }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

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
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("prints the healthy summary and exits 0 for a healthy projection", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);
    await writeManifestFile(rawDir, {
      Documents: { "AI/RAG.md": entryFor(NOTE) },
    });

    const { out } = await runHealth([rawDir]);

    expect(`${out}|${process.exitCode ?? 0}`).toBe(
      "healthy: manifest and projection agree (1 note, 1 vault)|0",
    );
  });

  it("exits 1 when a problem is found", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);

    await runHealth([rawDir]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the problem lines it found on stderr", async () => {
    const rawDir = await makeRawDir();

    await projectNote(rawDir, "Documents", "AI/RAG.md", NOTE);

    const { err } = await runHealth([rawDir]);

    expect(err).toContain("notes/Documents/AI/RAG.md: orphan");
  });

  it("defaults to the repository's own raw directory", async () => {
    const { out } = await runHealth([]);

    expect(out).toMatch(/^healthy:/);
  });

  it("exits 1 with an error message when the raw directory cannot be read", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const argv = process.argv;

    process.argv = [...argv.slice(0, 2), join(tmpdir(), "no-such-raw-dir")];

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
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(`${process.exitCode}|${err}`).toMatch(
      /^1\|check-raw: .*no-such-raw-dir/,
    );
  });
});

describe("check-raw import guard", () => {
  /**
   * A staged copy of src/ inside the test tree, importable in-process
   * with a controlled argv — the same trick as
   * tests/sync-cli-spawn.test.ts: under Stryker the sandbox holds the
   * mutated sources next to the tests, and a dynamic import executes
   * them here, where the active-mutant globals live.
   */
  const stagingRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    ".health-import-staging",
  );

  async function stageRepo(): Promise<string> {
    const dir = join(stagingRoot, randomUUID());
    const testsDir = dirname(fileURLToPath(import.meta.url));

    await mkdir(join(dir, "raw"), { recursive: true });
    await cp(join(testsDir, "../src"), join(dir, "src"), { recursive: true });

    return dir;
  }

  interface ImportOutcome {
    readonly out: string;
    readonly err: string;
  }

  async function importWithArgv(
    modulePath: string,
    argv1: string,
  ): Promise<ImportOutcome> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [argv[0] ?? "node", argv1];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await import(pathToFileURL(modulePath).href);
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  afterAll(async () => {
    await rm(stagingRoot, { recursive: true, force: true });
  });

  it("runs main when argv[1] is the module itself, with the default raw dir", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "health", "check-raw.ts");

    const { out } = await importWithArgv(modulePath, modulePath);

    expect(out).toBe(
      "healthy: empty projection (no manifest entries, no projected notes)",
    );
  });

  it("runs nothing when argv[1] is a different module", async () => {
    const repo = await stageRepo();
    const modulePath = join(repo, "src", "health", "check-raw.ts");

    const { out, err } = await importWithArgv(
      modulePath,
      join(repo, "other.js"),
    );

    expect(`${out}${err}`).toBe("");
  });
});
