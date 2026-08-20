import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VAULT_NAME } from "../../src/fixtures/generate.ts";
import { parseManifest } from "../../src/sync/manifest.ts";
import {
  buildWorkspace,
  type CliResult,
  cleanupWorkspaces,
  collectFiles,
  hashFile,
  runCli,
  SELECTED_PATHS,
  SYNC_SCRIPT,
  type Workspace,
} from "./helpers.ts";

/**
 * Real-CLI lifecycle suite: every step spawns
 * `node src/sync/sync-vault.ts <config> <raw>` as a child process
 * against the synthetic fixture vault in a temp workspace. Describe 1
 * is one vault, one story — sequential its share the workspace, so an
 * early failure cascades (accepted). Describe 2 isolates scenarios in
 * a fresh workspace per it. No exact `last_synced` assertions: the CLI
 * uses the real clock.
 */

const EDITED_NOTE = `---
tags:
  - AI
  - evaluation
wiki: true
---

# RAG evaluation notes

Edited during the e2e lifecycle run.
`;

const BLOCKED_NOTE = `---
source: https://arxiv.org/abs/1706.03762
wiki: false
---

# Attention Is All You Need

Flag flipped during the e2e lifecycle run.
`;

function sourcePath(ws: Workspace, relPath: string): string {
  return join(ws.vaultRoot, ...relPath.split("/"));
}

function rawNotePath(ws: Workspace, relPath: string): string {
  return join(ws.rawDir, "notes", VAULT_NAME, ...relPath.split("/"));
}

function manifestPath(ws: Workspace): string {
  return join(ws.rawDir, "manifest.json");
}

/** Failure-message context: the captured CLI output (fixture content only). */
function cliOutput(result: CliResult): string {
  return `CLI stdout:\n${result.out}CLI stderr:\n${result.err}`;
}

async function readManifest(ws: Workspace) {
  const path = manifestPath(ws);

  return parseManifest(await readFile(path, "utf8"), path);
}

afterAll(cleanupWorkspaces);

describe("sync-vault CLI lifecycle: one vault, one story", () => {
  let ws: Workspace;
  let lastRun: CliResult;

  beforeAll(async () => {
    ws = await buildWorkspace();
  });

  it("exits 0 and prints the full first-run report on stdout", async () => {
    lastRun = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(`${lastRun.code}\n${lastRun.out}`).toBe(
      [
        "0",
        `vault "${VAULT_NAME}": 7 selected, 7 copied, 0 unchanged, 0 removed`,
        ...SELECTED_PATHS.map((rel) => `  + ${rel}`),
        "sync complete: 7 copied, 0 removed",
        "",
      ].join("\n"),
    );
  });

  it("copies exactly the selected notes into the vault namespace", async () => {
    expect(
      await collectFiles(join(ws.rawDir, "notes")),
      cliOutput(lastRun),
    ).toEqual(SELECTED_PATHS.map((rel) => `${VAULT_NAME}/${rel}`));
  });

  it("writes a parseable manifest that records each copied note's sha-256", async () => {
    expect(
      (await readManifest(ws)).vaults[VAULT_NAME]?.["AI/RAG.md"]?.hash,
      cliOutput(lastRun),
    ).toBe(await hashFile(rawNotePath(ws, "AI/RAG.md")));
  });

  it("leaves the manifest byte-identical across a no-op re-run", async () => {
    const before = await readFile(manifestPath(ws), "utf8");

    lastRun = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(await readFile(manifestPath(ws), "utf8"), cliOutput(lastRun)).toBe(
      before,
    );
  });

  it("leaves the manifest mtime unchanged across a no-op re-run", async () => {
    const before = (await stat(manifestPath(ws))).mtimeMs;

    lastRun = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect((await stat(manifestPath(ws))).mtimeMs, cliOutput(lastRun)).toBe(
      before,
    );
  });

  it("reports no changes on the no-op re-run", async () => {
    expect(lastRun.out).toContain("sync complete: no changes");
  });

  it("re-copies an edited source note on the next run", async () => {
    await writeFile(sourcePath(ws, "AI/rag-evaluation-notes.md"), EDITED_NOTE);

    lastRun = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(
      await readFile(rawNotePath(ws, "AI/rag-evaluation-notes.md"), "utf8"),
      cliOutput(lastRun),
    ).toBe(EDITED_NOTE);
  });

  it("updates the edited note's hash in the manifest", async () => {
    expect(
      (await readManifest(ws)).vaults[VAULT_NAME]?.[
        "AI/rag-evaluation-notes.md"
      ]?.hash,
      cliOutput(lastRun),
    ).toBe(await hashFile(sourcePath(ws, "AI/rag-evaluation-notes.md")));
  });

  it("removes the projection when the source note is deleted", async () => {
    await rm(sourcePath(ws, "Scratch/temp-research.md"));

    lastRun = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    await expect(
      readFile(rawNotePath(ws, "Scratch/temp-research.md")),
      cliOutput(lastRun),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes the directory the deletion emptied", async () => {
    expect(
      await collectFiles(join(ws.rawDir, "notes")),
      cliOutput(lastRun),
    ).toEqual(
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

  it("drops the deleted note's manifest entry", async () => {
    expect(
      Object.hasOwn(
        (await readManifest(ws)).vaults[VAULT_NAME] ?? {},
        "Scratch/temp-research.md",
      ),
      cliOutput(lastRun),
    ).toBe(false);
  });

  it("removes the projection when a note is blocked", async () => {
    await writeFile(
      sourcePath(ws, "AI/llms/attention-is-all-you-need.md"),
      BLOCKED_NOTE,
    );

    lastRun = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(`${lastRun.code}|${lastRun.out}`).toBe(
      `0|${[
        `vault "${VAULT_NAME}": 5 selected, 0 copied, 5 unchanged, 1 removed`,
        "  - AI/llms/attention-is-all-you-need.md",
        "sync complete: 0 copied, 1 removed",
        "",
      ].join("\n")}`,
    );
  });
});

describe("sync-vault CLI scenarios: isolated workspaces", () => {
  /** Sync once under the fixture name, then rename the vault to "Renamed". */
  async function syncThenRename(ws: Workspace): Promise<CliResult> {
    await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    await writeFile(
      ws.configPath,
      JSON.stringify({
        vaults: [
          { name: "Renamed", root: ws.vaultRoot, exclude: "wiki:false" },
        ],
      }),
    );

    return runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);
  }

  async function buildTwoVaultWorkspace(): Promise<Workspace> {
    const ws = await buildWorkspace();
    const journalRoot = join(ws.dir, "Journal");

    await mkdir(dirname(join(journalRoot, "Daily", "day-1.md")), {
      recursive: true,
    });
    await writeFile(
      join(journalRoot, "Daily", "day-1.md"),
      "---\nwiki: true\n---\n\n# Day 1\n",
    );
    await writeFile(
      join(journalRoot, "day-2.md"),
      "---\nwiki: true\n---\n\n# Day 2\n",
    );

    await writeFile(
      ws.configPath,
      JSON.stringify({
        vaults: [
          { name: VAULT_NAME, root: ws.vaultRoot, exclude: "wiki:false" },
          { name: "Journal", root: journalRoot, exclude: "wiki:false" },
        ],
      }),
    );

    return ws;
  }

  it("keeps each vault's files under its own namespace", async () => {
    const ws = await buildTwoVaultWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(
      await collectFiles(join(ws.rawDir, "notes")),
      cliOutput(result),
    ).toEqual([
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

  it("keys the manifest per vault name", async () => {
    const ws = await buildTwoVaultWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(
      Object.keys((await readManifest(ws)).vaults).sort(),
      cliOutput(result),
    ).toEqual(["Documents", "Journal"]);
  });

  it("exits non-zero with a stderr message when the config is missing", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [
      join(ws.dir, "nope.json"),
      ws.rawDir,
    ]);

    expect(`${result.code}|${result.err}`).toMatch(
      /^1\|sync-vault: cannot read sync config/,
    );
  });

  it("emits zero ANSI escape sequences when NO_COLOR is set", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(`${result.out}${result.err}`.includes("\x1b[")).toBe(false);
  });

  it("colors the stdout report when NO_COLOR is unset", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir], {
      color: true,
    });

    expect(result.out.includes("\x1b[")).toBe(true);
  });

  it("colors the stderr progress when NO_COLOR is unset", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir], {
      color: true,
    });

    expect(result.err.includes("\x1b[")).toBe(true);
  });

  it("writes the progress lines to stderr, not stdout", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(result.err).toContain(`sync-vault: raw dir ${ws.rawDir}`);
  });

  it("keeps stdout free of progress lines", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(result.out.includes("raw dir")).toBe(false);
  });

  it("hints at all-blocked candidates when the exclusion rule blocks everything", async () => {
    const ws = await buildWorkspace();
    const blockedRoot = join(ws.dir, "Blocked");

    await mkdir(blockedRoot, { recursive: true });
    await writeFile(
      join(blockedRoot, "a.md"),
      "---\nwiki: false\n---\n\n# A\n",
    );
    await writeFile(
      join(blockedRoot, "b.md"),
      "---\nwiki: false\n---\n\n# B\n",
    );

    await writeFile(
      ws.configPath,
      JSON.stringify({
        vaults: [
          { name: VAULT_NAME, root: ws.vaultRoot, exclude: "wiki:false" },
          { name: "Blocked", root: blockedRoot, exclude: "wiki:false" },
        ],
      }),
    );

    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(result.out).toContain(
      `vault "Blocked": 0 selected, 0 copied, 0 unchanged, 0 removed (2 candidates, all blocked)`,
    );
  });

  it("announces the pruned namespace in the report on a rename", async () => {
    const ws = await buildWorkspace();
    const result = await syncThenRename(ws);

    expect(result.out).toContain(
      `- ${VAULT_NAME}/ (stale namespace, not configured)`,
    );
  });

  it("keys the manifest under the new name only after a rename", async () => {
    const ws = await buildWorkspace();

    await syncThenRename(ws);

    expect(Object.keys((await readManifest(ws)).vaults)).toEqual(["Renamed"]);
  });

  it("projects the notes under the new namespace only after a rename", async () => {
    const ws = await buildWorkspace();

    await syncThenRename(ws);

    expect(await collectFiles(join(ws.rawDir, "notes"))).toEqual(
      SELECTED_PATHS.map((rel) => `Renamed/${rel}`),
    );
  });

  it("reports no changes on the re-run after a rename", async () => {
    const ws = await buildWorkspace();

    await syncThenRename(ws);
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(result.out).toContain("sync complete: no changes");
  });

  it("dry-run exits 0 and lists the would-ingest set on stdout", async () => {
    const ws = await buildWorkspace();
    const result = await runCli(SYNC_SCRIPT, [
      "--dry-run",
      ws.configPath,
      ws.rawDir,
    ]);

    expect(`${result.code}\n${result.out}`).toBe(
      [
        "0",
        `vault "${VAULT_NAME}": 7 of 9 candidates would be ingested`,
        ...SELECTED_PATHS.map((rel) => `  + ${rel}`),
        "dry-run complete: nothing written",
        "",
      ].join("\n"),
    );
  });

  it("dry-run writes nothing to the raw dir", async () => {
    const ws = await buildWorkspace();

    await runCli(SYNC_SCRIPT, ["--dry-run", ws.configPath, ws.rawDir]);

    await expect(stat(ws.rawDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still syncs for real after a dry run", async () => {
    const ws = await buildWorkspace();

    await runCli(SYNC_SCRIPT, ["--dry-run", ws.configPath, ws.rawDir]);
    const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

    expect(
      await collectFiles(join(ws.rawDir, "notes")),
      cliOutput(result),
    ).toEqual(SELECTED_PATHS.map((rel) => `${VAULT_NAME}/${rel}`));
  });
});
