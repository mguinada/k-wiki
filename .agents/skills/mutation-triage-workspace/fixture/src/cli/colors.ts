import { createColors } from "picocolors";

/**
 * The shared CLI presentation kit (docs/references/colors.md): one
 * NO_COLOR policy point and one usage-error rule for every CLI.
 * Colors apply at the render boundary — the stderr sink or a
 * colorize* helper — never at the call site.
 */

/** Colors honoring NO_COLOR, like every CLI in this repo: colors on
 *  by default (piped included); NO_COLOR present and non-empty yields
 *  plain text. */
export function terminalColors(env: NodeJS.ProcessEnv = process.env) {
  return createColors(!env.NO_COLOR);
}

/** True when the stderr surface may animate: a TTY with color on. */
export function canAnimate(
  isTTY: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTTY && !env.NO_COLOR;
}

/** An unknown error's message: Error.message, else the string form. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print one CLI usage error red on stderr and set the exit code. */
export function cliFail(name: string, message: string): void {
  console.error(terminalColors().red(`${name}: ${message}`));

  process.exitCode = 1;
}
