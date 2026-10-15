import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The no-fetch-head guard (issue #464, addendum): the writer runtime
 * never anchors reads on git's shared fetch-head file — any git
 * process touching the repo can rewrite or empty it mid-tenure (a
 * zero-match fetch truncates it to 0 bytes), and the 2026-10-14
 * incident died at a lease renewal on exactly that read. The guard
 * bans the literal under src/ and scripts/, comments included — a
 * documented FETCH_HEAD read is still a FETCH_HEAD read.
 *
 * The one explicit allowlisted exception is the observability
 * module's diagnostic-only git-dir stat (its `{exists, size}` state
 * for the maintenance line, per the issue's addendum): an
 * allowlisted file may carry the literal only on comment lines or
 * the diagnostic `stat(join(...))` site; any operational use
 * inside an exempt file — a ref or refspec argument, a refish
 * default, a merge target — is still an offender. Any further
 * exception needs an allowlist entry here plus a written
 * justification in the PR body (same policy class as Stryker
 * disables). Same enforcement style as the mirrored-tree and
 * no-re-export-shim guards; the scan reads the real tree and skips
 * inside the Stryker sandbox (issue #276).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Recursively collect repo-relative .ts paths under `root`. */
async function collectTsFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(join(root, entry.name), rel)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(rel);
    }
  }

  return files.sort();
}

/**
 * The literal is banned verbatim. Line numbers are 1-based,
 * matching editor navigation.
 */
const BANNED = "FETCH_HEAD";

/**
 * Explicit allowlist: exactly one entry, the diagnostic-only
 * observability stat (issue #464 addendum). The justification names
 * the narrow shape the exempt file may use the literal in — see
 * `isDiagnosticOccurrence` below.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "src/writer/maintenance-log.ts":
    "diagnostic-only exception (issue #464): FETCH_HEAD is referenced solely as a filesystem path for its {exists, size} state in the sanitized maintenance line — never passed to git as a ref/refspec, never read/returned as contents, and no operational behavior branches on it ({exists, size} only)",
};

/** Biome-formatted comment lines: `// …`, `* …`, `/* …`. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();

  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

/** Whether one occurrence of the literal in an allowlisted file is
 *  inside the sanctioned diagnostic shape: a comment naming the
 *  exception, the `stat(join(...))` state probe, or the rendered
 *  `{exists, size}` label the sanitized maintenance line requires.
 *  Everything else — a ref argument, a refish default, a merge
 *  target — stays an offender even under the entry. */
function isDiagnosticOccurrence(line: string): boolean {
  if (isCommentLine(line)) {
    return true;
  }

  if (/\bstat\s*\(/.test(line) && /\bjoin\s*\(/.test(line)) {
    return true;
  }

  return /FETCH_HEAD \{exists: \$\{fetchHead\.exists\}, size: \$\{fetchHead\.size\}\}/.test(
    line,
  );
}

/** The file:line offenders of one scanned file's lines: every
 *  occurrence of the literal, except the sanctioned diagnostic shape
 *  in an allowlisted file. */
function offenderSites(
  file: string,
  lines: readonly string[],
): readonly string[] {
  const sites: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.includes(BANNED)) {
      continue;
    }

    if (ALLOWLIST[file] !== undefined && isDiagnosticOccurrence(line)) {
      continue;
    }

    sites.push(`${file}:${index + 1}`);
  }

  return sites;
}

describe("offenderSites detector (issue #464 addendum)", () => {
  const operationalForms: readonly (readonly string[])[] = [
    [
      'const tree = await gitOut(git, ["rev-parse", "--verify", "FETCH_HEAD^{tree}"]);',
    ],
    [
      'export async function fetchedTreeOid(git: GitRunner, refish = "FETCH_HEAD") {',
    ],
    ['await mergeFfOnly(git, "FETCH_HEAD");'],
    [
      'await fetchRefspec(git, "origin", "refs/heads/main"); // FETCH_HEAD was rewritten',
    ],
    ['  const ref = "FETCH_HEAD";'],
  ];

  const diagnosticForms: readonly (readonly string[])[] = [
    ['    const info = await stat(join(gitDir, "FETCH_HEAD"));'],
    [" *  diagnostic-only exception: stat {exists, size} of FETCH_HEAD only."],
    ["// The one no-fetch-head exception reads FETCH_HEAD's {exists, size}."],
    [
      `\`FETCH_HEAD {exists: \${fetchHead.exists}, size: \${fetchHead.size}}\`,`,
    ],
  ];

  for (const lines of operationalForms) {
    it(`rejects the operational use: ${lines.join(" ")}`, () => {
      const sites = offenderSites("src/writer/maintenance-log.ts", lines);

      expect(sites).not.toEqual([]);
    });
  }

  for (const lines of diagnosticForms) {
    it(`accepts the diagnostic occurrence: ${lines.join(" ")}`, () => {
      const sites = offenderSites("src/writer/maintenance-log.ts", lines);

      expect(sites).toEqual([]);
    });
  }

  it("rejects every literal in a non-exempt file, even the diagnostic shape", () => {
    const sites = offenderSites("src/writer/leased-cycle.ts", [
      '    const info = await stat(join(gitDir, "FETCH_HEAD"));',
    ]);

    expect(sites).toEqual(["src/writer/leased-cycle.ts:1"]);
  });

  it("reports 1-based file:line sites in file order", () => {
    const sites = offenderSites("src/sync/other.ts", [
      "const a = 1;",
      'const tree = "FETCH_HEAD";',
      "const b = 2;",
      "mergeFfOnly(git, FETCH_HEAD);",
    ]);

    expect(sites).toEqual(["src/sync/other.ts:2", "src/sync/other.ts:4"]);
  });
});

describe("no-fetch-head guard (issue #464)", () => {
  it("contains no operational FETCH_HEAD use under src/ or scripts/", async ({
    skip,
  }) => {
    if (
      import.meta.url.includes(".stryker-tmp") ||
      "__stryker__" in globalThis
    ) {
      skip(
        "Stryker sandbox instruments the tree; the scan reads the real src/ (issue #276)",
      );

      return;
    }

    const offenders: string[] = [];

    for (const root of ["src", "scripts"]) {
      for (const file of await collectTsFiles(join(repoRoot, root), root)) {
        const lines = (await readFile(join(repoRoot, file), "utf8")).split(
          "\n",
        );

        offenders.push(...offenderSites(file, lines));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist explicit at exactly its one documented entry", () => {
    expect(Object.keys(ALLOWLIST)).toEqual(["src/writer/maintenance-log.ts"]);
  });

  it("the exempt file exists and carries the exception non-vacuously", async () => {
    const path = join(repoRoot, "src/writer/maintenance-log.ts");
    const lines = (await readFile(path, "utf8")).split("\n");
    const withLiteral = lines.filter((line) => line.includes(BANNED));

    // The exemption is earned on disk: the sanctioned stat site and
    // its documentation must actually be present.
    expect(withLiteral.some((line) => /\bstat\s*\(/.test(line))).toBe(true);
  });
});
