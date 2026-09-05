/**
 * The Stryker sandbox detector (issue #276), shared by the quality
 * guards that scan the real `src/` tree: Stryker's dry run executes
 * against an instrumented copy, not the real tree, so tree-shape
 * assertions must skip (`ctx.skip`) inside it.
 */
export function insideStrykerSandbox(): boolean {
  return (
    import.meta.url.includes(".stryker-tmp") || "__stryker__" in globalThis
  );
}
