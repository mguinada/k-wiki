import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateFixtureVault } from "../src/fixtures/generate.ts";
import { scanVault } from "../src/sync/scan.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sync-scan-"));

  tempDirs.push(dir);

  return dir;
}

/** A fresh fixture vault in a temp dir; return its root. */
async function newVault(): Promise<string> {
  return generateFixtureVault(await makeTempDir());
}

describe("scanVault", () => {
  it("lists every markdown file outside the noise directories", async () => {
    expect(await scanVault(await newVault())).toEqual([
      "AI/RAG.md",
      "AI/llms/attention-is-all-you-need.md",
      "AI/rag-evaluation-notes.md",
      "Inbox/parking-lot.md",
      "Projects/house-renovation.md",
      "Scratch/temp-research.md",
    ]);
  });

  it("ignores files that are not markdown", async () => {
    const vaultRoot = await newVault();

    await mkdir(join(vaultRoot, "Extras"), { recursive: true });
    await writeFile(join(vaultRoot, "Extras", "data.json"), "{}\n");

    expect(await scanVault(vaultRoot)).not.toContain("Extras/data.json");
  });

  it("returns an empty list for an empty vault", async () => {
    const emptyRoot = join(await makeTempDir(), "Empty");

    await mkdir(emptyRoot);

    expect(await scanVault(emptyRoot)).toEqual([]);
  });
});
