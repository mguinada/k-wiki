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
import { createColors } from "picocolors";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { generateFixtureVault, VAULT_NAME } from "../src/fixtures/generate.ts";
import { parseManifest } from "../src/sync/manifest.ts";
import {
  colorizeError,
  colorizeProgress,
  colorizeReportLine,
  formatReport,
  main,
  PROGRESS_EVERY,
  runSync,
  type SyncReport,
  type VaultSyncReport,
} from "../src/sync/sync-vault.ts";
import { collectFiles, SELECTED_PATHS } from "./e2e/helpers.ts";

const T1 = "2026-08-16T15:00:00.000Z";
const T2 = "2026-08-16T16:00:00.000Z";

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
  const { vaults } = await runSync({
    configPath: ws.configPath,
    rawDir: ws.rawDir,
    now: fixedClock(iso),
  });

  return vaults;
}

/** Run with a progress collector; returns reports and messages. */
async function runWithProgress(ws: Workspace, iso: string = T1) {
  const messages: string[] = [];
  const report = await runSync({
    configPath: ws.configPath,
    rawDir: ws.rawDir,
    now: fixedClock(iso),
    onProgress: (message) => messages.push(message),
  });

  return {
    reports: report.vaults,
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
        vault: VAULT_NAME,
        candidates: 6,
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
        vaults: [{ name: VAULT_NAME, root: filePath, select: "wiki:true" }],
      }),
    );

    await expect(
      runSync({ configPath, rawDir: join(ws.dir, "raw") }),
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
        vault: VAULT_NAME,
        candidates: 6,
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

    expect(messages[0]).toBe(`sync-vault: raw dir ${ws.rawDir}`);
  });

  it("announces scanning and the candidate count right after the raw dir", async () => {
    const ws = await makeWorkspace();
    const { messages } = await runWithProgress(ws);

    expect(messages.slice(0, 3)).toEqual([
      `sync-vault: raw dir ${ws.rawDir}`,
      `vault "${VAULT_NAME}": scanning ${ws.vaultRoot}`,
      `vault "${VAULT_NAME}": 6 candidates`,
    ]);
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

    expect(messages).toEqual([
      `sync-vault: raw dir ${ws.rawDir}`,
      `vault "${VAULT_NAME}": scanning ${ws.vaultRoot}`,
      `vault "${VAULT_NAME}": ${PROGRESS_EVERY + 6} candidates`,
      `vault "${VAULT_NAME}": ${PROGRESS_EVERY}/${PROGRESS_EVERY + 6} read, 0 selected`,
    ]);
  });

  it("delivers uncolored progress messages", async () => {
    const ws = await makeWorkspace();
    const { messages } = await runWithProgress(ws);

    expect(messages.every((message) => !message.includes("\x1b["))).toBe(true);
  });
});

describe("runSync candidate count", () => {
  it("counts every markdown candidate, selected or not", async () => {
    const ws = await makeWorkspace();
    const { reports } = await runWithProgress(ws);

    expect(reports[0]?.candidates).toBe(6);
  });

  it("counts zero candidates for a vault without markdown files", async () => {
    const ws = await makeWorkspace();
    const emptyRoot = join(ws.dir, "Empty");
    const configPath = join(ws.dir, "empty-sync.json");

    await mkdir(emptyRoot);
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: "Empty", root: emptyRoot, select: "wiki:true" }],
      }),
    );

    const { vaults } = await runSync({
      configPath,
      rawDir: ws.rawDir,
      now: fixedClock(T1),
    });

    expect(vaults[0]?.candidates).toBe(0);
  });
});

describe("formatReport zero-match hint", () => {
  const noMatch: VaultSyncReport = {
    vault: VAULT_NAME,
    candidates: 6,
    selected: 0,
    copied: [],
    unchanged: [],
    removed: [],
  };

  function reportOf(
    vault: VaultSyncReport,
    prunedNamespaces: readonly string[] = [],
  ): SyncReport {
    return { vaults: [vault], prunedNamespaces };
  }

  it("appends the hint when candidates matched no selection rule", () => {
    expect(formatReport(reportOf(noMatch)).split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 0 selected, 0 copied, 0 unchanged, 0 removed (6 candidates, none matched the selection rule)`,
    );
  });

  it("omits the hint when the vault has no candidates", () => {
    const report: VaultSyncReport = { ...noMatch, candidates: 0 };

    expect(formatReport(reportOf(report)).split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 0 selected, 0 copied, 0 unchanged, 0 removed`,
    );
  });

  it("omits the hint when candidates matched", () => {
    const report: VaultSyncReport = {
      ...noMatch,
      selected: 1,
      copied: ["a.md"],
    };

    expect(formatReport(reportOf(report)).split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 1 selected, 1 copied, 0 unchanged, 0 removed`,
    );
  });

  it("keeps the no-changes summary when nothing was pruned", () => {
    expect(formatReport(reportOf(noMatch)).split("\n").at(-1)).toBe(
      "sync complete: no changes",
    );
  });
});

describe("formatReport pruned namespaces", () => {
  const unchanged: VaultSyncReport = {
    vault: VAULT_NAME,
    candidates: 6,
    selected: 4,
    copied: [],
    unchanged: SELECTED_PATHS,
    removed: [],
  };

  it("lists each pruned namespace with a minus sign", () => {
    const report: SyncReport = {
      vaults: [unchanged],
      prunedNamespaces: ["Retired"],
    };

    expect(formatReport(report)).toContain(
      "  - Retired/ (stale namespace, not configured)",
    );
  });

  it("counts a pruned namespace in the summary instead of reporting no changes", () => {
    const report: SyncReport = {
      vaults: [unchanged],
      prunedNamespaces: ["Retired"],
    };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: 0 copied, 0 removed, 1 namespace pruned",
    );
  });

  it("pluralizes the prune count for several namespaces", () => {
    const report: SyncReport = {
      vaults: [],
      prunedNamespaces: ["Old", "Retired"],
    };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: 0 copied, 0 removed, 2 namespaces pruned",
    );
  });
});

describe("runSync home expansion", () => {
  it("syncs a vault whose root is a tilde path", async () => {
    const ws = await makeWorkspace({ root: `~/${VAULT_NAME}` });
    const { vaults } = await runSync({
      configPath: ws.configPath,
      rawDir: ws.rawDir,
      home: ws.dir,
      now: fixedClock(T1),
    });

    expect(vaults[0]?.copied).toEqual(SELECTED_PATHS);
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

    expect(messages).toContain(
      'vault "Retired": removed stale namespace (not configured)',
    );
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

    expect(Object.keys((await readManifestOf(ws)).vaults)).toEqual([
      "Retired",
    ]);
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

describe("colorized output", () => {
  const pc = createColors(true);

  it("colors copied paths green", () => {
    expect(colorizeReportLine("  + AI/RAG.md")).toBe(
      `  + ${pc.green("AI/RAG.md")}`,
    );
  });

  it("colors removed paths red", () => {
    expect(colorizeReportLine("  - AI/RAG.md")).toBe(
      `  - ${pc.red("AI/RAG.md")}`,
    );
  });

  it("colors vault names bold in report lines", () => {
    expect(
      colorizeReportLine(
        `vault "${VAULT_NAME}": 4 selected, 4 copied, 0 unchanged, 0 removed`,
      ),
    ).toBe(
      `vault ${pc.bold(`"${VAULT_NAME}"`)}: 4 selected, 4 copied, 0 unchanged, 0 removed`,
    );
  });

  it("dims the no-changes summary", () => {
    expect(colorizeReportLine("sync complete: no changes")).toBe(
      pc.dim("sync complete: no changes"),
    );
  });

  it("colors a copy-only summary green", () => {
    expect(colorizeReportLine("sync complete: 4 copied, 0 removed")).toBe(
      pc.green("sync complete: 4 copied, 0 removed"),
    );
  });

  it("colors a summary with removals red", () => {
    expect(colorizeReportLine("sync complete: 0 copied, 1 removed")).toBe(
      pc.red("sync complete: 0 copied, 1 removed"),
    );
  });

  it("colors a prune-only summary red", () => {
    expect(
      colorizeReportLine(
        "sync complete: 0 copied, 0 removed, 1 namespace pruned",
      ),
    ).toBe(pc.red("sync complete: 0 copied, 0 removed, 1 namespace pruned"));
  });

  it("colors errors red", () => {
    expect(colorizeError("sync-vault: boom")).toBe(pc.red("sync-vault: boom"));
  });

  it("colors vault names bold in progress messages", () => {
    expect(colorizeProgress(`vault "${VAULT_NAME}": 6 candidates`)).toBe(
      `vault ${pc.bold(`"${VAULT_NAME}"`)}: 6 candidates`,
    );
  });

  it("leaves progress messages without a vault name plain", () => {
    expect(colorizeProgress("sync-vault: raw dir /tmp/raw")).toBe(
      "sync-vault: raw dir /tmp/raw",
    );
  });

  it("does not bold a vault name embedded mid-message", () => {
    expect(colorizeProgress('echo vault "X": done')).toBe(
      'echo vault "X": done',
    );
  });

  it("does not bold an undefined vault label embedded mid-message", () => {
    expect(colorizeProgress('echo vault "undefined": done')).toBe(
      'echo vault "undefined": done',
    );
  });

  it("colors a summary without a removed count green", () => {
    expect(colorizeReportLine("sync complete: 4 copied")).toBe(
      pc.green("sync complete: 4 copied"),
    );
  });

  it("colors a multi-digit-removal summary red", () => {
    expect(colorizeReportLine("sync complete: 0 copied, 10 removed")).toBe(
      pc.red("sync complete: 0 copied, 10 removed"),
    );
  });

  it("leaves unrelated lines plain", () => {
    expect(colorizeReportLine("banana")).toBe("banana");
  });

  describe("NO_COLOR", () => {
    const original = process.env.NO_COLOR;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = original;
      }
    });

    it("strips report color", () => {
      process.env.NO_COLOR = "1";

      expect(colorizeReportLine("  + AI/RAG.md")).toBe("  + AI/RAG.md");
    });

    it("strips progress color", () => {
      process.env.NO_COLOR = "1";

      expect(colorizeProgress(`vault "${VAULT_NAME}": 6 candidates`)).toBe(
        `vault "${VAULT_NAME}": 6 candidates`,
      );
    });

    it("strips error color", () => {
      process.env.NO_COLOR = "1";

      expect(colorizeError("sync-vault: boom")).toBe("sync-vault: boom");
    });
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

  it("renders a removal run line for line", async () => {
    const ws = await makeWorkspace();

    await runCli([ws.configPath, ws.rawDir]);
    await rm(sourcePath(ws, "Scratch/temp-research.md"));
    const { out } = await runCli([ws.configPath, ws.rawDir]);

    expect(out).toBe(
      [
        `vault "${VAULT_NAME}": 3 selected, 0 copied, 3 unchanged, 1 removed`,
        "  - Scratch/temp-research.md",
        "sync complete: 0 copied, 1 removed",
      ].join("\n"),
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

    expect(out).toBe(
      [
        `vault "${VAULT_NAME}": 4 selected, 0 copied, 4 unchanged, 0 removed`,
        "  - Retired/ (stale namespace, not configured)",
        "sync complete: 0 copied, 0 removed, 1 namespace pruned",
      ].join("\n"),
    );
  });
});
