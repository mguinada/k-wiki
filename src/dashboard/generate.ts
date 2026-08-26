import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { loadSyncConfig, resolveRawDir } from "../sync/config.ts";
import { collectData } from "./collect.ts";
import { computeKpis } from "./kpis.ts";
import { renderDashboard } from "./render.ts";

/**
 * dashboard (issue #73): a read-only KPI view over the data repo —
 * one self-contained HTML file, regenerated after every successful
 * ingest run and on demand (`npm run dashboard [-- <data-repo>]`).
 * Fully derived: no persisted state anywhere; the only write is the
 * output file itself.
 */

const OUTPUT_NAME = "dashboard.html";

export interface WriteDashboardOptions {
  /** Environment for git; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Clock for the generation stamp; defaults to the wall clock. */
  readonly now?: (() => Date) | undefined;
  /** Warning sink (the gitignore note); defaults to console.error. */
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * Generate and write `<dataRoot>/dashboard.html`. Reads only the
 * artifacts issue #73 lists; writes nothing but the output file. The
 * data repo's `.gitignore` is read, never written: when it lacks the
 * `dashboard.html` entry the caller gets one warning — the ingest
 * wrapper owns maintaining the entry (the issue #112 pattern).
 */
export async function writeDashboard(
  dataRoot: string,
  options: WriteDashboardOptions = {},
): Promise<string> {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.error(message));
  const generatedAt = now();
  const input = await collectData(dataRoot, {
    env: options.env,
    now: () => generatedAt,
  });
  const kpis = computeKpis(input);
  const html = renderDashboard(kpis, {
    generatedAt,
    head: input.head,
    dataRoot,
  });
  const outputPath = join(dataRoot, OUTPUT_NAME);

  await writeFile(`${outputPath}.tmp`, html, "utf8");
  await rename(`${outputPath}.tmp`, outputPath);

  const gitignore = await readFile(join(dataRoot, ".gitignore"), "utf8").catch(
    () => "",
  );

  if (
    !gitignore
      .split("\n")
      .some(
        (line) =>
          line.trim() === OUTPUT_NAME || line.trim() === `/${OUTPUT_NAME}`,
      )
  ) {
    warn(
      `dashboard: ${dataRoot}/.gitignore has no ${OUTPUT_NAME} entry — add it (the ingest run does) so a careless git add cannot commit the regenerated file`,
    );
  }

  return outputPath;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: dashboard [-h | --help] [<data-repo>]

Generate the static KPI dashboard (issue #73): one self-contained
HTML file — inline CSS and SVG, no external references — written to
<data-repo>/dashboard.html. Open it offline via file://; it carries
dark and light themes (initial theme follows the system preference,
the toggle overrides it) and a generation stamp with the data repo's
HEAD.

Read-only. The generator reads only existing artifacts: wiki/**
frontmatter, content, and [[wikilinks]]; raw/ note files and
manifest.json; outputs/last-ingested-manifest.json (the ingest
snapshot; its absence counts every raw note as un-ingested);
outputs/last-query.md (the query funnel appears only when it
exists); and the data repo's git log (run activity, wiki growth,
HEAD). It writes nothing but dashboard.html — the only caveat is a
warning when the data repo's .gitignore lacks a dashboard.html
entry (wiki-ingest adds the entry; a bare git add must never commit
the file).

Switches and arguments:
  -h, --help   Print this help and exit; no side effects.
  <data-repo>  The data repo root (the directory holding wiki/,
               raw/, and outputs/). Default: the sync.json dataRoot,
               resolved like every other pipeline CLI.

What it writes:
  - <data-repo>/dashboard.html — the dashboard, regenerated whole on
    every run (also refreshed automatically after every successful
    wiki-ingest run). Nothing else.`;

function colors() {
  return createColors(!process.env.NO_COLOR);
}

/** dashboard entry point: `dashboard [-h | --help] [<data-repo>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const unknown = args.find((arg) => arg.startsWith("-"));

  if (unknown !== undefined) {
    console.error(
      colors().red(`dashboard: unknown option ${JSON.stringify(unknown)}`),
    );
    process.exitCode = 1;

    return;
  }

  if (positional.length > 1) {
    console.error(
      colors().red(
        `dashboard: expected at most one <data-repo> argument, got ${positional.length}`,
      ),
    );
    process.exitCode = 1;

    return;
  }

  try {
    const config = await loadSyncConfig(join(repoRoot, "sync.json"), homedir());
    const dataRoot = resolve(
      positional[0] ?? dirname(resolveRawDir(config.dataRoot, repoRoot)),
    );

    const path = await writeDashboard(dataRoot, {
      warn: (message) => console.error(colors().yellow(message)),
    });

    console.log(colors().green(`dashboard: wrote ${path}`));
  } catch (error) {
    console.error(
      colors().red(
        `dashboard: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node src/dashboard/generate.ts` runs */
refuseDirectExecution(import.meta.url, "dashboard");
