/**
 * The vitest setup every suite runs before its first test: macOS
 * notifications stay off for the whole test process (issue #362).
 * The scheduled wrapper and the sync-watchdog fire real osascript
 * notifications on ALERT paths, and in-process main() tests run real
 * failing cycles (temp dirs without a git origin) — without this
 * guard each one pops a notification on the dev's screen. Set here,
 * in the parent process, it also propagates into every spawned CLI
 * child through runCli's `...process.env` spread, so no suite —
 * current or future — needs to remember the guard itself.
 */

process.env.KWIKI_NOTIFY ??= "0";
