import { execFile as execFileCb } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cliFail,
  terminalColors as colors,
  errorMessage,
} from "../cli/colors.ts";
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

const execFile = promisify(execFileCb);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: dashboard [-h | --help] [-o | --open] [<data-repo>]

Generate the static KPI dashboard: one self-contained
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
  -o, --open    Open the generated file in the default browser
                (macOS \`open\`, Linux \`xdg-open\`, Windows
                \`start\`) after writing it; an opener failure prints
                an error and exits 1 — the file is still written.
  -h, --help   Print this help and exit; no side effects.
  <data-repo>  The data repo root (the directory holding wiki/,
               raw/, and outputs/). Default: the sync.json dataRoot,
               resolved like every other pipeline CLI.

What it writes:
  - <data-repo>/dashboard.html — the dashboard, regenerated whole on
    every run (also refreshed automatically after every successful
    wiki-ingest run). Nothing else.`;

/** How to invoke the platform's default-app opener. */
export interface OpenerSpec {
  readonly command: string;
  /** Fixed leading argv entries before the file path. */
  readonly argsPrefix: readonly string[];
}

/** The browser opener per platform: macOS `open`; Windows routed
 *  through `cmd /c start ""` (the empty title argument stops `start`
 *  from swallowing a quoted path as the window title); everything
 *  else gets `xdg-open`, the freedesktop default-handler standard. */
export function openerFor(platform: NodeJS.Platform): OpenerSpec {
  if (platform === "darwin") {
    return { command: "open", argsPrefix: [] };
  }

  if (platform === "win32") {
    return { command: "cmd", argsPrefix: ["/c", "start", ""] };
  }

  return { command: "xdg-open", argsPrefix: [] };
}

/** Open the generated dashboard in the default browser. */
function openInBrowser(path: string): Promise<void> {
  const opener = openerFor(process.platform);

  return execFile(opener.command, [...opener.argsPrefix, path]).then(() => {});
}

/** Parsed CLI arguments: the open flag, positionals, first unknown
 *  option (undefined when every option is recognized). */
function parseArgs(args: readonly string[]): {
  wantsOpen: boolean;
  positional: string[];
  unknown: string | undefined;
} {
  const wantsOpen = args.includes("-o") || args.includes("--open");
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const unknown = args.find(
    (arg) => arg.startsWith("-") && arg !== "-o" && arg !== "--open",
  );

  return { wantsOpen, positional, unknown };
}

/** One red `dashboard: …` error line, plus exit code 1. */
function fail(message: string): void {
  cliFail("dashboard", message);
}

/** Open the written dashboard; an opener failure prints an error and
 *  sets exit code 1 — the file is still written. */
async function openWrittenDashboard(path: string): Promise<void> {
  try {
    await openInBrowser(path);
  } catch (error) {
    fail(`wrote ${path} but could not open it: ${errorMessage(error)}`);
  }
}

/** dashboard entry point: `dashboard [-h | --help] [-o | --open] [<data-repo>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const { wantsOpen, positional, unknown } = parseArgs(args);

  if (unknown !== undefined) {
    fail(`unknown option ${JSON.stringify(unknown)}`);

    return;
  }

  if (positional.length > 1) {
    fail(`expected at most one <data-repo> argument, got ${positional.length}`);

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

    if (wantsOpen) {
      await openWrittenDashboard(path);
    }
  } catch (error) {
    fail(errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/dashboard/generate.ts` runs */
refuseDirectExecution(import.meta.url, "dashboard");
