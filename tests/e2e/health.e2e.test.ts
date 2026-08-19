import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VAULT_NAME } from "../../src/fixtures/generate.ts";
import {
  buildWorkspace,
  cleanupWorkspaces,
  HEALTH_SCRIPT,
  runCli,
  SYNC_SCRIPT,
  type Workspace,
} from "./helpers.ts";

/**
 * Health-CLI e2e: each sabotage case is permanent test state, not a
 * one-shot human check. Every it builds a fresh, real projection with
 * the sync CLI, sabotages it, then runs
 * `node src/health/check-raw.ts <raw>` as a child process.
 */

function rawNotePath(ws: Workspace, relPath: string): string {
  return join(ws.rawDir, "notes", VAULT_NAME, ...relPath.split("/"));
}

async function buildProjection(): Promise<Workspace> {
  const ws = await buildWorkspace();
  const result = await runCli(SYNC_SCRIPT, [ws.configPath, ws.rawDir]);

  if (result.code !== 0) {
    throw new Error(
      `sync CLI failed while building the projection:\n${result.out}${result.err}`,
    );
  }

  return ws;
}

afterAll(cleanupWorkspaces);

describe("health CLI sabotage checks", () => {
  it("exits 1 and names the file when a projected byte is corrupted", async () => {
    const ws = await buildProjection();
    const notePath = rawNotePath(ws, "AI/RAG.md");
    const bytes = await readFile(notePath);
    const lastIndex = bytes.length - 1;

    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 1;
    await writeFile(notePath, bytes);

    const result = await runCli(HEALTH_SCRIPT, [ws.rawDir]);

    expect(`${result.code}|${result.out}${result.err}`).toMatch(
      /1\|.*notes\/Documents\/AI\/RAG\.md: hash mismatch/,
    );
  });

  it("exits 1 and names an orphan markdown file under a namespace", async () => {
    const ws = await buildProjection();

    await writeFile(rawNotePath(ws, "AI/orphan.md"), "# Orphan\n");

    const result = await runCli(HEALTH_SCRIPT, [ws.rawDir]);

    expect(`${result.code}|${result.out}${result.err}`).toMatch(
      /1\|.*notes\/Documents\/AI\/orphan\.md: orphan/,
    );
  });

  it("exits 1 and names the file when a manifest entry loses its projection", async () => {
    const ws = await buildProjection();

    await rm(rawNotePath(ws, "Scratch/temp-research.md"));

    const result = await runCli(HEALTH_SCRIPT, [ws.rawDir]);

    expect(`${result.code}|${result.out}${result.err}`).toMatch(
      /1\|.*notes\/Documents\/Scratch\/temp-research\.md: missing/,
    );
  });

  it("exits 0 with the healthy line on an intact projection", async () => {
    const ws = await buildProjection();

    const result = await runCli(HEALTH_SCRIPT, [ws.rawDir]);

    expect(`${result.code}|${result.out}${result.err}`).toBe(
      "0|healthy: manifest and projection agree (7 notes, 1 vault)\n",
    );
  });
});
