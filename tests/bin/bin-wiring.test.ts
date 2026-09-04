import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Spawn-every-entry wiring (issue #135): the shebanged launchers —
 * `bin/<name>.ts` for the wiki runtime, `dev/<name>.ts` for
 * development-lifecycle commands (issue #253) — are the only entry
 * path, so each one must import the module it claims
 * (wrong-path/wrong-CLI launchers die here), and each library module
 * must refuse direct execution with the launcher hint and exit 1.
 * Runs against the repo tree next to this test — under Stryker that
 * is the sandbox, so launcher tails and help paths are tested against
 * the mutated sources. The in-process block additionally fires each
 * module's refusal tail inside the worker, where the active mutant
 * lives — the child-process spawns alone cannot kill tail mutants.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Entry {
  readonly launcher: string;
  readonly module: string;
  readonly usage: string;
  /** The launcher's class: runtime `bin/` (default) or dev `dev/`. */
  readonly dir?: "bin" | "dev";
}

const ENTRIES: readonly Entry[] = [
  {
    launcher: "backfill-origin.ts",
    module: "scripts/backfill-origin.ts",
    usage: "Usage: backfill-origin",
  },
  {
    launcher: "board-triage.ts",
    module: "src/board/board-triage.ts",
    usage: "Usage: board-triage",
    dir: "dev",
  },
  {
    launcher: "check-crosslinks.ts",
    module: "scripts/check-crosslinks.ts",
    usage: "Usage: check-crosslinks",
  },
  {
    launcher: "check-fidelity.ts",
    module: "scripts/check-fidelity.ts",
    usage: "Usage: check-fidelity",
  },
  {
    launcher: "check-links.ts",
    module: "scripts/check-links.ts",
    usage: "Usage: check-links",
  },
  {
    launcher: "check-provenance.ts",
    module: "scripts/check-provenance.ts",
    usage: "Usage: check-provenance",
  },
  {
    launcher: "check-raw.ts",
    module: "src/health/check-raw.ts",
    usage: "Usage: check-raw",
  },
  {
    launcher: "dashboard.ts",
    module: "src/dashboard/generate.ts",
    usage: "Usage: dashboard",
  },
  {
    launcher: "generate.ts",
    module: "src/fixtures/generate.ts",
    usage: "Usage: fixtures",
    dir: "dev",
  },
  {
    launcher: "init-data-repo.ts",
    module: "src/cli/init-data-repo.ts",
    usage: "Usage: init-data-repo",
  },
  {
    launcher: "k-wiki.ts",
    module: "src/cli/k-wiki.ts",
    usage: "Usage: k-wiki",
  },
  {
    launcher: "link-sources.ts",
    module: "scripts/link-sources.ts",
    usage: "Usage: link-sources",
  },
  {
    launcher: "mutation-chunk.ts",
    module: "src/quality/mutation-chunk.ts",
    usage: "Usage: mutation-chunk",
    dir: "dev",
  },
  {
    launcher: "mutation-merge.ts",
    module: "src/quality/mutation-merge.ts",
    usage: "Usage: mutation-merge",
    dir: "dev",
  },
  {
    launcher: "mutation-report.ts",
    module: "src/quality/mutation-report.ts",
    usage: "Usage: mutation-report",
    dir: "dev",
  },
  {
    launcher: "mutation-scope.ts",
    module: "src/quality/mutation-scope.ts",
    usage: "Usage: mutation-scope",
    dir: "dev",
  },
  {
    launcher: "mutation-survivors.ts",
    module: "src/quality/mutation-survivors.ts",
    usage: "Usage: mutation-survivors",
    dir: "dev",
  },
  {
    launcher: "open-origin.ts",
    module: "scripts/open-origin.ts",
    usage: "Usage: open-origin",
  },
  {
    launcher: "refactor-metrics.ts",
    module: "src/quality/refactor-metrics.ts",
    usage: "Usage: refactor-metrics",
    dir: "dev",
  },
  {
    launcher: "sync-repo.ts",
    module: "src/sync/sync-repo.ts",
    usage: "Usage: sync-repo",
  },
  {
    launcher: "sync-vault.ts",
    module: "src/sync/sync-vault.ts",
    usage: "Usage: sync-vault",
  },
  {
    launcher: "wiki-ingest.ts",
    module: "src/ingest/wiki-ingest-cli.ts",
    usage: "Usage: wiki-ingest",
  },
  {
    launcher: "wiki-query.ts",
    module: "src/query/wiki-query.ts",
    usage: "Usage: wiki-query",
  },
  {
    launcher: "wiki-sync.ts",
    module: "src/sync/wiki-sync.ts",
    usage: "Usage: wiki-sync",
  },
];

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(args: readonly string[]): Promise<RunResult> {
  // argv[1] must be the real path: import.meta.url is realpath'd by
  // Node, and a symlinked spawn path would make the direct-execution
  // refusal compare unequal and stay silent.
  const first = args[0] ?? "";

  const realArgs = first.startsWith("-")
    ? args
    : [realpathSync(first), ...args.slice(1)];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, realArgs, {
      stdio: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("launcher wiring (issue #135)", () => {
  for (const entry of ENTRIES) {
    const dir = entry.dir ?? "bin";

    it(`${dir}/${entry.launcher} --help prints its own usage and exits 0`, async () => {
      const result = await runNode([
        join(repoRoot, dir, entry.launcher),
        "--help",
      ]);

      expect(`${result.code}|${result.out.startsWith(entry.usage)}`).toBe(
        "0|true",
      );
    });
  }
});

describe("library modules refuse direct execution (issue #135)", () => {
  for (const entry of ENTRIES) {
    const dir = entry.dir ?? "bin";

    it(`${entry.module} prints the launcher hint and exits 1`, async () => {
      const result = await runNode([join(repoRoot, entry.module)]);
      const stem = entry.launcher.replace(/\.ts$/, "");

      expect(`${result.code}|${result.err.trimEnd()}`).toBe(
        `1|library module — run ${dir}/${stem}`,
      );
    });
  }
});

const stagingRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  ".bin-wiring-staging",
);

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

/** A staged copy of src/, scripts/, and bin/ with node_modules linked. */
async function stageRepo(): Promise<string> {
  const dir = join(stagingRoot, randomUUID());
  const testsDir = dirname(fileURLToPath(import.meta.url));

  await mkdir(join(dir, "raw"), { recursive: true });
  await cp(join(testsDir, "../../src"), join(dir, "src"), { recursive: true });
  await cp(join(testsDir, "../../scripts"), join(dir, "scripts"), {
    recursive: true,
  });
  await cp(join(testsDir, "../../bin"), join(dir, "bin"), { recursive: true });
  await symlink(
    join(testsDir, "../../node_modules"),
    join(dir, "node_modules"),
  );

  return dir;
}

describe("library modules refuse in-process direct imports (issue #135)", () => {
  for (const entry of ENTRIES) {
    const dir = entry.dir ?? "bin";

    it(`importing ${entry.module} with argv[1] at itself prints the hint and exits 1`, async () => {
      const repo = await stageRepo();
      const modulePath = join(repo, entry.module);
      const argv = process.argv;
      const err: string[] = [];
      const stem = entry.launcher.replace(/\.ts$/, "");

      process.argv = [argv[0] ?? "node", modulePath];

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);

      // Capture before the finally restores the spies: mockRestore
      // clears the call history.
      let exitArg: unknown;

      try {
        await import(pathToFileURL(modulePath).href);

        exitArg = exitSpy.mock.calls[0]?.[0];
      } finally {
        process.argv = argv;
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }

      expect(`${exitArg}|${err[0]}`).toBe(
        `1|library module — run ${dir}/${stem}`,
      );
    });
  }
});
