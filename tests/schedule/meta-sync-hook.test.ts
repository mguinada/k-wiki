import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRANCH,
  HOOK_MARKER,
  metaSyncHookScript,
  metaSyncLogPath,
} from "../../src/schedule/meta-sync-hook.ts";

/**
 * The generated meta-sync hook: guard lines, fire line, quoting,
 * marker, and the log-path rule. The hook's runtime behavior (real
 * merges firing the stubbed cycle) is the e2e lane
 * (tests/e2e/meta-sync-hook.e2e.test.ts); the installer lifecycle is
 * tests/schedule/setup-meta-sync.test.ts.
 */

const HOOK_CONFIG = {
  nodePath: "/opt/homebrew/bin/node",
  sourceRoot: "/Users/op/Lab/k-wiki",
  settingsPath: "/Users/op/Lab/k-wiki/settings-meta.yml",
  configPath: "/Users/op/Lab/k-wiki/sync-meta.json",
  rawDir: "/Users/op/Lab/k-wiki-meta-data/raw",
  logPath: "/Users/op/Library/Logs/kwiki/meta-sync.log",
  branch: DEFAULT_BRANCH,
};

describe("metaSyncHookScript", () => {
  it("guards on the default branch before firing", () => {
    const script = metaSyncHookScript(HOOK_CONFIG);

    expect([
      script.includes(`BRANCH='${DEFAULT_BRANCH}'`),
      script.includes(
        "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf unknown)",
      ),
      script.includes('[ "$branch" != "$BRANCH" ]'),
    ]).toEqual([true, true, true]);
  });

  it("guards on a fully clean porcelain status", () => {
    expect(metaSyncHookScript(HOOK_CONFIG)).toContain(
      'if [ -n "$(git status --porcelain)" ]; then',
    );
  });

  it("fires the detached cycle with the baked log and paths", () => {
    const fire = metaSyncHookScript(HOOK_CONFIG)
      .split("\n")
      .find((line) => line.startsWith("KWIKI_SCHEDULED_LOG="));

    expect(fire).toBe(
      `KWIKI_SCHEDULED_LOG="$LOG" nohup "$NODE" "$SRC/bin/scheduled-run" --settings "$SETTINGS" "$CONFIG" "$RAW_DIR" >> "$LOG" 2>&1 &`,
    );
  });

  it("bakes every absolute path as a quoted shell assignment", () => {
    const script = metaSyncHookScript(HOOK_CONFIG);

    expect(script).toContain(
      `NODE='${HOOK_CONFIG.nodePath}'\n` +
        `SRC='${HOOK_CONFIG.sourceRoot}'\n` +
        `SETTINGS='${HOOK_CONFIG.settingsPath}'\n` +
        `CONFIG='${HOOK_CONFIG.configPath}'\n` +
        `RAW_DIR='${HOOK_CONFIG.rawDir}'\n` +
        `LOG='${HOOK_CONFIG.logPath}'\n` +
        `BRANCH='${HOOK_CONFIG.branch}'`,
    );
  });

  it("shell-quotes a path containing a single quote", () => {
    expect(
      metaSyncHookScript({
        ...HOOK_CONFIG,
        sourceRoot: "/Users/o'brien/k-wiki",
      }),
    ).toContain("SRC='/Users/o'\\''brien/k-wiki'");
  });

  it("carries the ownership marker behind a POSIX shebang", () => {
    const script = metaSyncHookScript(HOOK_CONFIG);

    expect([
      script.startsWith("#!/bin/sh\n"),
      script.includes(HOOK_MARKER),
    ]).toEqual([true, true]);
  });

  it("logs every guard decision through the note helper", () => {
    const script = metaSyncHookScript(HOOK_CONFIG);

    expect([
      script.includes('mkdir -p "$(dirname "$LOG")"'),
      script.includes(
        'printf \'meta-sync %s [%s] %s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"',
      ),
      script.includes(
        'note "$trigger" "skip: current branch is $branch, not $BRANCH"',
      ),
      script.includes(
        'note "$trigger" "skip: working tree not clean (dirty or untracked files)"',
      ),
      script.includes('note "$trigger" "merge on $BRANCH, clean tree'),
    ]).toEqual([true, true, true, true, true]);
  });
});

describe("metaSyncLogPath", () => {
  it("uses ~/Library/Logs/kwiki on darwin", () => {
    expect(metaSyncLogPath("/Users/op", "darwin")).toBe(
      "/Users/op/Library/Logs/kwiki/meta-sync.log",
    );
  });

  it("uses the XDG state dir elsewhere", () => {
    expect(metaSyncLogPath("/home/op", "linux")).toBe(
      "/home/op/.local/state/k-wiki/logs/meta-sync.log",
    );
  });
});
