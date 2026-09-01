import { pathToFileURL } from "node:url";

/**
 * Direct-execution refusal for library modules (issue #135): `src/`
 * and `scripts/` modules never invoke `main()` at module scope — the
 * shebanged launchers are the only entry path (`bin/<name>.ts` for
 * the wiki runtime, `dev/<name>.ts` for development-lifecycle
 * commands, issue #253) — so no Stryker mutant can fire a CLI
 * `main()` as an import side effect with live defaults (issue #123's
 * hazard class, eliminated by construction; the
 * tests/bin/bin-structure.test.ts scan keeps it true).
 *
 * Executing a library module directly (`node src/sync/sync-vault.ts`)
 * prints the refusal naming its launcher and exits 1: the wrong path
 * stays loudly unusable, never silently live.
 */
export function refuseDirectExecution(
  moduleUrl: string,
  launcher: string,
  launcherDir = "bin",
): void {
  if (
    process.argv[1] !== undefined &&
    moduleUrl === pathToFileURL(process.argv[1]).href
  ) {
    console.error(`library module — run ${launcherDir}/${launcher}`);

    process.exit(1);
  }
}
