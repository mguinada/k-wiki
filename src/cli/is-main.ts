import { pathToFileURL } from "node:url";

/**
 * True when the calling entry module is the script Node executed directly.
 * Pass the caller's own `import.meta.url`; the helper cannot see it itself.
 *
 * Inside a test worker (vitest, including Stryker mutation runs) the answer
 * is always false: `tests/setup.ts` sets the `__kWikiTestWorker__` globalThis
 * flag in every worker, so a mutated import guard can never run `main()` as
 * an import side effect with the CLI's live defaults (issue #123). A
 * `globalThis` flag is used instead of `process.env.VITEST_WORKER_ID`
 * because spawned CLI children inherit the worker's environment; a
 * process-local flag never leaks into them (issue #123).
 */
export function isMainModule(moduleUrl: string): boolean {
  if ((globalThis as { __kWikiTestWorker__?: boolean }).__kWikiTestWorker__) {
    return false;
  }

  return (
    process.argv[1] !== undefined &&
    moduleUrl === pathToFileURL(process.argv[1]).href
  );
}
