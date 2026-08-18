import { createHash } from "node:crypto";
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
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { generateFixtureVault, VAULT_NAME } from "../src/fixtures/generate.ts";
import { parseManifest } from "../src/sync/manifest.ts";
import { main, runSync } from "../src/sync/sync-vault.ts";

const T1 = "2026-08-16T15:00:00.000Z";
const T2 = "2026-08-16T16:00:00.000Z";

const SELECTED_PATHS = [
  "AI/RAG.md",
  "AI/llms/attention-is-all-you-need.md",
  "AI/rag-evaluation-notes.md",
  "Scratch/temp-research.md",
];

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-vault-"));

  tempDirs.push(dir);

  return dir;
}

interface Workspace {
  readonly dir: string;
  readonly vaultRoot: string;
  readonly configPath: string;
  readonly rawDir: string;
}

async function makeWorkspace(
  options: { root?: string; name?: string } = {},
): Promise<Workspace> {
  const dir = await makeTempDir();
  const vaultRoot = await generateFixtureVault(dir);
  const configPath = join(dir, "sync.json");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [
        {
          name: options.name ?? VAULT_NAME,
          root: options.root ?? vaultRoot,
          select: "wiki:true",
        },
      ],
    }),
  );

  return { dir, vaultRoot, configPath, rawDir: join(dir, "raw") };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

async function run(ws: Workspace, iso: string = T1) {
  return runSync({
    configPath: ws.configPath,
    rawDir: ws.rawDir,
    now: fixedClock(iso),
  });
}

async function readManifestOf(ws: Workspace) {
  const path = join(ws.rawDir, "manifest.json");

  return parseManifest(await readFile(path, "utf8"), path);
}

function sourcePath(ws: Workspace, relPath: string): string {
  return join(ws.vaultRoot, ...relPath.split("/"));
}

function rawNotePath(ws: Workspace, relPath: string): string {
  return join(ws.rawDir, "notes", VAULT_NAME, ...relPath.split("/"));
}

/** Recursively collect POSIX-style relative file paths under root. */
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

describe("runSync first run", () => {
  it("copies exactly the wiki:true notes into raw/notes/<vault>", async () => {
    const ws = await makeWorkspace();

    await run(ws);

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual(
      SELECTED_PATHS.map((rel) => `${VAULT_NAME}/${rel}`),
    );
  });

  it("copies note bytes unchanged", async () => {
    const ws = await makeWorkspace();

    await run(ws);

    expect(await readFile(rawNotePath(ws, "AI/RAG.md"), "utf8")).toBe(
      await readFile(sourcePath(ws, "AI/RAG.md"), "utf8"),
    );
  });

  it("reports every selected note as copied", async () => {
    const ws = await makeWorkspace();

    expect(await run(ws)).toEqual([
      {
        vault: VAULT_NAME,
        selected: 4,
        copied: SELECTED_PATHS,
        unchanged: [],
        removed: [],
      },
    ]);
  });

  it("records the sha-256 hash of each note in the manifest", async () => {
    const ws = await makeWorkspace();

    await run(ws);

    const bytes = await readFile(sourcePath(ws, "AI/RAG.md"));
    const expected = createHash("sha256").update(bytes).digest("hex");

    expect(
      (await readManifestOf(ws)).vaults[VAULT_NAME]?.["AI/RAG.md"]?.hash,
    ).toBe(expected);
  });

  it("records the sync time of each note in the manifest", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);

    expect(
      (await readManifestOf(ws)).vaults[VAULT_NAME]?.["AI/RAG.md"]?.last_synced,
    ).toBe(T1);
  });

  it("rejects when the vault root does not exist", async () => {
    const ws = await makeWorkspace({ root: "/nonexistent/vault" });

    await expect(run(ws)).rejects.toThrow(/not accessible/);
  });
});

describe("runSync idempotence", () => {
  it("copies and removes nothing on the second run", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    const second = await run(ws, T2);

    expect(second).toEqual([
      {
        vault: VAULT_NAME,
        selected: 4,
        copied: [],
        unchanged: SELECTED_PATHS,
        removed: [],
      },
    ]);
  });

  it("leaves the manifest byte-identical on the second run", async () => {
    const ws = await makeWorkspace();
    const path = join(ws.rawDir, "manifest.json");

    await run(ws, T1);
    const first = await readFile(path, "utf8");

    await run(ws, T2);

    expect(await readFile(path, "utf8")).toBe(first);
  });

  it("leaves the copied notes byte-identical on the second run", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    const first = await readFile(rawNotePath(ws, "AI/RAG.md"));

    await run(ws, T2);

    expect(await readFile(rawNotePath(ws, "AI/RAG.md"))).toEqual(first);
  });
});

describe("runSync edit detection", () => {
  it("copies exactly the edited note on the next run", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await writeFile(
      sourcePath(ws, "AI/rag-evaluation-notes.md"),
      "---\ntags:\n  - AI\n  - evaluation\nwiki: true\n---\n\n# RAG evaluation notes\n\nEdited body.\n",
    );

    expect((await run(ws, T2))[0]?.copied).toEqual([
      "AI/rag-evaluation-notes.md",
    ]);
  });

  it("updates the edited note's hash in the manifest", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await writeFile(
      sourcePath(ws, "AI/rag-evaluation-notes.md"),
      "---\nwiki: true\n---\n\n# RAG evaluation notes\n\nEdited body.\n",
    );
    await run(ws, T2);

    const bytes = await readFile(sourcePath(ws, "AI/rag-evaluation-notes.md"));
    const expected = createHash("sha256").update(bytes).digest("hex");

    expect(
      (await readManifestOf(ws)).vaults[VAULT_NAME]?.[
        "AI/rag-evaluation-notes.md"
      ]?.hash,
    ).toBe(expected);
  });

  it("advances last_synced only for the edited note", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await writeFile(
      sourcePath(ws, "AI/rag-evaluation-notes.md"),
      "---\nwiki: true\n---\n\n# RAG evaluation notes\n\nEdited body.\n",
    );
    await run(ws, T2);

    const notes = (await readManifestOf(ws)).vaults[VAULT_NAME];

    expect(notes?.["AI/rag-evaluation-notes.md"]?.last_synced).toBe(T2);
    expect(notes?.["AI/RAG.md"]?.last_synced).toBe(T1);
  });
});

describe("runSync removal detection", () => {
  it("removes the raw copy when the source note disappears", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    const report = await run(ws, T2);

    expect(report[0]?.removed).toEqual(["Scratch/temp-research.md"]);
  });

  it("deletes the raw file of the removed note", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    await run(ws, T2);

    await expect(
      readFile(rawNotePath(ws, "Scratch/temp-research.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops the removed note from the manifest", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    await run(ws, T2);

    expect(
      Object.hasOwn(
        (await readManifestOf(ws)).vaults[VAULT_NAME] ?? {},
        "Scratch/temp-research.md",
      ),
    ).toBe(false);
  });

  it("prunes the directory the removal emptied", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    await run(ws, T2);

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual(
      [
        "AI/RAG.md",
        "AI/llms/attention-is-all-you-need.md",
        "AI/rag-evaluation-notes.md",
      ].map((rel) => `${VAULT_NAME}/${rel}`),
    );
  });

  it("removes the raw copy when the note loses its flag", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await writeFile(
      sourcePath(ws, "Scratch/temp-research.md"),
      "---\ntags:\n  - scratch\nwiki: false\n---\n\n# Temp research\n",
    );

    expect((await run(ws, T2))[0]?.removed).toEqual([
      "Scratch/temp-research.md",
    ]);
  });
});

describe("runSync home expansion", () => {
  it("syncs a vault whose root is a tilde path", async () => {
    const ws = await makeWorkspace({ root: `~/${VAULT_NAME}` });
    const reports = await runSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      home: ws.dir,
      now: fixedClock(T1),
    });

    expect(reports[0]?.copied).toEqual(SELECTED_PATHS);
  });
});

describe("runSync multiple vaults", () => {
  async function makeTwoVaultWorkspace(): Promise<Workspace> {
    const dir = await makeTempDir();
    const documentsRoot = await generateFixtureVault(dir);
    const journalRoot = join(dir, "Journal");

    await mkdir(join(journalRoot, "Daily"), { recursive: true });
    await writeFile(
      join(journalRoot, "Daily", "day-1.md"),
      "---\nwiki: true\n---\n\n# Day 1\n",
    );
    await writeFile(
      join(journalRoot, "day-2.md"),
      "---\nwiki: true\n---\n\n# Day 2\n",
    );

    const configPath = join(dir, "sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          { name: VAULT_NAME, root: documentsRoot, select: "wiki:true" },
          { name: "Journal", root: journalRoot, select: "wiki:true" },
        ],
      }),
    );

    return {
      dir,
      vaultRoot: documentsRoot,
      configPath,
      rawDir: join(dir, "raw"),
    };
  }

  it("keeps each vault's files under its own namespace", async () => {
    const ws = await makeTwoVaultWorkspace();

    await run(ws);

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual([
      "Documents/AI/RAG.md",
      "Documents/AI/llms/attention-is-all-you-need.md",
      "Documents/AI/rag-evaluation-notes.md",
      "Documents/Scratch/temp-research.md",
      "Journal/Daily/day-1.md",
      "Journal/day-2.md",
    ]);
  });

  it("keys the manifest by vault name", async () => {
    const ws = await makeTwoVaultWorkspace();

    await run(ws);

    expect(Object.keys((await readManifestOf(ws)).vaults).sort()).toEqual([
      "Documents",
      "Journal",
    ]);
  });

  it("preserves manifest entries of vaults no longer configured", async () => {
    const ws = await makeWorkspace();
    const retired: Record<string, { hash: string; last_synced: string }> = {
      "Old.md": { hash: "0".repeat(64), last_synced: T1 },
    };

    await mkdir(ws.rawDir, { recursive: true });
    await writeFile(
      join(ws.rawDir, "manifest.json"),
      JSON.stringify({ vaults: { Retired: retired } }),
    );

    await run(ws, T1);

    expect((await readManifestOf(ws)).vaults.Retired).toEqual(retired);
  });
});

describe("sync-vault CLI", () => {
  async function runCli(args: string[]): Promise<{ out: string; err: string }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.exitCode = undefined;
    process.argv = [argv[0], argv[1], ...args];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args2) => out.push(args2.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args2) => err.push(args2.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("prints a per-vault summary line", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toContain(
      `vault "${VAULT_NAME}": 4 selected, 4 copied, 0 unchanged, 0 removed`,
    );
  });

  it("lists each copied path with a plus sign", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toContain("+ AI/RAG.md");
  });

  it("prints the sync-complete totals on the first run", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toContain("sync complete: 4 copied, 0 removed");
  });

  it("reports no changes on the second run", async () => {
    const ws = await makeWorkspace();

    await runCli([ws.configPath, ws.rawDir]);
    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toContain("sync complete: no changes");
  });

  it("exits with an error code when the config file is missing", async () => {
    const ws = await makeWorkspace();

    await runCli([join(ws.dir, "nope.json"), ws.rawDir]);

    expect(process.exitCode).toBe(1);
  });

  it("prints the failure to stderr when the config file is missing", async () => {
    const ws = await makeWorkspace();

    const { err } = await runCli([join(ws.dir, "nope.json"), ws.rawDir]);

    expect(err).toMatch(/cannot read sync config/);
  });

  it("reports no changes for a config without vaults", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    const { out } = await runCli([configPath, join(dir, "raw")]);

    expect(out).toContain("sync complete: no changes");
  });
});
