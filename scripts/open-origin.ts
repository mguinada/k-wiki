import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { terminalColors as colors, errorMessage } from "../src/cli/colors.ts";
import { refuseDirectExecution } from "../src/cli/is-main.ts";
import { openerFor } from "../src/dashboard/generate.ts";
import { loadSyncConfig } from "../src/sync/config.ts";
import { listWikiPages, readPageFields } from "../src/wiki/pages.ts";

/**
 * Reader-side origin jump (issue #126, Part E): map a `type: source`
 * hub's `origin` to an `obsidian://open` URI and open the live vault
 * note — the deep-dive hop for hubs without a web `source:` URL, and
 * a comfort path for every hub. The vault segment of the origin is
 * resolved against `sync.json` (`--vault` overrides), nothing is
 * written to wiki data, and the URI is never stored (machine-bound
 * derived data; `raw/` is the provenance anchor by contract).
 */

/** The vault and in-vault file path of an `origin` projection path;
 *  throws when the origin is not `notes/<vault>/<rest>`. */
export function parseOrigin(origin: string): {
  readonly vault: string;
  readonly file: string;
} {
  const segments = origin.replace(/^raw\//, "").split("/");

  if (segments[0] !== "notes" || segments.length < 3) {
    throw new Error(
      `origin is not a vault path (raw/notes/<vault>/<rest>): ${origin}`,
    );
  }

  return { vault: segments[1] ?? "", file: segments.slice(2).join("/") };
}

/** The `obsidian://open` URI for one vault file. */
export function buildOriginUri(vault: string, file: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

/** The wiki page file a hub argument names: an exact wiki-relative
 *  path wins; otherwise the unique page whose stem matches; ambiguity
 *  and absence are errors — the script never guesses. */
async function resolveHubFile(wikiDir: string, hub: string): Promise<string> {
  const files = await listWikiPages(wikiDir);
  const byPath = files.find((file) => file === hub || file === `${hub}.md`);

  if (byPath !== undefined) {
    return byPath;
  }

  const byName = files.filter((file) => basename(file, ".md") === hub);

  if (byName.length === 1) {
    return byName[0] ?? "";
  }

  if (byName.length > 1) {
    throw new Error(
      `hub name ${JSON.stringify(hub)} is ambiguous: ${byName.map((file) => `wiki/${file}`).join(", ")}`,
    );
  }

  throw new Error(`no wiki page named ${JSON.stringify(hub)}`);
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: open-origin [-h | --help] [--print] [--config <path>] [--vault <name>] <hub>

The deep-dive hop for a source hub: read the hub's
origin (raw/notes/<vault>/<rest>), resolve <vault> against the
vaults named in the sync config, and open the live vault note via
its obsidian://open URI. Nothing is written to wiki data; the URI
is printed so it can be copied even when it opens.

  <hub>           Hub page name (file stem) or wiki-relative path
                  of a type: source page.
  --config <path> Sync config to read. Default: ./sync.json.
  --vault <name>  Vault name for the URI, overriding the one
                  resolved from the origin and the config.
  --print         Print the URI only; do not open it.
  -h, --help      Print this help and exit; no side effects.

Writes nothing. The URI goes to stdout (dimmed progress to stderr
while opening). A hub without origin, a non-source page, an
unresolvable hub name, a vault segment absent from the config, or
a missing config or wiki directory is an error — never guessed;
exit 1 with the cause. NO_COLOR disables color.`;

/** open-origin entry point: `open-origin [-h | --help] [--print] [--config <path>] [--vault <name>] <hub>`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const print = args.includes("--print");
  const KNOWN_FLAGS = new Set([
    "-h",
    "--help",
    "--print",
    "--config",
    "--vault",
  ]);
  const unknownFlag = args.find(
    (arg) => arg.startsWith("-") && !KNOWN_FLAGS.has(arg),
  );
  const valueFlag = (name: string): string | undefined => {
    const index = args.indexOf(name);

    return index === -1 ? undefined : args[index + 1];
  };
  const configFlag = valueFlag("--config");
  const vaultFlag = valueFlag("--vault");
  const consumed = new Set<number>(
    ["--config", "--vault"].flatMap((name) => {
      const index = args.indexOf(name);

      return index === -1 ? [] : [index, index + 1];
    }),
  );
  const positional = args.filter(
    (arg, index) =>
      !consumed.has(index) && arg !== "--print" && !arg.startsWith("--"),
  );

  if (
    unknownFlag !== undefined ||
    positional.length !== 1 ||
    configFlag === "" ||
    vaultFlag === ""
  ) {
    console.error(colors().red("open-origin: bad arguments (see --help)"));
    process.exitCode = 1;

    return;
  }

  const hub = positional[0] ?? "";

  try {
    const config = await loadSyncConfig(
      configFlag ?? join(process.cwd(), "sync.json"),
    );

    if (config.dataRoot === undefined) {
      throw new Error("sync config has no dataRoot — cannot find the wiki");
    }

    const wikiDir = join(config.dataRoot, "wiki");
    const file = await resolveHubFile(wikiDir, hub);
    const fields = await readPageFields(join(wikiDir, file));

    if (fields.type !== "source") {
      throw new Error(`wiki/${file} is not a type: source page`);
    }

    if (fields.origin === undefined) {
      throw new Error(`wiki/${file} has no origin — nothing to jump to`);
    }

    const parsed = parseOrigin(fields.origin);

    if (
      vaultFlag === undefined &&
      !config.vaults.some((source) => source.name === parsed.vault)
    ) {
      throw new Error(
        `vault "${parsed.vault}" (from origin ${fields.origin}) is not configured — pass --vault to override`,
      );
    }

    const uri = buildOriginUri(vaultFlag ?? parsed.vault, parsed.file);

    console.log(uri);

    if (!print) {
      const opener = openerFor(process.platform);

      console.error(colors().dim(`open-origin: opening ${uri}`));
      spawn(opener.command, [...opener.argsPrefix, uri], {
        stdio: "ignore",
        detached: true,
      }).unref();
    }
  } catch (error) {
    console.error(colors().red(`open-origin: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}

/* v8 ignore next: covered only under direct `node scripts/open-origin.ts` runs */
refuseDirectExecution(import.meta.url, "open-origin");
