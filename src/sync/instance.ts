import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { statIfExists } from "../cli/shared.ts";
import {
  expandHome,
  isWikiName,
  loadSyncConfig,
  resolveRawDir,
  type SyncConfig,
} from "./config.ts";

/**
 * The shared wiki-instance resolver (issue #306): one chain for both
 * doors — the `--wiki <name>` flag (wiki-query, wiki-ingest) and the
 * binding's `wiki` key (k-wiki). A name resolves through the
 * checkout's root `sync.json`: an `instances` alias first (explicit
 * human intent beats convention), then a free stem
 * (`sync-<name>.json` in the checkout root), else an error listing
 * every known name. Every derived path keys off the resolved config
 * file — never the typed name — so an alias to `sync-engineering.json`
 * derives `outputs-engineering/`, not `outputs-eng/`.
 */

/** One resolved instance: which config a name (or the default)
 *  resolved to, plus the paths derived from it. */
export interface WikiInstance {
  /** The name the caller passed, when one was (undefined = default). */
  readonly name: string | undefined;
  /** Absolute path of the resolved sync config. */
  readonly configPath: string;
  /** The instance stem: "meta" for sync-meta.json, undefined for the
   *  default instance. Drives outputs/settings derivation. */
  readonly stem: string | undefined;
  /** Run-outputs dir: `outputs/` or `outputs-<stem>/` in the checkout. */
  readonly outputsDir: string;
  /** Agent settings: `settings-<stem>.yml` when the sibling exists,
   *  else `settings.yml`. */
  readonly settingsPath: string;
  /** The raw dir from the resolved config's `dataRoot` — a config
   *  fact, never derived from the name. */
  readonly rawDir: string;
  /** The parsed sync config at `configPath`. */
  readonly config: SyncConfig;
}

/** The stem a sync config's basename derives (issue #306): undefined
 *  for `sync.json` (the default instance), the `sync-` prefix's
 *  remainder for `sync-<x>.json`, and the plain base for any other
 *  basename — so nested or `~`-ful alias targets derive from the
 *  file they name, not the alias. */
export function syncConfigStem(configPath: string): string | undefined {
  const base = basename(configPath).replace(/\.json$/, "");

  if (base === "sync") {
    return undefined;
  }

  const stem = base.startsWith("sync-") ? base.slice("sync-".length) : base;

  if (stem === "") {
    throw new Error(
      `cannot derive an instance stem from ${JSON.stringify(configPath)}: the sync- prefix needs a name`,
    );
  }

  return stem;
}

/** The `--wiki` flag's usage error, undefined when the flag is
 *  absent or its value is valid: the value is required and must be
 *  a simple name — path separators, dots, and empty values are
 *  rejected at parse (issue #306, edge 6). Shared by wiki-query and
 *  wiki-ingest. */
export function wikiArgError(
  values: ReadonlyMap<string, string | undefined>,
): string | undefined {
  if (!values.has("--wiki")) {
    return undefined;
  }

  const wiki = values.get("--wiki");

  if (wiki === undefined) {
    return "--wiki needs a name value";
  }

  if (!isWikiName(wiki)) {
    return `--wiki must be a wiki name: letters, digits, "-" and "_" only (got ${JSON.stringify(wiki)})`;
  }

  return undefined;
}

/** What resolveWikiInstance takes: the checkout whose `sync.json`
 *  roots the resolution (names are a checkout-level concern), the
 *  name when one was given, and home for `~` expansion. */
export interface ResolveWikiInstanceInput {
  readonly checkout: string;
  readonly name: string | undefined;
  readonly home: string;
  /** Where the name came from (e.g. ".k-wiki.json"), quoted in miss
   *  errors so a failing binding names its source. */
  readonly nameSource?: string | undefined;
}

/** The alias target as an absolute path inside the checkout:
 *  `~` expanded, relative targets joined at the checkout root. */
function aliasTargetPath(
  checkout: string,
  target: string,
  home: string,
): string {
  const expanded = expandHome(target, home);
  const path = resolve(
    isAbsolute(expanded) ? expanded : join(checkout, expanded),
  );

  if (
    path !== resolve(checkout) &&
    !path.startsWith(`${resolve(checkout)}${sep}`)
  ) {
    throw new Error(
      `alias target ${JSON.stringify(target)} resolves outside the checkout ${checkout}`,
    );
  }

  return path;
}

/** The alias hit's config path: resolved inside the checkout and
 *  existing on disk — a missing target fails naming alias and path. */
async function aliasConfigPath(
  checkout: string,
  name: string,
  target: string,
  home: string,
): Promise<string> {
  const path = aliasTargetPath(checkout, target, home);

  if ((await statIfExists(path))?.isFile() !== true) {
    throw new Error(
      `alias "${name}" → ${JSON.stringify(target)}: no sync config at ${path}`,
    );
  }

  return path;
}

/** Every stem discoverable in the checkout root: `sync-*.json`
 *  regular files, non-recursive, alphabetical. */
async function stemNames(checkout: string): Promise<string[]> {
  const entries = await readdir(checkout, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && /^sync-.+\.json$/.test(entry.name))
    .map((entry) => entry.name.slice("sync-".length, -".json".length))
    .sort();
}

/** The miss listing: aliases with their targets (the root config's
 *  order, alphabetical), then the discovered stems. */
async function unknownNameMessage(
  checkout: string,
  name: string,
  config: SyncConfig,
  nameSource: string | undefined,
): Promise<string> {
  const from = nameSource === undefined ? "" : ` (from ${nameSource})`;
  const aliases = Object.entries(config.instances ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, target]) => `${alias} → ${target}`);
  const stems = await stemNames(checkout);
  const known = [...aliases, ...stems];

  if (known.length === 0) {
    return `unknown wiki name ${JSON.stringify(name)}${from}; no other wiki names are known — pass no --wiki flag to select the default instance`;
  }

  return `unknown wiki name ${JSON.stringify(name)}${from}; known names: ${known.join(", ")} (no --wiki flag selects the default instance)`;
}

/** The config path a name resolves to: alias (explicit human intent)
 *  beats stem; the miss is the listing. */
async function namedConfigPath(
  input: ResolveWikiInstanceInput,
  config: SyncConfig,
): Promise<string> {
  const { checkout, name } = input;

  if (name === undefined || !isWikiName(name)) {
    throw new Error(
      `invalid wiki name ${JSON.stringify(name)}: names must be letters, digits, "-" and "_"`,
    );
  }

  const instances = config.instances;
  const alias =
    instances !== undefined && Object.hasOwn(instances, name)
      ? instances[name]
      : undefined;

  if (alias !== undefined) {
    return aliasConfigPath(checkout, name, alias, input.home);
  }

  const candidate = join(checkout, `sync-${name}.json`);

  if ((await statIfExists(candidate))?.isFile() === true) {
    return candidate;
  }

  throw new Error(
    await unknownNameMessage(checkout, name, config, input.nameSource),
  );
}

/** The derived settings file: the `settings-<stem>.yml` sibling when
 *  it exists, else `settings.yml`. */
async function derivedSettings(
  checkout: string,
  stem: string | undefined,
): Promise<string> {
  if (stem === undefined) {
    return join(checkout, "settings.yml");
  }

  const sibling = join(checkout, `settings-${stem}.yml`);

  return (await statIfExists(sibling))?.isFile() === true
    ? sibling
    : join(checkout, "settings.yml");
}

/**
 * Resolve one wiki instance: load the checkout's `sync.json`, resolve
 * the name through it when one was given (alias > stem > listing
 * error), then derive every path from the resolved config file.
 */
export async function resolveWikiInstance(
  input: ResolveWikiInstanceInput,
): Promise<WikiInstance> {
  const rootConfigPath = join(input.checkout, "sync.json");
  const rootConfig = await loadSyncConfig(rootConfigPath, input.home);
  const configPath =
    input.name === undefined
      ? rootConfigPath
      : await namedConfigPath(input, rootConfig);
  const config =
    configPath === rootConfigPath
      ? rootConfig
      : await loadSyncConfig(configPath, input.home);

  const stem = syncConfigStem(configPath);

  return {
    name: input.name,
    configPath,
    stem,
    outputsDir:
      stem === undefined
        ? join(input.checkout, "outputs")
        : join(input.checkout, `outputs-${stem}`),
    settingsPath: await derivedSettings(input.checkout, stem),
    rawDir: resolveRawDir(config.dataRoot, input.checkout),
    config,
  };
}
