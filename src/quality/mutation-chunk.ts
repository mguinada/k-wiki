import { statSync } from "node:fs";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { type GitText, runGitText } from "./mutation-scope.ts";

// Chunked full mutation runs (issue #236): the nightly Stryker run
// outgrew GitHub's 6 h per-job limit (8619 mutants, cancelled at
// 5 h 58 m before any report existed), so CI splits `mutate` across
// parallel chunk jobs. This tool prints the --mutate argument for one
// chunk: the src/*.ts files balanced over N chunks by file size
// (largest-first greedy), so no chunk inherits the whole runtime.
// src/quality/mutation-merge.ts stitches the chunk reports back
// together.

/** One mutable src/ file with the size that balances chunks. */
export type SrcFile = { path: string; size: number };

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: mutation-chunk --index <n> --total <n> [-h | --help]

Print the comma-separated --mutate file list for one chunk of a
chunked full mutation run: all git-tracked src/*.ts files, split
into --total chunks balanced by file size (each file goes to the
currently smallest chunk, largest file first, path order breaking
ties — deterministic for the same tree). Chunks are disjoint and
together cover every file; a chunk's list feeds
\`stryker run --mutate "<list>"\` in its own CI job.

  --index <n>     Which chunk to print, 1-based (1..--total).
  --total <n>     How many chunks to split src/ into. Must not
                  exceed the file count. Default: none — required.

  -h, --help      Print this help and exit; no side effects.

Reads git (ls-files) and stats the src/ tree; writes nothing. Exit 0
with the chunk's comma-separated file list on stdout; exit 1 when
--index/--total are missing or out of range, or when src/ holds fewer
files than chunks (lower --total).`;

/** Balance files over chunks: largest file first, onto the currently
 *  smallest chunk; path order breaks every tie. */
export function assignChunks(
  files: readonly SrcFile[],
  total: number,
): string[][] {
  if (total < 1) {
    throw new Error("--total must be at least 1");
  }

  if (files.length < total) {
    throw new Error(
      `fewer files than chunks: ${files.length} files cannot split into ${total} chunks — lower --total`,
    );
  }

  const ordered = [...files].sort(
    (a, b) => b.size - a.size || (a.path < b.path ? -1 : 1),
  );

  const buckets: { paths: string[]; load: number }[] = Array.from(
    { length: total },
    () => ({ paths: [], load: 0 }),
  );

  for (const file of ordered) {
    const lightest = buckets.reduce((smallest, bucket) =>
      bucket.load < smallest.load ? bucket : smallest,
    );

    lightest.paths.push(file.path);

    lightest.load += file.size;
  }

  return buckets.map((bucket) => bucket.paths);
}

/** The src/ files git tracks, with their byte sizes. */
export function collectSrcFiles(git: GitText): SrcFile[] {
  const listed = git(["ls-files", "--", "src/*.ts"]);

  return listed
    .split("\n")
    .filter((line) => line !== "")
    .map((path) => ({ path, size: statSync(path).size }));
}

interface Options {
  index?: number | undefined;
  total?: number | undefined;
}

/** Parse argv into --index/--total; throws naming the missing or
 *  malformed switch. */
function parseArgs(argv: readonly string[]): Options {
  const options: { index?: number; total?: number } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--index" || arg === "--total") {
      const value = Number(argv[i + 1]);

      if (argv[i + 1] === undefined || !Number.isInteger(value)) {
        throw new Error(`${arg} requires an integer value`);
      }

      i += 1;

      if (arg === "--index") {
        options.index = value;
      } else {
        options.total = value;
      }
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

/** The comma-separated mutate list for one chunk; throws the
 *  user-facing error when the arguments or tree cannot produce one. */
function chunkList(
  argv: readonly string[],
  collect: (git: GitText) => SrcFile[],
  git: GitText,
): string {
  const options = parseArgs(argv);

  if (options.index === undefined) {
    throw new Error("--index is required — see --help");
  }

  if (options.total === undefined) {
    throw new Error("--total is required — see --help");
  }

  if (options.index < 1 || options.index > options.total) {
    throw new Error(`--index must be 1..${options.total}`);
  }

  const chunk =
    assignChunks(collect(git), options.total)[options.index - 1] ?? [];

  return chunk.join(",");
}

export function main(
  argv: readonly string[],
  collect: (git: GitText) => SrcFile[] = collectSrcFiles,
  git: GitText = runGitText,
): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  try {
    console.log(chunkList(argv, collect, git));
  } catch (cause) {
    console.error(errorMessage(cause));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/quality/mutation-chunk.ts` runs */
refuseDirectExecution(import.meta.url, "mutation-chunk", "dev");
