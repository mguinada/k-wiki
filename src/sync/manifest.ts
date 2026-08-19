import { rename, writeFile } from "node:fs/promises";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse manifest text. Throw with the origin path in the message when the
 * text is not valid JSON or not the multi-vault manifest shape.
 */
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
    if (!isPlainObject(notes)) {
      throw new Error(
        `invalid manifest at ${origin}: vault ${JSON.stringify(vaultName)} must map note paths to entries`,
      );
    }

    const vault: VaultNotes = {};

    for (const [relPath, entry] of Object.entries(notes)) {
      if (
        !isPlainObject(entry) ||
        typeof entry.hash !== "string" ||
        typeof entry.last_synced !== "string"
      ) {
        throw new Error(
          `invalid manifest at ${origin}: entry ${JSON.stringify(relPath)} needs string "hash" and "last_synced"`,
        );
      }

      vault[relPath] = { hash: entry.hash, last_synced: entry.last_synced };
    }

    vaults[vaultName] = vault;
  }

  return { vaults };
}

/** Canonical text: sorted keys, two-space indent, trailing newline. */
export function serializeManifest(manifest: Manifest): string {
  const sorted: Record<string, VaultNotes> = {};

  for (const [vaultName, vault] of sortedEntries(manifest.vaults)) {
    const notes: VaultNotes = {};

    for (const [relPath, entry] of sortedEntries(vault)) {
      notes[relPath] = entry;
    }

    sorted[vaultName] = notes;
  }

  return `${JSON.stringify({ vaults: sorted }, null, 2)}\n`;
}

/** A record's entries sorted by key, in default string order. */
function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/** Write the manifest in canonical form. */
export async function writeManifest(
  path: string,
  manifest: Manifest,
): Promise<void> {
  const tempPath = `${path}.tmp`;

  await writeFile(tempPath, serializeManifest(manifest), "utf8");
  await rename(tempPath, path);
}
