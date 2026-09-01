import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFixtureVault,
  VAULT_NAME,
} from "../../src/fixtures/generate.ts";
import { parseManifest } from "../../src/sync/manifest.ts";
import type { SyncProgress } from "../../src/sync/projection.ts";
import {
  main,
  PROGRESS_EVERY,
  runDryRun,
  runVaultSync,
} from "../../src/sync/sync-vault.ts";
import { collectFiles, SELECTED_PATHS } from "../e2e/helpers.ts";

const T1 = "2026-08-16T15:00:00.000Z";
const T2 = "2026-08-16T16:00:00.000Z";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

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
          exclude: "wiki:false",
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
  const { sources } = await runVaultSync({
    configPath: ws.configPath,
    rawDir: ws.rawDir,
    now: fixedClock(iso),
  });

  return sources;
}

/** Run with a progress collector; returns reports and messages. */
async function runWithProgress(ws: Workspace, iso: string = T1) {
  const messages: SyncProgress[] = [];
  const report = await runVaultSync({
    configPath: ws.configPath,
    rawDir: ws.rawDir,
    now: fixedClock(iso),
    onProgress: (message) => messages.push(message),
  });

  return {
    reports: report.sources,
    pruned: report.prunedNamespaces,
    messages,
  };
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

/** Re-add a retired namespace on top of an existing projection. */
async function readdRetiredNamespace(ws: Workspace): Promise<void> {
  const manifestPath = join(ws.rawDir, "manifest.json");
  const current = JSON.parse(await readFile(manifestPath, "utf8"));

  current.vaults.Retired = {
    "Old.md": { hash: "0".repeat(64), last_synced: T1 },
  };
  await writeFile(manifestPath, JSON.stringify(current));
  await mkdir(join(ws.rawDir, "notes", "Retired"), { recursive: true });
  await writeFile(join(ws.rawDir, "notes", "Retired", "Old.md"), "# old\n");
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
        kind: "vault",
        name: VAULT_NAME,
        candidates: 9,
        selected: 7,
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

  it("keeps the underlying error as the cause when the vault root does not exist", async () => {
    const ws = await makeWorkspace({ root: "/nonexistent/vault" });
    const error: unknown = await run(ws).catch((reason: unknown) => reason);

    expect((error as NodeJS.ErrnoException).cause).toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects when the vault root is a file rather than a directory", async () => {
    const ws = await makeWorkspace();
    const filePath = join(ws.dir, "not-a-vault.md");
    const configPath = join(ws.dir, "file-root-sync.json");

    await writeFile(filePath, "# not a vault\n");
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: VAULT_NAME, root: filePath, exclude: "wiki:false" }],
      }),
    );

    await expect(
      runVaultSync({ configPath, rawDir: join(ws.dir, "raw") }),
    ).rejects.toThrow(
      `vault root for "${VAULT_NAME}" is not a directory: ${filePath}`,
    );
  });

  it("names the vault and note when a candidate cannot be read", async () => {
    const ws = await makeWorkspace();

    await chmod(sourcePath(ws, "AI/RAG.md"), 0o000);

    await expect(run(ws)).rejects.toThrow(
      `failed to read note "AI/RAG.md" in vault "${VAULT_NAME}"`,
    );
  });

  itRequiresPermissionChecks(
    "keeps the read error as the cause when a candidate cannot be read",
    async () => {
      const ws = await makeWorkspace();

      await chmod(sourcePath(ws, "AI/RAG.md"), 0o000);

      const error: unknown = await run(ws).catch((reason: unknown) => reason);

      expect((error as NodeJS.ErrnoException).cause).toMatchObject({
        code: "EACCES",
      });
    },
  );
});

describe("runSync idempotence", () => {
  it("rejects with the raw read error when the manifest path is a directory", async () => {
    const ws = await makeWorkspace();

    await mkdir(join(ws.rawDir, "manifest.json"), { recursive: true });

    await expect(run(ws)).rejects.toThrow(
      "EISDIR: illegal operation on a directory, read",
    );
  });

  it("does not rewrite the manifest on the second run", async () => {
    const ws = await makeWorkspace();
    const manifestPath = join(ws.rawDir, "manifest.json");

    await run(ws, T1);

    const before = (await stat(manifestPath)).mtimeMs;

    await run(ws, T2);

    expect((await stat(manifestPath)).mtimeMs).toBe(before);
  });
  it("copies and removes nothing on the second run", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    const second = await run(ws, T2);

    expect(second).toEqual([
      {
        kind: "vault",
        name: VAULT_NAME,
        candidates: 9,
        selected: 7,
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
  });

  it("keeps last_synced for the untouched note", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await writeFile(
      sourcePath(ws, "AI/rag-evaluation-notes.md"),
      "---\nwiki: true\n---\n\n# RAG evaluation notes\n\nEdited body.\n",
    );
    await run(ws, T2);

    const notes = (await readManifestOf(ws)).vaults[VAULT_NAME];

    expect(notes?.["AI/RAG.md"]?.last_synced).toBe(T1);
  });
});

// Root callers bypass the read-only directory check (CAP_DAC_OVERRIDE),
// so a chmod-induced EACCES never occurs; skip the affected test there.
const itRequiresPermissionChecks =
  process.getuid !== undefined && process.getuid() === 0 ? it.skip : it;

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
        "Inbox/clipped-note.md",
        "Inbox/parking-lot.md",
        "Inbox/quick-idea.md",
      ].map((rel) => `${VAULT_NAME}/${rel}`),
    );
  });

  it("stops pruning without an error at a directory that still has entries", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await rm(sourcePath(ws, "AI/rag-evaluation-notes.md"));

    expect((await run(ws, T2))[0]?.removed).toEqual([
      "AI/rag-evaluation-notes.md",
    ]);
  });

  itRequiresPermissionChecks(
    "rejects when pruning an emptied directory fails for another reason than being not empty",
    async () => {
      const ws = await makeWorkspace();
      const namespaceRoot = join(ws.rawDir, "notes", VAULT_NAME);

      await run(ws, T1);
      await rm(sourcePath(ws, "Scratch/temp-research.md"));
      await chmod(namespaceRoot, 0o555);

      try {
        await expect(run(ws, T2)).rejects.toThrow(/failed to prune/);
      } finally {
        await chmod(namespaceRoot, 0o755);
      }
    },
  );

  itRequiresPermissionChecks(
    "keeps the prune error as the cause when pruning fails",
    async () => {
      const ws = await makeWorkspace();
      const namespaceRoot = join(ws.rawDir, "notes", VAULT_NAME);

      await run(ws, T1);
      await rm(sourcePath(ws, "Scratch/temp-research.md"));
      await chmod(namespaceRoot, 0o555);

      try {
        const error: unknown = await run(ws, T2).catch(
          (reason: unknown) => reason,
        );

        expect((error as NodeJS.ErrnoException).cause).toMatchObject({
          code: "EACCES",
        });
      } finally {
        await chmod(namespaceRoot, 0o755);
      }
    },
  );

  it("removes the raw copy when a note is blocked", async () => {
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

  it("keeps the vault namespace directory after the last note is removed", async () => {
    const ws = await makeWorkspace();
    const namespaceRoot = join(ws.rawDir, "notes", VAULT_NAME);

    await run(ws, T1);

    for (const relPath of SELECTED_PATHS) {
      await rm(sourcePath(ws, relPath));
    }

    await run(ws, T2);

    expect((await stat(namespaceRoot)).isDirectory()).toBe(true);
  });

  it("succeeds when two removed notes shared one directory", async () => {
    const ws = await makeWorkspace();

    await writeFile(
      sourcePath(ws, "Scratch/second-research.md"),
      "---\nwiki: true\n---\n\n# Second\n",
    );
    await run(ws, T1);
    await rm(rawNotePath(ws, "Scratch/temp-research.md"));
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    await rm(sourcePath(ws, "Scratch/second-research.md"));

    expect((await run(ws, T2))[0]?.removed).toEqual([
      "Scratch/second-research.md",
      "Scratch/temp-research.md",
    ]);
  });

  it("lists removals in sorted order whatever the manifest order", async () => {
    const ws = await makeWorkspace();
    const entry = { hash: "0".repeat(64), last_synced: T1 };

    await mkdir(ws.rawDir, { recursive: true });
    await writeFile(
      join(ws.rawDir, "manifest.json"),
      JSON.stringify({
        vaults: { [VAULT_NAME]: { "b.md": entry, "a.md": entry } },
      }),
    );

    expect((await run(ws, T1))[0]?.removed).toEqual(["a.md", "b.md"]);
  });

  it("reports a removal whose raw file is already gone", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    await rm(rawNotePath(ws, "Scratch/temp-research.md"));
    await rm(sourcePath(ws, "Scratch/temp-research.md"));

    expect((await run(ws, T2))[0]?.removed).toEqual([
      "Scratch/temp-research.md",
    ]);
  });
});

describe("runSync progress", () => {
  it("emits the raw dir as the first progress message", async () => {
    const ws = await makeWorkspace();
    const { messages } = await runWithProgress(ws);

    expect(messages).toContainEqual({
      kind: "event",
      text: `sync-vault: raw dir ${ws.rawDir}`,
    });
  });

  it("announces scanning and the candidate count right after the raw dir", async () => {
    const ws = await makeWorkspace();
    const { messages } = await runWithProgress(ws);

    expect(messages.slice(0, 3).map((message) => message.text)).toEqual([
      `sync-vault: raw dir ${ws.rawDir}`,
      `vault "${VAULT_NAME}": scanning ${ws.vaultRoot}`,
      `vault "${VAULT_NAME}": 9 candidates`,
    ]);
  });

  it("tags the scanning announcement and candidate count as events", async () => {
    const ws = await makeWorkspace();
    const { messages } = await runWithProgress(ws);

    expect(
      messages.slice(0, 3).every((message) => message.kind === "event"),
    ).toBe(true);
  });

  it("emits a heartbeat every PROGRESS_EVERY files read", async () => {
    const ws = await makeWorkspace();

    await mkdir(join(ws.vaultRoot, "AAbulk"), { recursive: true });

    for (let index = 0; index < PROGRESS_EVERY; index += 1) {
      await writeFile(
        join(ws.vaultRoot, "AAbulk", `note-${index}.md`),
        "# filler\n",
      );
    }

    const { messages } = await runWithProgress(ws);

    expect(messages.map((message) => message.text)).toEqual([
      `sync-vault: raw dir ${ws.rawDir}`,
      `vault "${VAULT_NAME}": scanning ${ws.vaultRoot}`,
      `vault "${VAULT_NAME}": ${PROGRESS_EVERY + 9} candidates`,
      `vault "${VAULT_NAME}": ${PROGRESS_EVERY}/${PROGRESS_EVERY + 9} read, ${PROGRESS_EVERY} selected`,
    ]);
  });

  it("tags the read heartbeat as a heartbeat", async () => {
    const ws = await makeWorkspace();

    await mkdir(join(ws.vaultRoot, "AAbulk"), { recursive: true });

    for (let index = 0; index < PROGRESS_EVERY; index += 1) {
      await writeFile(
        join(ws.vaultRoot, "AAbulk", `note-${index}.md`),
        "# filler\n",
      );
    }

    const { messages } = await runWithProgress(ws);

    expect(messages.at(-1)?.kind).toBe("heartbeat");
  });

  it("delivers uncolored progress messages", async () => {
    const ws = await makeWorkspace();
    const { messages } = await runWithProgress(ws);

    expect(messages.every((message) => !message.text.includes("\x1b["))).toBe(
      true,
    );
  });

  it("emits a read heartbeat after every file when progressEvery is 1", async () => {
    const ws = await makeWorkspace();
    const messages: SyncProgress[] = [];

    await runVaultSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      progressEvery: 1,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContainEqual({
      kind: "heartbeat",
      text: `vault "${VAULT_NAME}": 1/9 read, 1 selected`,
    });
  });

  it("emits a read heartbeat after the second file when progressEvery is 1", async () => {
    const ws = await makeWorkspace();
    const messages: SyncProgress[] = [];

    await runVaultSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      progressEvery: 1,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContainEqual({
      kind: "heartbeat",
      text: `vault "${VAULT_NAME}": 2/9 read, 2 selected`,
    });
  });

  it("emits a scanning heartbeat every thousand directories visited", async () => {
    const ws = await makeWorkspace();

    for (let index = 0; index < 1000; index += 1) {
      await mkdir(join(ws.vaultRoot, `AAbulk-${index}`), { recursive: true });
    }

    const { messages } = await runWithProgress(ws);

    expect(
      messages.some(
        (message) =>
          message.kind === "heartbeat" &&
          new RegExp(
            `^vault "${VAULT_NAME}": scanning \\([^)]+, 1000 dirs\\)$`,
          ).test(message.text),
      ),
    ).toBe(true);
  });

  it("honors progressEvery in a dry run too", async () => {
    const ws = await makeWorkspace();
    const messages: SyncProgress[] = [];

    await runDryRun({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      progressEvery: 1,
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toContainEqual({
      kind: "heartbeat",
      text: `vault "${VAULT_NAME}": 1/9 read, 1 selected`,
    });
  });
});

describe("runSync candidate count", () => {
  it("counts every markdown candidate, selected or not", async () => {
    const ws = await makeWorkspace();
    const { reports } = await runWithProgress(ws);

    expect(reports[0]?.candidates).toBe(9);
  });

  it("counts zero candidates for a vault without markdown files", async () => {
    const ws = await makeWorkspace();
    const emptyRoot = join(ws.dir, "Empty");
    const configPath = join(ws.dir, "empty-sync.json");

    await mkdir(emptyRoot);
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: "Empty", root: emptyRoot, exclude: "wiki:false" }],
      }),
    );

    const { sources } = await runVaultSync({
      configPath,
      rawDir: ws.rawDir,
      now: fixedClock(T1),
    });

    expect(sources[0]?.candidates).toBe(0);
  });
});

describe("runSync home expansion", () => {
  it("syncs a vault whose root is a tilde path", async () => {
    const ws = await makeWorkspace({ root: `~/${VAULT_NAME}` });
    const { sources } = await runVaultSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      home: ws.dir,
      now: fixedClock(T1),
    });

    expect(sources[0]?.copied).toEqual(SELECTED_PATHS);
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
          { name: VAULT_NAME, root: documentsRoot, exclude: "wiki:false" },
          { name: "Journal", root: journalRoot, exclude: "wiki:false" },
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
      "Documents/Inbox/clipped-note.md",
      "Documents/Inbox/parking-lot.md",
      "Documents/Inbox/quick-idea.md",
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
});

describe("runSync stale namespace pruning", () => {
  const retiredEntry = { hash: "0".repeat(64), last_synced: T1 };

  async function seedRetiredNamespace(ws: Workspace): Promise<void> {
    await mkdir(ws.rawDir, { recursive: true });
    await writeFile(
      join(ws.rawDir, "manifest.json"),
      JSON.stringify({ vaults: { Retired: { "Old.md": retiredEntry } } }),
    );
    await mkdir(join(ws.rawDir, "notes", "Retired"), { recursive: true });
    await writeFile(join(ws.rawDir, "notes", "Retired", "Old.md"), "# old\n");
  }

  it("drops the manifest section of a namespace absent from the config", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    await run(ws, T1);

    expect(Object.keys((await readManifestOf(ws)).vaults)).toEqual([
      VAULT_NAME,
    ]);
  });

  it("deletes the projected tree of a namespace absent from the config", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    await run(ws, T1);

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual(
      SELECTED_PATHS.map((rel) => `${VAULT_NAME}/${rel}`),
    );
  });

  it("drops a stale manifest section whose projected tree is already gone", async () => {
    const ws = await makeWorkspace();

    await mkdir(ws.rawDir, { recursive: true });
    await writeFile(
      join(ws.rawDir, "manifest.json"),
      JSON.stringify({ vaults: { Retired: { "Old.md": retiredEntry } } }),
    );
    await run(ws, T1);

    expect(Object.keys((await readManifestOf(ws)).vaults)).toEqual([
      VAULT_NAME,
    ]);
  });

  it("deletes an orphan namespace directory without a manifest entry", async () => {
    const ws = await makeWorkspace();

    await mkdir(join(ws.rawDir, "notes", "Retired"), { recursive: true });
    await writeFile(join(ws.rawDir, "notes", "Retired", "Old.md"), "# old\n");
    await run(ws, T1);

    await expect(
      stat(join(ws.rawDir, "notes", "Retired")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves files that are not namespace directories in the notes root", async () => {
    const ws = await makeWorkspace();
    const keepPath = join(ws.rawDir, "notes", ".gitkeep");

    await mkdir(join(ws.rawDir, "notes"), { recursive: true });
    await writeFile(keepPath, "");
    await run(ws, T1);

    expect((await stat(keepPath)).isFile()).toBe(true);
  });

  it("announces each removed namespace as progress", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    const { messages } = await runWithProgress(ws);

    expect(messages).toContainEqual({
      kind: "event",
      text: 'vault "Retired": removed stale namespace (not configured)',
    });
  });

  it("lists pruned namespaces in the run report", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    const { pruned } = await runWithProgress(ws);

    expect(pruned).toEqual(["Retired"]);
  });

  it("does not rewrite the manifest on the run after pruning", async () => {
    const ws = await makeWorkspace();
    const manifestPath = join(ws.rawDir, "manifest.json");

    await seedRetiredNamespace(ws);
    await run(ws, T1);

    const before = (await stat(manifestPath)).mtimeMs;

    await run(ws, T2);

    expect((await stat(manifestPath)).mtimeMs).toBe(before);
  });

  it("keeps every manifest section when the config lists no vaults", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    await writeFile(ws.configPath, JSON.stringify({ vaults: [] }));
    await run(ws);

    expect(Object.keys((await readManifestOf(ws)).vaults)).toEqual(["Retired"]);
  });

  it("keeps every projected tree when the config lists no vaults", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    await writeFile(ws.configPath, JSON.stringify({ vaults: [] }));
    await run(ws);

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual([
      "Retired/Old.md",
    ]);
  });

  it("reports no pruned namespaces when the config lists no vaults", async () => {
    const ws = await makeWorkspace();

    await seedRetiredNamespace(ws);
    await writeFile(ws.configPath, JSON.stringify({ vaults: [] }));
    const { pruned } = await runWithProgress(ws);

    expect(pruned).toEqual([]);
  });
});

describe("runDryRun", () => {
  it("lists every note the exclusion rule would ingest", async () => {
    const ws = await makeWorkspace();

    expect(
      await runDryRun({ configPath: ws.configPath, rawDir: ws.rawDir }),
    ).toEqual([
      { vault: VAULT_NAME, candidates: 9, wouldIngest: SELECTED_PATHS },
    ]);
  });

  it("writes nothing to the raw dir", async () => {
    const ws = await makeWorkspace();

    await runDryRun({ configPath: ws.configPath, rawDir: ws.rawDir });

    await expect(stat(ws.rawDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves an existing manifest untouched", async () => {
    const ws = await makeWorkspace();

    await run(ws, T1);
    const before = await readFile(join(ws.rawDir, "manifest.json"), "utf8");

    await runDryRun({ configPath: ws.configPath, rawDir: ws.rawDir });

    expect(await readFile(join(ws.rawDir, "manifest.json"), "utf8")).toBe(
      before,
    );
  });

  it("announces the dry run as the first progress message", async () => {
    const ws = await makeWorkspace();
    const messages: SyncProgress[] = [];

    await runDryRun({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      onProgress: (message) => messages.push(message),
    });

    expect(messages[0]).toEqual({
      kind: "event",
      text: "sync-vault: dry run, nothing will be written",
    });
  });

  it("emits the same scanning progress as a real run", async () => {
    const ws = await makeWorkspace();
    const messages: SyncProgress[] = [];

    await runDryRun({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      onProgress: (message) => messages.push(message),
    });

    expect(messages.slice(1, 3).map((message) => message.text)).toEqual([
      `vault "${VAULT_NAME}": scanning ${ws.vaultRoot}`,
      `vault "${VAULT_NAME}": 9 candidates`,
    ]);
  });

  it("expands a tilde vault root against the home override", async () => {
    const ws = await makeWorkspace({ root: `~/${VAULT_NAME}` });

    const reports = await runDryRun({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      home: ws.dir,
    });

    expect(reports[0]?.wouldIngest).toEqual(SELECTED_PATHS);
  });

  it("honors an explicitly empty home override", async () => {
    const ws = await makeWorkspace();
    const configPath = join(ws.dir, "empty-home-sync.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: VAULT_NAME, root: "~/v", exclude: "wiki:false" }],
      }),
    );

    await expect(
      runDryRun({ configPath, rawDir: ws.rawDir, home: "" }),
    ).rejects.toThrow(/^vault root for "Documents" is not accessible: v$/);
  });
});

describe("sync-vault CLI", () => {
  async function runCli(
    args: string[],
    options: { color?: boolean } = {},
  ): Promise<{ out: string; err: string }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];
    const hadNoColor = "NO_COLOR" in process.env;
    const prevNoColor = process.env.NO_COLOR;

    process.exitCode = undefined;
    process.argv = [...argv.slice(0, 2), ...args];

    if (options.color) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = "1";
    }

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

      if (hadNoColor) {
        process.env.NO_COLOR = prevNoColor;
      } else {
        delete process.env.NO_COLOR;
      }

      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("prints a per-vault summary line", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toContain(
      `vault "${VAULT_NAME}": 7 selected, 7 copied, 0 unchanged, 0 removed`,
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

    expect(out).toContain("sync complete: 7 copied, 0 removed");
  });

  it("reports no changes on the second run", async () => {
    const ws = await makeWorkspace();

    await runCli([ws.configPath, ws.rawDir]);
    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toContain("sync complete: no changes");
  });

  it("reports a zero-second elapsed time under a frozen clock", async () => {
    const ws = await makeWorkspace();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    try {
      const { out } = await runCli([ws.configPath, ws.rawDir]);

      expect(out).toContain("sync complete: 7 copied, 0 removed (0s)");
    } finally {
      clock.mockRestore();
    }
  });

  it("reports a zero-second elapsed time for a dry run under a frozen clock", async () => {
    const ws = await makeWorkspace();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    try {
      const { out } = await runCli(["--dry-run", ws.configPath, ws.rawDir]);

      expect(out).toContain("dry-run complete: nothing written (0s)");
    } finally {
      clock.mockRestore();
    }
  });

  it("renders a removal run line for line", async () => {
    const ws = await makeWorkspace();

    await runCli([ws.configPath, ws.rawDir]);
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out.split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 6 selected, 0 copied, 6 unchanged, 1 removed`,
    );
    expect(out).toContain("  - Scratch/temp-research.md");
    expect(out.split("\n").at(-1)).toMatch(
      /^sync complete: 0 copied, 1 removed \(\d+(?:h\d{2}m\d{2}|m\d{2})?s\)$/,
    );
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

  it("writes progress to stderr", async () => {
    const ws = await makeWorkspace();

    const { err } = await runCli([ws.configPath, ws.rawDir]);

    expect(err).toContain(`sync-vault: raw dir ${ws.rawDir}`);
  });

  it("keeps stdout free of progress", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).not.toContain("raw dir");
  });

  it("colors the stdout report by default", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir], { color: true });

    expect(out).toContain("\x1b[");
  });

  it("colors the stderr progress by default", async () => {
    const ws = await makeWorkspace();

    const { err } = await runCli([ws.configPath, ws.rawDir], { color: true });

    expect(err).toContain("\x1b[");
  });

  it("prints plain stdout when NO_COLOR is set", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out.includes("\x1b[")).toBe(false);
  });

  it("prints plain stderr when NO_COLOR is set", async () => {
    const ws = await makeWorkspace();

    const { err } = await runCli([ws.configPath, ws.rawDir]);

    expect(err.includes("\x1b[")).toBe(false);
  });

  it("colors the error line red by default", async () => {
    const ws = await makeWorkspace();

    const { err } = await runCli([join(ws.dir, "nope.json"), ws.rawDir], {
      color: true,
    });

    expect(err.startsWith("\x1b[31m")).toBe(true);
  });

  it("clears the animated live line before printing the failure", async () => {
    const ws = await makeWorkspace();

    await mkdir(join(ws.rawDir, "notes"), { recursive: true });
    await writeFile(join(ws.rawDir, "notes", VAULT_NAME), "not a directory");

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));

        return true;
      });
    const wasTty = process.stderr.isTTY;

    process.stderr.isTTY = true;

    try {
      await runCli([ws.configPath, ws.rawDir], { color: true });
    } finally {
      process.stderr.isTTY = wasTty;
      writeSpy.mockRestore();
    }

    expect(writes.at(-1)).toMatch(/^\r +\r$/);
  });

  it("reports no changes for a config without vaults", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "sync.json");

    await writeFile(configPath, JSON.stringify({ vaults: [] }));

    const { out } = await runCli([configPath, join(dir, "raw")]);

    expect(out).toContain("sync complete: no changes");
  });

  it("renders a prune-only run line for line", async () => {
    const ws = await makeWorkspace();

    await runCli([ws.configPath, ws.rawDir]);
    await readdRetiredNamespace(ws);
    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out.split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 7 selected, 0 copied, 7 unchanged, 0 removed`,
    );
    expect(out).toContain("  - Retired/ (stale namespace, not configured)");
    expect(out.split("\n").at(-1)).toMatch(
      /^sync complete: 0 copied, 0 removed, 1 namespace pruned \(\d+(?:h\d{2}m\d{2}|m\d{2})?s\)$/,
    );
  });

  it("exits 0 and lists the would-ingest notes for --dry-run", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli(["--dry-run", ws.configPath, ws.rawDir]);

    expect(out.split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 7 of 9 candidates would be ingested`,
    );

    for (const rel of SELECTED_PATHS) {
      expect(out).toContain(`  + ${rel}`);
    }

    expect(out.split("\n").at(-1)).toMatch(
      /^dry-run complete: nothing written \(\d+(?:h\d{2}m\d{2}|m\d{2})?s\)$/,
    );
  });

  it("writes nothing to the raw dir during a --dry-run CLI run", async () => {
    const ws = await makeWorkspace();

    await runCli(["--dry-run", ws.configPath, ws.rawDir]);

    await expect(stat(ws.rawDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts --dry-run after the config argument", async () => {
    const ws = await makeWorkspace();

    const { out } = await runCli([ws.configPath, "--dry-run", ws.rawDir]);

    expect(out).toContain("dry-run complete: nothing written");
  });

  it("writes dry-run progress to stderr", async () => {
    const ws = await makeWorkspace();

    const { err } = await runCli(["--dry-run", ws.configPath, ws.rawDir]);

    expect(err).toContain("sync-vault: dry run, nothing will be written");
  });
  describe("sync-vault CLI help", () => {
    it("prints the usage line for --help", async () => {
      const { out } = await runCli(["--help"]);

      expect(out).toContain(
        "sync-vault [--dry-run] [-h | --help] [<config>] [<raw-dir>]",
      );
    });

    it("prints the same help for -h as for --help", async () => {
      expect((await runCli(["-h"])).out).toBe((await runCli(["--help"])).out);
    });

    it("explains that --dry-run writes nothing", async () => {
      const { out } = await runCli(["--help"]);

      expect(out).toContain("write nothing");
    });

    it("documents the -h and --help switches themselves", async () => {
      const { out } = await runCli(["--help"]);

      expect(out).toContain("-h, --help");
    });

    it("states the default config path", async () => {
      const { out } = await runCli(["--help"]);

      expect(out).toContain("Default: the repo's own sync.json");
    });

    it("states the default raw dir and its dataRoot override", async () => {
      const { out } = await runCli(["--help"]);

      expect(out).toContain("<dataRoot>/raw");
    });

    it("leaves the exit code unset for --help", async () => {
      await runCli(["--help"]);

      expect(process.exitCode).toBeUndefined();
    });

    it("prints help without loading the config when --help precedes it", async () => {
      const ws = await makeWorkspace();
      const missing = join(ws.dir, "nope.json");

      const { err } = await runCli(["--help", missing, ws.rawDir]);

      expect(err).not.toMatch(/cannot read sync config/);
    });

    it("writes nothing to the raw dir for --help", async () => {
      const ws = await makeWorkspace();

      await runCli(["--help", ws.configPath, ws.rawDir]);

      await expect(stat(ws.rawDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("runSync repo-source rejection", () => {
  it("rejects a config whose source is a repo with a pointer to sync-repo", async () => {
    const ws = await makeWorkspace();
    const configPath = join(ws.dir, "sync-meta.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          {
            source: "repo",
            name: "k-wiki",
            root: ws.dir,
            include: ["README.md"],
          },
        ],
      }),
      "utf8",
    );

    await expect(
      runVaultSync({ configPath, rawDir: join(ws.dir, "raw-meta") }),
    ).rejects.toThrow(/repo source.*sync-repo/);
  });

  it("rejects a repo source before writing anything to the raw dir", async () => {
    const ws = await makeWorkspace();
    const configPath = join(ws.dir, "sync-meta.json");
    const rawDir = join(ws.dir, "raw-meta");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          {
            source: "repo",
            name: "k-wiki",
            root: ws.dir,
            include: ["README.md"],
          },
        ],
      }),
      "utf8",
    );

    await expect(runVaultSync({ configPath, rawDir })).rejects.toThrow();
    await expect(stat(rawDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a repo source in a dry run as well", async () => {
    const ws = await makeWorkspace();
    const configPath = join(ws.dir, "sync-meta.json");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [
          {
            source: "repo",
            name: "k-wiki",
            root: ws.dir,
            include: ["README.md"],
          },
        ],
      }),
      "utf8",
    );

    await expect(runDryRun({ configPath, rawDir: ws.rawDir })).rejects.toThrow(
      /repo source.*sync-repo/,
    );
  });
});
