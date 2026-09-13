import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../e2e/helpers.ts";

/** CLI tests for bin/libexec/lint-worklists
 *  (scripts/lint-worklists.ts, issue #359): the deterministic
 *  pre-pass door — help, the rendered sections, the default wiki
 *  dir. The library core (computeWikiWorklists) is tested at its
 *  mirrored path tests/wiki/worklists.test.ts. */

const script = realpathSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../bin/libexec/lint-worklists",
  ),
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeWiki(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-worklists-cli-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, "wiki", ...file.split("/").slice(0, -1)), {
      recursive: true,
    });
    await writeFile(join(root, "wiki", file), content);
  }

  return root;
}

describe("lint-worklists CLI", () => {
  it("answers -h with usage and exits clean", async () => {
    const result = await runCli(script, ["-h"]);

    expect(result.code).toBe(0);
    expect(result.out.startsWith("Usage: lint-worklists")).toBe(true);
    expect(result.out).toContain("Default: the repo's");
    expect(result.err).toBe("");
  });

  it("prints every section for the given wiki dir", async () => {
    const root = await makeWiki({
      "index.md": "# Index\n",
      "a.md": "---\ntitle: A\ntype: concept\n---\nbody\n",
    });
    const result = await runCli(script, [join(root, "wiki")]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("### Orphan candidates (1)");
    expect(result.out).toContain("- a.md — no inbound links");
    expect(result.out).toContain("### Dangling index entries (0)");
  });

  it("exits 1 naming an unreadable wiki dir", async () => {
    const result = await runCli(script, [
      join(tmpdir(), "k-wiki-absent-worklists"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("lint-worklists:");
  });

  it("rejects a second positional", async () => {
    const result = await runCli(script, ["a", "b"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("takes at most one <wiki-dir>");
  });
});
