import { readFile, rename, writeFile } from "node:fs/promises";
import { isPlainObject, RESERVED_NAMES } from "./config.ts";

/**
 * Sync state (guide §8, §25 Scenario A): `raw/manifest.json` records, per
 * vault namespace, the SHA-256 hash and last sync time of every projected
 * note. Configuration lives in `sync.json`; this file is state only.
 */

export interface ManifestEntry {
  readonly hash: string;
  readonly last_synced: string;
}

/** Relative note path → entry, for one vault namespace. */
export type VaultNotes = Record<string, ManifestEntry>;

export interface Manifest {
  readonly vaults: Record<string, VaultNotes>;
}

export function emptyManifest(): Manifest {
  return { vaults: {} };
}

/** Read the manifest file's text if it exists; undefined when it does not. */
export async function readManifestText(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/** Validate and copy one vault namespace's note map. */
function parseVaultNotes(
  vaultName: string,
  notes: unknown,
  origin: string,
): VaultNotes {
  if (!isPlainObject(notes)) {
    throw new Error(
      `invalid manifest at ${origin}: vault ${JSON.stringify(vaultName)} must map note paths to entries`,
    );
  }

  const vault: VaultNotes = {};

  for (const [relPath, entry] of Object.entries(notes)) {
    vault[relPath] = parseEntry(vaultName, relPath, entry, origin);
  }

  return vault;
}

/** Validate and copy one manifest entry. */
function parseEntry(
  vaultName: string,
  relPath: string,
  entry: unknown,
  origin: string,
): ManifestEntry {
  if (RESERVED_NAMES.has(relPath)) {
    throw new Error(
      `invalid manifest at ${origin}: vault ${JSON.stringify(vaultName)} has reserved note path ${JSON.stringify(relPath)}`,
    );
  }

  if (
    !isPlainObject(entry) ||
    typeof entry.hash !== "string" ||
    typeof entry.last_synced !== "string"
  ) {
    throw new Error(
      `invalid manifest at ${origin}: entry ${JSON.stringify(relPath)} needs string "hash" and "last_synced"`,
    );
  }

  return { hash: entry.hash, last_synced: entry.last_synced };
}

/** Parse manifest text, throwing with the origin path in the
 *  message on invalid JSON or shape. */
export function parseManifest(text: string, origin: string): Manifest {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid manifest at ${origin}: not valid JSON`, {
      cause,
    });
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.vaults)) {
    throw new Error(
      `invalid manifest at ${origin}: expected an object with a "vaults" object`,
    );
  }

  const vaults: Record<string, VaultNotes> = {};

  for (const [vaultName, notes] of Object.entries(parsed.vaults)) {
    if (RESERVED_NAMES.has(vaultName)) {
      throw new Error(
        `invalid manifest at ${origin}: reserved vault name ${JSON.stringify(vaultName)}`,
      );
    }

    vaults[vaultName] = parseVaultNotes(vaultName, notes, origin);
  }

  return { vaults };
}

/**
 * Canonical text: sorted keys, two-space indent, trailing newline.
 * `extra` adds top-level string fields beside `vaults` (the ingest
 * snapshot's instance stamp, issue #95); the raw manifest omits it.
 */
export function serializeManifest(
  manifest: Manifest,
  extra?: Record<string, string>,
): string {
  const sorted: Record<string, VaultNotes> = {};

  for (const [vaultName, vault] of sortedEntries(manifest.vaults)) {
    const notes: VaultNotes = {};

    for (const [relPath, entry] of sortedEntries(vault)) {
      notes[relPath] = entry;
    }

    sorted[vaultName] = notes;
  }

  return `${JSON.stringify({ ...extra, vaults: sorted }, null, 2)}\n`;
}

/** A record's entries sorted by key, in default string order. */
function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/** Write the manifest in canonical form, with optional `extra` fields. */
export async function writeManifest(
  path: string,
  manifest: Manifest,
  extra?: Record<string, string>,
): Promise<void> {
  const tempPath = `${path}.tmp`;

  await writeFile(tempPath, serializeManifest(manifest, extra), "utf8");
  await rename(tempPath, path);
}
