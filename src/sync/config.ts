import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Loader for `sync.json`, the human-owned sync configuration at the
 * k-wiki root (guide §26): what to sync and where to publish. Sync state
 * lives in `raw/manifest.json` instead — this module reads configuration
 * only.
 */

/** An exclusion expression; only `<key>:false` is supported. */
export interface ExcludeExpression {
  readonly key: string;
  readonly value: string;
}

/** One source vault projected under `raw/notes/<name>/`. */
export interface SyncVaultConfig {
  readonly name: string;
  /** Vault root with `~` already expanded. */
  readonly root: string;
  readonly exclude: ExcludeExpression;
}

/** Parsed from `sync.json`; parsed but unused by sync-vault for now. */
export interface PublishConfig {
  /** Mirror root with `~` already expanded. */
  readonly mirror: string;
  readonly include: readonly string[];
}

export interface SyncConfig {
  readonly vaults: readonly SyncVaultConfig[];
  readonly publish: PublishConfig | undefined;
  /** Data repo root; `raw/` and `wiki/` contents are versioned there. */
  readonly dataRoot: string | undefined;
}

/** Expand a leading `~` or `~/` against home; leave every other path. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") {
    return home;
  }

  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }

  return path;
}

const EXCLUDE_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):false$/;

/** Parse an `exclude` value such as `wiki:false`. */
export function parseExclude(exclude: string): ExcludeExpression {
  const key = EXCLUDE_PATTERN.exec(exclude)?.[1];

  if (key === undefined) {
    throw new Error(
      `unsupported exclude expression ${JSON.stringify(exclude)}: only "<key>:false" is supported`,
    );
  }

  return { key, value: "false" };
}

/** Whether the value is a non-array, non-null object. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Names that would corrupt plain-object bookkeeping as keys. */
export const RESERVED_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function parseVaultName(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error('vault "name" must be a non-empty string');
  }

  const name = value as string;

  if (
    RESERVED_NAMES.has(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(
      `vault name must be a plain path segment: ${JSON.stringify(name)}`,
    );
  }

  return name;
}

function parseVaults(value: unknown, home: string): SyncVaultConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('"vaults" must be an array');
  }

  const vaults: SyncVaultConfig[] = [];
  const seen = new Set<string>();

  value.forEach((entry: unknown, index: number) => {
    if (!isPlainObject(entry)) {
      throw new Error(`vaults[${index}] must be an object`);
    }

    try {
      const name = parseVaultName(entry.name);

      if (seen.has(name)) {
        throw new Error(`duplicate vault name ${JSON.stringify(name)}`);
      }

      if (!isNonEmptyString(entry.root)) {
        throw new Error('"root" must be a non-empty string');
      }

      if (Object.hasOwn(entry, "select")) {
        throw new Error('"select" was replaced by "exclude"; remove "select"');
      }

      if (typeof entry.exclude !== "string") {
        throw new Error('"exclude" must be a string');
      }

      seen.add(name);
      vaults.push({
        name,
        root: expandHome(entry.root, home),
        exclude: parseExclude(entry.exclude),
      });
    } catch (cause) {
      throw new Error(`vaults[${index}]: ${(cause as Error).message}`, {
        cause,
      });
    }
  });

  return vaults;
}

function parsePublish(value: unknown, home: string): PublishConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error('"publish" must be an object');
  }

  if (!isNonEmptyString(value.mirror)) {
    throw new Error('publish "mirror" must be a non-empty string');
  }

  if (
    !Array.isArray(value.include) ||
    !value.include.every((item): item is string => typeof item === "string")
  ) {
    throw new Error('publish "include" must be an array of strings');
  }

  return {
    mirror: expandHome(value.mirror, home),
    include: value.include,
  };
}

/** Parse an optional top-level `dataRoot`; undefined when absent. */
function parseDataRoot(value: unknown, home: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isNonEmptyString(value)) {
    throw new Error('"dataRoot" must be a non-empty string');
  }

  return expandHome(value, home);
}

/**
 * Read and validate `sync.json`, expanding every `~` path against home.
 * Throw with the config path in the message when it cannot be read,
 * parsed, or validated.
 */
export async function loadSyncConfig(
  configPath: string,
  home: string = homedir(),
): Promise<SyncConfig> {
  let text: string;

  try {
    text = await readFile(configPath, "utf8");
  } catch (cause) {
    throw new Error(`cannot read sync config at ${configPath}`, { cause });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid sync config at ${configPath}: not valid JSON`, {
      cause,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `invalid sync config at ${configPath}: expected a JSON object`,
    );
  }

  try {
    return {
      vaults: parseVaults(parsed.vaults, home),
      publish: parsePublish(parsed.publish, home),
      dataRoot: parseDataRoot(parsed.dataRoot, home),
    };
  } catch (cause) {
    throw new Error(
      `invalid sync config at ${configPath}: ${(cause as Error).message}`,
      { cause },
    );
  }
}

/**
 * Resolve the default raw directory: `<dataRoot>/raw` when a data repo
 * is configured, otherwise the code repo's own `raw/` skeleton.
 */
export function resolveRawDir(dataRoot: string | undefined, repoRoot: string) {
  return join(dataRoot ?? repoRoot, "raw");
}
