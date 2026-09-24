/**
 * Data-repo resolution for the writer CLIs (issue #390): the same
 * <config>/<raw-dir> positional resolution wiki-sync uses — a raw-dir
 * positional wins (its parent is the data repo), else the config's
 * expanded dataRoot. Errors come back as values; the CLI shell
 * renders them (no printing as a resolver side effect).
 */

import { homedir } from "node:os";
import { dirname } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import { loadSyncConfig } from "../sync/config.ts";

/** The resolution outcome. */
export type DataRootResolution =
  | { readonly dataRoot: string; readonly error?: undefined }
  | { readonly dataRoot?: undefined; readonly error: string };

/** Resolve the data repo for `enable-shared-writer` and
 *  `writer-lease` from their positionals. */
export async function resolveDataRootFromArgs(
  configPath: string,
  rawDir: string | undefined,
): Promise<DataRootResolution> {
  if (rawDir !== undefined) {
    return { dataRoot: dirname(rawDir) };
  }

  try {
    const config = await loadSyncConfig(configPath, homedir());

    if (config.dataRoot === undefined) {
      return {
        error: `no dataRoot in ${configPath} — shared-writer mode needs a data repo`,
      };
    }

    return { dataRoot: config.dataRoot };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
