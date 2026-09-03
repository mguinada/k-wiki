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
 * is the live instrument, held at or below the per-counter budgets
 * in `.structureguard.json` by the structure gate
 * (tests/quality/structure.test.ts).
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
  /** Relative imports from the data domain into the sync domain —
   *  the layering inversion the refactor campaign solved; the
   *  structure guard pins this at zero. */
  readonly dataToSyncEdges: number;
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
  /** 1-based line of the import statement in the importing file. */
  readonly line: number;
}

/** One attributed counter site: the root-relative file, the 1-based
 *  line of the offending construct where a single line is the
 *  offender, and the file's line count for the file-size counters. */
export interface OffenderSite {
  readonly path: string;
  readonly line?: number;
  readonly lines?: number;
}

/** The attributed sites behind every counter, keyed by counter —
 *  the structure guard's breach-report input. */
export type StructureOffenders = Readonly<
  Record<keyof StructureMetrics, readonly OffenderSite[]>
>;

/** The human-readable label for each counter, in print order. */
export const METRIC_LABELS: readonly (readonly [
  keyof StructureMetrics,
  string,
])[] = [
  ["filesOver800", "files >800 lines"],
  ["filesOver500", "files >500 lines"],
  ["filesOver350", "files >350 lines"],
  ["maxFileLines", "max file lines"],
  ["crossDomainEdges", "cross-domain edges (excl. cli)"],
  ["dataToSyncEdges", "data\u2192sync edges"],
  ["parseArgsCopies", "parseArgs copies"],
  ["directoryWalkers", "directory walkers"],
  ["repoRootDerivations", "repoRoot derivations"],
  ["unquoteDefinitions", "unquote definitions"],
  ["envSignatures", "env: signatures"],
  ["envSignatureFiles", "env: signature files"],
  ["dataRootEnvPairs", "(dataRoot, env) pairs"],
  ["dirnameRawDirDerivations", "dirname derivations of rawDir"],
];

/** Every counter key, in output order — the budget file's key set. */
export const counterKeys: readonly (keyof StructureMetrics)[] =
  METRIC_LABELS.map(([key]) => key);

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

/** The 1-based line of a character index in a text body. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The 1-based line of a regex match in its text body. */
export function matchLine(text: string, match: RegExpMatchArray): number {
  return lineOf(text, match.index ?? 0);
}

/** All relative import edges in the scanned files, in scan order. */
function relativeImports(files: readonly ScannedFile[]): ImportEdge[] {
  const edges: ImportEdge[] = [];

  for (const file of files) {
    for (const match of file.text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? "";

      if (specifier.startsWith(".")) {
        edges.push({
          importer: file,
          specifier,
          line: matchLine(file.text, match),
        });
      }
    }
  }

  return edges;
}

/** The root-relative import target of an edge, normalized. */
function importTarget(root: string, edge: ImportEdge): string {
  return relative(
    root,
    resolve(root, dirname(edge.importer.relPath), edge.specifier),
  )
    .split(sep)
    .join("/");
}

/** Sites of import edges crossing domain boundaries, `cli`-endpoint
 *  ones excluded (the shared layer everyone may use). */
function crossDomainSites(
  root: string,
  edges: readonly ImportEdge[],
): OffenderSite[] {
  const sites: OffenderSite[] = [];

  for (const edge of edges) {
    const target = importTarget(root, edge);
    const importerDomain = domainOf(edge.importer.relPath);
    const targetDomain = domainOf(target);

    if (
      !target.startsWith("..") &&
      importerDomain !== "cli" &&
      targetDomain !== "cli" &&
      importerDomain !== targetDomain
    ) {
      sites.push({ path: edge.importer.relPath, line: edge.line });
    }
  }

  return sites;
}

/** Sites of import edges from the data domain into the sync domain. */
function dataToSyncSites(
  root: string,
  edges: readonly ImportEdge[],
): OffenderSite[] {
  const sites: OffenderSite[] = [];

  for (const edge of edges) {
    const target = importTarget(root, edge);

    if (
      domainOf(edge.importer.relPath) === "data" &&
      domainOf(target) === "sync"
    ) {
      sites.push({ path: edge.importer.relPath, line: edge.line });
    }
  }

  return sites;
}

/** Attributed match sites of one global regex across all files. */
function matchSites(
  files: readonly ScannedFile[],
  pattern: RegExp,
): OffenderSite[] {
  const sites: OffenderSite[] = [];

  for (const file of files) {
    for (const match of file.text.matchAll(pattern)) {
      sites.push({
        path: file.relPath,
        line: matchLine(file.text, match),
      });
    }
  }

  return sites;
}

/** Every scanned file with its line count. */
function countedFiles(files: readonly ScannedFile[]): OffenderSite[] {
  return files.map((file) => ({
    path: file.relPath,
    lines: countLines(file.text),
  }));
}

/** Files over a size band, with their line counts. */
function sizeSites(
  counted: readonly OffenderSite[],
  band: number,
): OffenderSite[] {
  return counted.filter((site) => (site.lines ?? 0) > band);
}

/** One scanned signature: its parameter-list text and line. */
interface Signature {
  readonly file: string;
  readonly params: string;
  readonly line: number;
}

/** Every function or arrow-const signature in the scanned files. */
function scanSignatures(files: readonly ScannedFile[]): Signature[] {
  const signatures: Signature[] = [];

  for (const file of files) {
    for (const match of file.text.matchAll(SIGNATURE_PATTERN)) {
      signatures.push({
        file: file.relPath,
        params: match[1] ?? "",
        line: matchLine(file.text, match),
      });
    }
  }

  return signatures;
}

/** Signature sites whose parameter list matches a predicate. */
function signatureSites(
  signatures: readonly Signature[],
  matches: (params: string) => boolean,
): OffenderSite[] {
  return signatures
    .filter((signature) => matches(signature.params))
    .map((signature) => ({ path: signature.file, line: signature.line }));
}

/** True when a parameter list binds both `dataRoot` and `env`. */
function isDataRootEnvPair(params: string): boolean {
  return DATA_ROOT_PARAM.test(params) && ENV_PARAM.test(params);
}

/** One site per file holding at least one env-binding signature. */
function envSignatureFileSites(
  envSites: readonly OffenderSite[],
): OffenderSite[] {
  return [...new Map(envSites.map((site) => [site.path, site])).values()];
}

/** The counters derived from the attributed sites — every count is
 *  its sites' length; the max is the largest kept file's lines. */
export function metricsOfOffenders(
  offenders: StructureOffenders,
): StructureMetrics {
  return {
    filesOver800: offenders.filesOver800.length,
    filesOver500: offenders.filesOver500.length,
    filesOver350: offenders.filesOver350.length,
    maxFileLines: offenders.maxFileLines.reduce(
      (max, site) => Math.max(max, site.lines ?? 0),
      0,
    ),
    crossDomainEdges: offenders.crossDomainEdges.length,
    dataToSyncEdges: offenders.dataToSyncEdges.length,
    parseArgsCopies: offenders.parseArgsCopies.length,
    directoryWalkers: offenders.directoryWalkers.length,
    repoRootDerivations: offenders.repoRootDerivations.length,
    unquoteDefinitions: offenders.unquoteDefinitions.length,
    envSignatures: offenders.envSignatures.length,
    envSignatureFiles: offenders.envSignatureFiles.length,
    dataRootEnvPairs: offenders.dataRootEnvPairs.length,
    dirnameRawDirDerivations: offenders.dirnameRawDirDerivations.length,
  };
}

/** Scan `rootInput` recursively and attribute every counter's sites. */
export async function collectOffenders(
  rootInput: string,
): Promise<StructureOffenders> {
  const root = resolve(rootInput);
  const files = await listTsFiles(root);
  const counted = countedFiles(files);
  const edges = relativeImports(files);
  const signatures = scanSignatures(files);
  const envSites = signatureSites(signatures, (params) =>
    ENV_PARAM.test(params),
  );

  return {
    filesOver800: sizeSites(counted, 800),
    filesOver500: sizeSites(counted, 500),
    filesOver350: sizeSites(counted, 350),
    maxFileLines: counted,
    crossDomainEdges: crossDomainSites(root, edges),
    dataToSyncEdges: dataToSyncSites(root, edges),
    parseArgsCopies: matchSites(files, PARSE_ARGS_PATTERN),
    directoryWalkers: matchSites(files, WALKER_PATTERN),
    repoRootDerivations: matchSites(files, REPO_ROOT_PATTERN),
    unquoteDefinitions: matchSites(files, UNQUOTE_PATTERN),
    envSignatures: envSites,
    envSignatureFiles: envSignatureFileSites(envSites),
    dataRootEnvPairs: signatureSites(signatures, isDataRootEnvPair),
    dirnameRawDirDerivations: matchSites(files, DIRNAME_RAW_DIR_PATTERN),
  };
}

/** Scan `rootInput` recursively and compute every counter. */
export async function collectMetrics(
  rootInput: string,
): Promise<StructureMetrics> {
  return metricsOfOffenders(await collectOffenders(rootInput));
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
debt: lower is better, and the structure gate holds each counter
at or below its budget in .structureguard.json.

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
  data\u2192sync edges
                  Relative imports from the data domain into the
                  sync domain — a layering inversion. Zero is the
                  goal and the structure budget pins it there.
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
