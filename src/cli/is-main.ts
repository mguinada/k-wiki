import { pathToFileURL } from "node:url";

/**
 * True when the calling entry module is the script Node executed directly.
 * Pass the caller's own `import.meta.url`; the helper cannot see it itself.
 */
export function isMainModule(moduleUrl: string): boolean {
  return (
    process.argv[1] !== undefined &&
    moduleUrl === pathToFileURL(process.argv[1]).href
  );
}
