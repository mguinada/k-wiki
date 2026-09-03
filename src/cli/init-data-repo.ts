import { join } from "node:path";
import { seedDataRepo } from "../data/init-data-repo.ts";
import { loadSyncConfig } from "../sync/config.ts";
import { cliFail, errorMessage } from "./colors.ts";
import { refuseDirectExecution } from "./is-main.ts";
import { repoRoot } from "./shared.ts";
import { parseArgs } from "./shell.ts";

/**
 * data:init CLI shell (RC1 split): argument parsing, help, and the
 * sync.json config read live here — cli→sync and cli→data are both
 * legal edges — while the seeding itself is the data/ library's
 * `seedDataRepo`, which takes the data root explicitly.
 */

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: init-data-repo [-h | --help] [--second-brain] [--meta] [<config>]

Create and seed the data repo at the config's dataRoot: git init, copy
the raw/ and wiki/ skeleton from the code repo, write the standing
.gitignore (Obsidian UI state and the ingest snapshot — gitignore
does not apply to tracked files, so the rules must precede the
files), first commit.
Idempotent — an already-seeded data repo is left untouched.

  --second-brain  Also write .second-brain, the operator-owned
                  second-brain identity marker, at the data root and
                  commit it with the seed. The marker — not the
                  agent-writable wiki/second-brain/profile.md — is
                  what the ingest guardrails read as second-brain
                  identity. Mark an already-seeded repo
                  by hand: create and commit .second-brain at its
                  root.
  --meta          Seed the meta contract as the data
                  repo's wiki/AGENTS.md instead of the canonical
                  wiki contract: the repo-as-source wiki that
                  documents k-wiki itself, describe-don't-prescribe.
  -h, --help      Print this help and exit; no side effects.
  <config>        Path to sync.json.
                  Default: the repo's own sync.json.`;

/** data:init entry point: `init-data-repo [-h | --help] [--second-brain] [--meta] [<config>]`. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    boolean: ["--second-brain", "--meta"],
    positionals: {
      max: 1,
      error: (_arg, count) =>
        `expected at most one <config> argument, got ${count}`,
    },
  });

  if (parsed.error !== undefined) {
    cliFail("data:init", parsed.error);

    return;
  }

  const secondBrain = parsed.flags.has("--second-brain");
  const meta = parsed.flags.has("--meta");
  const configPath = parsed.positional[0] ?? join(repoRoot, "sync.json");

  try {
    const config = await loadSyncConfig(configPath);

    if (config.dataRoot === undefined) {
      throw new Error(`no "dataRoot" in ${configPath}: nothing to seed`);
    }

    const result = await seedDataRepo({
      dataRoot: config.dataRoot,
      secondBrain,
      meta,
    });

    console.log(
      result === "seeded"
        ? `data:init: seeded ${config.dataRoot}`
        : `data:init: ${config.dataRoot} already seeded`,
    );
  } catch (error) {
    cliFail("data:init", errorMessage(error));
  }
}

/* v8 ignore next: covered only under direct `node src/cli/init-data-repo.ts` runs */
refuseDirectExecution(import.meta.url, "init-data-repo");
