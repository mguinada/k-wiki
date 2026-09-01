import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The convention guard for internal GitHub issue references in
 * user-facing surfaces (issue #202): `--help` output and README.md
 * explain behavior to end users; tracker history belongs in the
 * design record (docs/karpathy_wiki_implementation_guide.md) and
 * dev-facing code comments. Every bin/*.ts and dev/*.ts launcher is
 * executed with --help — which must exit 0 without side effects —
 * and its output plus README.md are matched against the citation
 * pattern. `issues? #` so "issue #11" and "issues #67 and #72" both
 * trip; the text is whitespace-normalized first so a citation broken
 * across lines ("(issue\n  #95)") cannot slip through.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUE_REFERENCE = /issues? #\d+/i;

/** Collapse all whitespace so line-wrapped citations still match. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The launcher directories: the runtime bin/ class and the dev/ one. */
const LAUNCHER_DIRS = ["bin", "dev"] as const;

async function collectLaunchers(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

function runHelp(dir: string, launcher: string): string {
  return execFileSync(
    process.execPath,
    [join(repoRoot, dir, launcher), "--help"],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

describe("user-facing surfaces carry no issue references (issue #202 guard)", () => {
  it("README.md contains no issue reference", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");

    expect(normalize(readme).match(ISSUE_REFERENCE)).toBeNull();
  });

  it("bin/*.ts and dev/*.ts help output contains no issue reference", async () => {
    const offenders: string[] = [];

    for (const dir of LAUNCHER_DIRS) {
      for (const launcher of await collectLaunchers(dir)) {
        const citation = normalize(runHelp(dir, launcher)).match(
          ISSUE_REFERENCE,
        );

        if (citation !== null) {
          offenders.push(`${dir}/${launcher}: ${citation[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
