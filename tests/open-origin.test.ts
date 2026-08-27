import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildOriginUri, parseOrigin } from "../scripts/open-origin.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../bin/open-origin.ts",
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildOriginUri", () => {
  it("encodes the vault and the file path into the open URI", () => {
    expect(buildOriginUri("Engineering", "AI/foo bar.md")).toBe(
      "obsidian://open?vault=Engineering&file=AI%2Ffoo%20bar.md",
    );
  });
});

describe("parseOrigin", () => {
  it("splits a raw projection origin into vault and in-vault file path", () => {
    expect(parseOrigin("raw/notes/Engineering/AI/foo.md")).toEqual({
      vault: "Engineering",
      file: "AI/foo.md",
    });
  });

  it("accepts an origin written without the raw/ prefix", () => {
    expect(parseOrigin("notes/k-wiki/src/cli/progress.ts")).toEqual({
      vault: "k-wiki",
      file: "src/cli/progress.ts",
    });
  });

  it("rejects an origin that is not a notes/ vault path", () => {
    expect(() => parseOrigin("raw/other/x.md")).toThrow(
      "origin is not a vault path (raw/notes/<vault>/<rest>): raw/other/x.md",
    );
  });

  it("rejects an origin with no file after the vault segment", () => {
    expect(() => parseOrigin("notes/Engineering")).toThrow(
      "origin is not a vault path",
    );
  });
});

/** A data-repo layout: `<root>/wiki/sources/<name>.md` hub plus
 *  `<root>/sync.json` naming the configured vault. */
async function makeInstance(
  hubName: string,
  origin: string | undefined,
  vaults: readonly { name: string; root: string }[],
): Promise<{ configPath: string; wikiDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-origin-"));

  tempDirs.push(root);

  await mkdir(join(root, "wiki", "sources"), { recursive: true });

  const lines = [
    "---",
    `title: "${hubName}"`,
    "type: source",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - source",
  ];

  if (origin !== undefined) {
    lines.push(`origin: raw/${origin}`);
  }

  lines.push('source: "https://example.com"', "---", "", "digest", "");

  await writeFile(
    join(root, "wiki", "sources", `${hubName}.md`),
    lines.join("\n"),
  );
  await writeFile(
    join(root, "sync.json"),
    `${JSON.stringify({
      dataRoot: root,
      vaults: vaults.map((vault) => ({
        name: vault.name,
        root: vault.root,
        exclude: "wiki:false",
      })),
    })}\n`,
  );

  return { configPath: join(root, "sync.json"), wikiDir: join(root, "wiki") };
}

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Spawn the CLI with NO_COLOR and --print (tests never open). */
async function runCli(args: readonly string[]): Promise<RunResult> {
  const real = realpathSync(script);

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [real, ...args],
      { env: { ...process.env, NO_COLOR: "1" } },
      (error, out, err) => {
        resolve({
          code: error === null ? 0 : Number(error.code ?? 1),
          out: out ?? "",
          err: err ?? "",
        });
      },
    );

    child.on("error", reject);
  });
}

describe("open-origin CLI", () => {
  it("prints the obsidian URI for a hub named by page name", async () => {
    const { configPath } = await makeInstance(
      "temp-research",
      "notes/Engineering/Scratch/temp-research.md",
      [{ name: "Engineering", root: "~/vaults/eng" }],
    );

    const result = await runCli([
      "--print",
      "--config",
      configPath,
      "temp-research",
    ]);

    expect(`${result.code}: ${result.out.trim()}`).toBe(
      "0: obsidian://open?vault=Engineering&file=Scratch%2Ftemp-research.md",
    );
  });

  it("accepts a wiki-relative hub path", async () => {
    const { configPath } = await makeInstance(
      "temp-research",
      "notes/Engineering/Scratch/temp-research.md",
      [{ name: "Engineering", root: "~/vaults/eng" }],
    );

    const result = await runCli([
      "--print",
      "--config",
      configPath,
      "sources/temp-research.md",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("obsidian://open?vault=Engineering");
  });

  it("overrides the resolved vault with --vault", async () => {
    const { configPath } = await makeInstance(
      "temp-research",
      "notes/Engineering/Scratch/temp-research.md",
      [{ name: "Engineering", root: "~/vaults/eng" }],
    );

    const result = await runCli([
      "--print",
      "--config",
      configPath,
      "--vault",
      "Eng Vault",
      "temp-research",
    ]);

    expect(result.out.trim()).toBe(
      "obsidian://open?vault=Eng%20Vault&file=Scratch%2Ftemp-research.md",
    );
  });

  it("exits 1 naming the hub when no page matches", async () => {
    const { configPath } = await makeInstance(
      "temp-research",
      "notes/Engineering/Scratch/temp-research.md",
      [{ name: "Engineering", root: "~/vaults/eng" }],
    );

    const result = await runCli([
      "--print",
      "--config",
      configPath,
      "missing-hub",
    ]);

    expect(`${result.code}: ${result.err.includes("missing-hub")}`).toBe(
      "1: true",
    );
  });

  it("exits 1 when the hub carries no origin", async () => {
    const { configPath } = await makeInstance("temp-research", undefined, [
      { name: "Engineering", root: "~/vaults/eng" },
    ]);

    const result = await runCli([
      "--print",
      "--config",
      configPath,
      "temp-research",
    ]);

    expect(`${result.code}: ${result.err.includes("has no origin")}`).toBe(
      "1: true",
    );
  });

  it("exits 1 when the named page is not a type: source hub", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-origin-"));

    tempDirs.push(root);

    await mkdir(join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(
      join(root, "wiki", "concepts", "plain.md"),
      "---\ntitle: Plain\ntype: concept\n---\nbody\n",
    );
    await writeFile(
      join(root, "sync.json"),
      `${JSON.stringify({
        dataRoot: root,
        vaults: [{ name: "Engineering", root: "~/v", exclude: "wiki:false" }],
      })}\n`,
    );

    const result = await runCli([
      "--print",
      "--config",
      join(root, "sync.json"),
      "plain",
    ]);

    expect(`${result.code}: ${result.err.includes("type: source")}`).toBe(
      "1: true",
    );
  });

  it("exits 1 when the origin's vault is not configured in sync.json", async () => {
    const { configPath } = await makeInstance(
      "temp-research",
      "notes/Elsewhere/Scratch/temp-research.md",
      [{ name: "Engineering", root: "~/vaults/eng" }],
    );

    const result = await runCli([
      "--print",
      "--config",
      configPath,
      "temp-research",
    ]);

    expect(`${result.code}: ${result.err.includes('vault "Elsewhere"')}`).toBe(
      "1: true",
    );
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runCli(["--help"]);

    expect(
      `${result.code}: ${result.out.startsWith("Usage: open-origin")}`,
    ).toBe("0: true");
  });
});
