import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";

/**
 * The src/ refactor campaign's measuring instrument: a zero-dependency
 * regex scan over a TypeScript tree that prints the structure
 * counters the campaign tracks — file-size bands, cross-domain import
 * edges (the `cli` directory is the shared layer and its edges never
 * count), and the named duplication counters. Doc-time baseline
 * values in the epic are informational; this scanner's fresh output
 * is the live instrument, frozen by tests/quality/refactor-metrics
 * baseline budget (the seed of the structure guard).
 */

/** Every counter the scanner prints, in output order. */
export interface StructureMetrics {
  /** `.ts` files over 800 lines. */
  readonly filesOver800: number;
  /** `.ts` files over 500 lines. */
  readonly filesOver500: number;
  /** `.ts` files over 350 lines. */
  readonly filesOver350: number;
  /** Line count of the largest `.ts` file. */
  readonly maxFileLines: number;
  /** Relative imports whose file's domain differs from the target's
   *  (cli endpoints excluded). */
  readonly crossDomainEdges: number;
  /** Local parseArgs/parseCliArgs definitions. */
  readonly parseArgsCopies: number;
  /** Local walk-named directory-walker definitions. */
  readonly directoryWalkers: number;
  /** Repo-root derivations from the module-URL idiom. */
  readonly repoRootDerivations: number;
  /** Local unquote definitions. */
  readonly unquoteDefinitions: number;
  /** Function signatures binding an `env` parameter, in any form. */
  readonly envSignatures: number;
  /** Files holding at least one `env`-binding signature. */
  readonly envSignatureFiles: number;
  /** Function signatures binding both `dataRoot` and `env`. */
  readonly dataRootEnvPairs: number;
  /** `dirname(...)` calls whose argument mentions `rawDir`. */
  readonly dirnameRawDirDerivations: number;
}

/** One scanned file: its root-relative path and full text. */
interface ScannedFile {
  readonly relPath: string;
  readonly text: string;
}

/** A relative import specifier and the importing file. */
interface ImportEdge {
  readonly importer: ScannedFile;
  readonly specifier: string;
}

/** The human-readable label for each counter, in print order. */
const METRIC_LABELS: readonly (readonly [keyof StructureMetrics, string])[] = [
  ["filesOver800", "files >800 lines"],
  ["filesOver500", "files >500 lines"],
  ["filesOver350", "files >350 lines"],
  ["maxFileLines", "max file lines"],
  ["crossDomainEdges", "cross-domain edges (excl. cli)"],
  ["parseArgsCopies", "parseArgs copies"],
  ["directoryWalkers", "directory walkers"],
  ["repoRootDerivations", "repoRoot derivations"],
  ["unquoteDefinitions", "unquote definitions"],
  ["envSignatures", "env: signatures"],
  ["envSignatureFiles", "env: signature files"],
  ["dataRootEnvPairs", "(dataRoot, env) pairs"],
  ["dirnameRawDirDerivations", "dirname derivations of rawDir"],
];

const IMPORT_PATTERN = /from\s+["']([^"']+)["']/g;
const SIGNATURE_PATTERN =
  /(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\()([^)]*)/g;
const PARSE_ARGS_PATTERN =
  /(?:\bfunction\s+(?:parseArgs|parseCliArgs)|\b(?:parseArgs|parseCliArgs)\s*=\s*(?:async\s*)?)\s*\(/g;
const WALKER_PATTERN =
  /(?:\bfunction\s+walk\w*|\bwalk\w*\s*=\s*(?:async\s*)?)\s*\(/g;
const REPO_ROOT_PATTERN = /fileURLToPath\(import\.meta\.url\)/g;
const UNQUOTE_PATTERN =
  /(?:\bfunction\s+unquote|\bunquote\s*=\s*(?:async\s*)?)\s*\(/g;
const DIRNAME_RAW_DIR_PATTERN = /dirname\(\s*[^)]*rawDir[^)]*\)/g;
const ENV_PARAM = /\benv\b/;
const DATA_ROOT_PARAM = /\bdataRoot\b/;

/** Every `.ts` file under `root`, deepest-free, sorted by path. */
async function listTsFiles(root: string, prefix = ""): Promise<ScannedFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: ScannedFile[] = [];

  for (const entry of entries) {
    const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(join(root, entry.name), relPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push({
        relPath,
        text: await readFile(join(root, entry.name), "utf8"),
      });
    }
  }

  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** `wc -l`-equivalent line count for a file body. */
function countLines(text: string): number {
  const newlines = [...text.matchAll(/\n/g)].length;

  return text.length === 0 || text.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * The domain of a root-relative path: its first path segment, or
 * `root:<stem>` for a file directly under the scanned root — every
 * root-level file is its own domain, so imports reaching into the
 * root sprawl count as cross-domain.
 */
function domainOf(relPath: string): string {
  const separator = relPath.indexOf("/");

  return separator === -1
    ? `root:${relPath.replace(/\.ts$/, "")}`
    : relPath.slice(0, separator);
}

/** All relative import edges in the scanned files, in scan order. */
function relativeImports(files: readonly ScannedFile[]): ImportEdge[] {
  const edges: ImportEdge[] = [];

  for (const file of files) {
    for (const match of file.text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? "";

      if (specifier.startsWith(".")) {
        edges.push({ importer: file, specifier });
      }
    }
  }

  return edges;
}

/** Import edges crossing domain boundaries, `cli`-endpoint ones
 *  excluded (the shared layer everyone may use). */
function countCrossDomainEdges(
  root: string,
  edges: readonly ImportEdge[],
): number {
  let count = 0;

  for (const edge of edges) {
    const target = relative(
      root,
      resolve(root, dirname(edge.importer.relPath), edge.specifier),
    )
      .split(sep)
      .join("/");
    const importerDomain = domainOf(edge.importer.relPath);
    const targetDomain = domainOf(target);

    if (
      !target.startsWith("..") &&
      importerDomain !== "cli" &&
      targetDomain !== "cli" &&
      importerDomain !== targetDomain
    ) {
      count += 1;
    }
  }

  return count;
}

/** Total matches of one global regex across all scanned texts. */
function countMatches(files: readonly ScannedFile[], pattern: RegExp): number {
  return files.reduce(
    (sum, file) => sum + [...file.text.matchAll(pattern)].length,
    0,
  );
}

/** One scanned signature: its parameter-list text. */
interface Signature {
  readonly file: string;
  readonly params: string;
}

/** Every function or arrow-const signature in the scanned files. */
function scanSignatures(files: readonly ScannedFile[]): Signature[] {
  const signatures: Signature[] = [];

  for (const file of files) {
    for (const match of file.text.matchAll(SIGNATURE_PATTERN)) {
      signatures.push({ file: file.relPath, params: match[1] ?? "" });
    }
  }

  return signatures;
}

/** env-parameter signature counts: total and per-file spread. */
function countEnvSignatures(signatures: readonly Signature[]): {
  total: number;
  files: number;
} {
  const envSignatures = signatures.filter((signature) =>
    ENV_PARAM.test(signature.params),
  );

  return {
    total: envSignatures.length,
    files: new Set(envSignatures.map((signature) => signature.file)).size,
  };
}

/** Signatures carrying both `dataRoot` and `env` parameters. */
function countDataRootEnvPairs(signatures: readonly Signature[]): number {
  return signatures.filter(
    (signature) =>
      DATA_ROOT_PARAM.test(signature.params) &&
      ENV_PARAM.test(signature.params),
  ).length;
}

/** Scan `rootInput` recursively and compute every counter. */
export async function collectMetrics(
  rootInput: string,
): Promise<StructureMetrics> {
  const root = resolve(rootInput);
  const files = await listTsFiles(root);
  const lineCounts = files.map((file) => countLines(file.text));
  const signatures = scanSignatures(files);
  const envSignatures = countEnvSignatures(signatures);

  return {
    filesOver800: lineCounts.filter((lines) => lines > 800).length,
    filesOver500: lineCounts.filter((lines) => lines > 500).length,
    filesOver350: lineCounts.filter((lines) => lines > 350).length,
    maxFileLines: lineCounts.reduce((max, lines) => Math.max(max, lines), 0),
    crossDomainEdges: countCrossDomainEdges(root, relativeImports(files)),
    parseArgsCopies: countMatches(files, PARSE_ARGS_PATTERN),
    directoryWalkers: countMatches(files, WALKER_PATTERN),
    repoRootDerivations: countMatches(files, REPO_ROOT_PATTERN),
    unquoteDefinitions: countMatches(files, UNQUOTE_PATTERN),
    envSignatures: envSignatures.total,
    envSignatureFiles: envSignatures.files,
    dataRootEnvPairs: countDataRootEnvPairs(signatures),
    dirnameRawDirDerivations: countMatches(files, DIRNAME_RAW_DIR_PATTERN),
  };
}

/** The counters as a plain JSON-ready object. */
function toPlainObject(metrics: StructureMetrics): Record<string, number> {
  return Object.fromEntries(METRIC_LABELS.map(([key]) => [key, metrics[key]]));
}

/** The human-readable counter table, one line per counter. */
function renderTable(metrics: StructureMetrics): string {
  return METRIC_LABELS.map(([key, label]) => `${label}: ${metrics[key]}`)
    .join("\n")
    .concat("\n");
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: refactor-metrics [--json] [<root>] [-h | --help]

Scan a TypeScript tree recursively and print the src/ refactor
campaign's structure counters. Every counter measures structural
debt: lower is better, and the unit suite freezes each counter at
or below the committed baseline budget.

Counters:

  files >800 / >500 / >350
                  .ts files over each size band. Fewer oversized
                  files is better.
  max file lines  Lines of the largest file. Smaller is better.
  cross-domain edges
                  Relative imports crossing top-level domains.
                  Imports whose importer or target is the cli
                  shared layer never count. Fewer boundary
                  crossings is better.
  parseArgs copies
                  Local parseArgs/parseCliArgs definitions, in
                  declaration or arrow form. Fewer copies is
                  better: one shared CLI shell is the goal.
  directory walkers
                  Local walk-named recursive directory walkers.
                  Fewer is better: one shared walker is the goal.
  repoRoot derivations
                  Sites deriving the repo root from the module
                  URL idiom. Fewer is better: one canonical
                  derivation is the goal.
  unquote definitions
                  Local unquote definitions. Fewer is better.
  env: signatures / env: signature files
                  Function signatures binding an env parameter,
                  and the number of files holding them. Fewer is
                  better: one run-context object is the goal.
  (dataRoot, env) pairs
                  Signatures binding both dataRoot and env.
                  Fewer is better.
  dirname derivations of rawDir
                  dirname calls whose argument mentions rawDir.
                  Fewer is better: derive the parent once.

  <root>   Directory to scan for .ts files. Default: the src/
           directory of this repository.

  --json   Print the counters as one JSON object keyed by counter
           name, instead of the human-readable table.

  -h, --help
           Print this help and exit; no side effects.

Writes the counter table (or JSON object) to stdout. Exit 0 after
printing; exit 1 when the scan directory is missing or unreadable.`;

/** Parse argv through the shared CLI shell into the scan root and
 *  the JSON switch. */
function metricsOptions(argv: readonly string[]): {
  root: string;
  json: boolean;
} {
  const parsed = parseArgs(argv, {
    boolean: ["--json"],
    positionals: { max: 1, error: (arg) => `unexpected argument: ${arg}` },
  });

  if (parsed.error !== undefined) {
    throw new Error(parsed.error);
  }

  return {
    root: parsed.positional[0] ?? join(repoRoot, "src"),
    json: parsed.flags.has("--json"),
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  try {
    const options = metricsOptions(argv);
    const metrics = await collectMetrics(options.root);

    if (options.json) {
      console.log(JSON.stringify(toPlainObject(metrics)));
    } else {
      console.log(renderTable(metrics).trimEnd());
    }
  } catch (cause) {
    console.error(`refactor-metrics: ${errorMessage(cause)}`);
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/quality/refactor-metrics.ts` runs */
refuseDirectExecution(import.meta.url, "refactor-metrics", "dev");
