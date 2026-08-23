import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Hunk scoping for the advisory mutation run (issue #99, phase 1a).
//
// Prints the --mutate argument for `stryker run`: one `file:start-end`
// entry per changed hunk of the src/*.ts files that differ from
// origin/main (uncommitted work included), or whole-file entries for
// new/untracked files and unparseable diffs. Prints nothing — and the
// caller skips the run — when nothing under src/ changed.
//
// Why -U0 and new-side line numbers: with zero context lines each hunk
// header names exactly the lines the branch touched, and Stryker's
// `file:start-end` mutate syntax addresses the new side of the diff.

export type Range = { start: number; end: number };

/** Reads the stdout of a git invocation; the seam tests fake. */
export type GitText = (args: readonly string[]) => string;

export type FileDiff = { path: string; ranges: Range[] | null };

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-scope [-h | --help]

Print the --mutate argument that scopes a Stryker run to the src/*.ts
lines changed vs origin/main (uncommitted work included): one
file:start-end entry per changed hunk, whole-file entries for new or
untracked files, whole-file fallback for unparseable diffs. Deleted
files are skipped. Prints nothing when no src/ file changed.

  -h, --help    Print this help and exit; no side effects.

Reads git (diff, ls-files) and the repository only; writes nothing.`;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** New-side line ranges of one file's -U0 diff; null when unparseable. */
export function parseNewRanges(diffText: string): Range[] | null {
  const ranges: Range[] = [];

  for (const line of diffText.split("\n")) {
    if (!line.startsWith("@@")) {
      continue;
    }

    const match = HUNK_HEADER.exec(line);

    if (match === null) {
      return null;
    }

    const start = Number(match[1]);

    const count = match[2] === undefined ? 1 : Number(match[2]);

    if (count > 0) {
      ranges.push({ start, end: start + count - 1 });
    }
  }

  return ranges;
}

/** Collapse overlapping and back-to-back ranges into one each. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  const merged: Range[] = [];

  for (const range of sorted) {
    const last = merged.at(-1);

    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/** One comma-separated --mutate list entry per file: ranged, or bare. */
export function buildPatterns(files: FileDiff[]): string {
  const patterns: string[] = [];

  for (const file of files) {
    if (file.ranges === null) {
      patterns.push(file.path);
    } else {
      for (const range of mergeRanges(file.ranges)) {
        patterns.push(`${file.path}:${range.start}-${range.end}`);
      }
    }
  }

  return patterns.join(",");
}

/** Split one multi-file -U0 diff into per-file entries. */
function parseFileDiffs(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];

  let path: string | null = null;

  let body: string[] = [];

  const flush = () => {
    if (path !== null) {
      files.push({ path, ranges: parseNewRanges(body.join("\n")) });
    }

    path = null;

    body = [];
  };

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4);

      if (target === "/dev/null") {
        // A deletion: no new side to mutate.
        path = null;
      } else if (target.startsWith("b/")) {
        path = target.slice(2);
      }
    } else if (path !== null) {
      body.push(line);
    }
  }

  flush();

  return files;
}

/** The full --mutate argument, or "" when nothing mutable changed. */
export function collectPatterns(git: GitText): string {
  const diffText = git([
    "diff",
    "-U0",
    "--diff-filter=ACMRT",
    "origin/main",
    "--",
    "src/*.ts",
  ]);

  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "src/*.ts",
  ]);

  const files = parseFileDiffs(diffText);

  for (const path of untracked.split("\n").filter((line) => line !== "")) {
    files.push({ path, ranges: null });
  }

  return buildPatterns(files);
}

function runGitText(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

export function main(argv: readonly string[], git: GitText = runGitText) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  const patterns = collectPatterns(git);

  if (patterns !== "") {
    console.log(patterns);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
