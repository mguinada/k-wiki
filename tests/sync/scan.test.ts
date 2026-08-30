import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateFixtureVault } from "../../src/fixtures/generate.ts";
import { scanVault } from "../../src/sync/scan.ts";

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
      "Inbox/clipped-note.md",
      "Inbox/parking-lot.md",
      "Inbox/quick-idea.md",
      "Projects/house-renovation.md",
      "Projects/private-clipped.md",
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

  it("skips markdown files inside the noise directories", async () => {
    const vaultRoot = await newVault();

    await mkdir(join(vaultRoot, ".obsidian", "plugins"), { recursive: true });
    await writeFile(join(vaultRoot, ".obsidian", "plugins", "bug.md"), "x\n");
    await mkdir(join(vaultRoot, ".trash"), { recursive: true });
    await writeFile(join(vaultRoot, ".trash", "gone.md"), "x\n");

    expect(await scanVault(vaultRoot)).not.toContain(
      ".obsidian/plugins/bug.md",
    );
  });

  it("skips markdown files inside the .trash directory", async () => {
    const vaultRoot = await newVault();

    await mkdir(join(vaultRoot, ".trash"), { recursive: true });
    await writeFile(join(vaultRoot, ".trash", "gone.md"), "x\n");

    expect(await scanVault(vaultRoot)).not.toContain(".trash/gone.md");
  });

  it("returns files in sorted order whatever the directory order", async () => {
    const vaultRoot = await newVault();

    // Mixed case: a case-insensitive directory listing (macOS APFS)
    // orders a.md before B.md, while the contract's default string
    // order puts B.md first — so an unsorted walk cannot pass.
    await writeFile(join(vaultRoot, "a.md"), "x\n");
    await writeFile(join(vaultRoot, "B.md"), "x\n");

    expect(await scanVault(vaultRoot)).toEqual([
      "AI/RAG.md",
      "AI/llms/attention-is-all-you-need.md",
      "AI/rag-evaluation-notes.md",
      "B.md",
      "Inbox/clipped-note.md",
      "Inbox/parking-lot.md",
      "Inbox/quick-idea.md",
      "Projects/house-renovation.md",
      "Projects/private-clipped.md",
      "Scratch/temp-research.md",
      "a.md",
    ]);
  });

  it("excludes a symlink whose name ends in .md", async () => {
    const vaultRoot = await newVault();

    await symlink(
      join(vaultRoot, "AI", "RAG.md"),
      join(vaultRoot, "AI", "alias.md"),
    );

    expect(await scanVault(vaultRoot)).not.toContain("AI/alias.md");
  });

  it("reports each visited directory to the walk callback", async () => {
    const root = await makeTempDir();

    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a.md"), "x");
    await writeFile(join(root, "a", "n.md"), "x");
    await writeFile(join(root, "a", "b", "n.md"), "x");

    const visited: number[] = [];

    await scanVault(root, (count) => visited.push(count));

    expect(visited).toEqual([1, 2, 3]);
  });

  it("keeps the walk callback optional", async () => {
    const root = await newVault();

    expect(await scanVault(root)).toContain("AI/RAG.md");
  });
});
