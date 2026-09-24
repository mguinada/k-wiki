/**
 * Shared coordinator/leased-cycle test world (issue #390): one bare
 * remote, two clones, and an enabled marker-bearing data repo on
 * writer-a with an empty vault — the no-op cycle under test. The
 * full agent-bearing cycle lives in the e2e suite.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContext } from "../../src/cli/run-context.ts";
import { vaultName } from "../../src/fixtures/generate.ts";
import { parseExclude, type SyncConfig } from "../../src/sync/config.ts";
import type { WriterWorld } from "./git-world.ts";

export const LEASE_REF = "refs/k-wiki/leases/shared-writer-v1";
export const NOW = () => new Date("2026-01-01T00:00:00Z");
export const HOLDER = "coord-host:7";

/** The coordinator options' static shape minus injectables. */
export interface CoordWorld {
  readonly dataRoot: string;
  readonly config: SyncConfig;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly scratch: string;
}

/** A data repo on writer-a of a fresh world: raw manifest, wiki,
 *  marker committed, empty vault configured. The caller owns the
 *  world's cleanup and the scratch dir's tracking. */
export async function enabledDataRepo(
  world: WriterWorld,
  track: (dir: string) => void,
): Promise<CoordWorld> {
  const scratch = await mkdtemp(join(tmpdir(), "coord-"));

  track(scratch);

  const dataRoot = world.a.dir;
  const vaultRoot = join(scratch, "vault");

  // An empty vault: sync selects nothing, the manifest stays as
  // committed, and the cycle's agent stages skip — the no-op path
  // under test. The full agent-bearing cycle lives in e2e.
  await mkdir(vaultRoot, { recursive: true });
  const vault = vaultName();
  const config = {
    vaults: [
      {
        kind: "vault" as const,
        name: vault,
        root: vaultRoot,
        exclude: parseExclude("wiki:false"),
      },
    ],
    publish: undefined,
    dataRoot,
    instances: undefined,
  };

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: { [vault]: {} } }, null, 2)}\n`,
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(
    join(dataRoot, ".gitignore"),
    "outputs/last-ingested-manifest.json\n",
  );
  await mkdir(join(dataRoot, ".k-wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, ".k-wiki", "shared-writer.json"),
    `${JSON.stringify(
      {
        version: 1,
        remote: "origin",
        branch: "main",
        leaseRef: LEASE_REF,
        sourceRemovalPolicy: "confirm",
      },
      null,
      2,
    )}\n`,
  );
  await world.a.git(["add", "-A"]);
  await world.a.git(["commit", "-m", "data repo skeleton + marker"]);
  await world.a.git([
    "push",
    "-q",
    "origin",
    "refs/heads/main:refs/heads/main",
  ]);

  const settingsPath = join(scratch, "settings.yml");

  await writeFile(
    settingsPath,
    "command: /usr/bin/true\nmodel: stub\nreasoning: low\n",
  );

  // The on-disk sync.json the CLI doors resolve (the vault root is
  // per-world scratch; dataRoot names the data repo).
  await writeFile(
    join(scratch, "sync.json"),
    `${JSON.stringify(
      {
        vaults: [
          {
            name: vault,
            root: vaultRoot,
            exclude: "wiki:false",
          },
        ],
        dataRoot,
      },
      null,
      2,
    )}\n`,
  );

  return {
    dataRoot,
    config,
    configPath: join(scratch, "sync.json"),
    settingsPath,
    scratch,
  };
}

/** The coordinator options for one clone with injectable overrides. */
export function optionsFor(
  cw: CoordWorld,
  dataRoot: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    run: runContext({
      rawDir: join(dataRoot, "raw"),
      env: process.env,
      now: NOW,
      onProgress: () => {},
    }),
    config: cw.config,
    configPath: cw.configPath,
    settingsPath: cw.settingsPath,
    outputsDir: join(cw.scratch, "outputs"),
    promptsDir: join(cw.scratch, "prompts"),
    holder: HOLDER,
    ...overrides,
  };
}
