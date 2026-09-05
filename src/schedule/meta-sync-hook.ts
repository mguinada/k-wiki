/**
 * The meta wiki's post-merge auto-sync hook: the script content the
 * installer (setup-meta-sync.ts) bakes and writes as `post-merge`
 * and `post-rewrite`. The meta source (this repository) changes only
 * at merges — an event — so the trigger is a git hook, not an
 * interval: `post-merge` catches merges landing on the default
 * branch (fast-forward merges included), `post-rewrite` catches
 * rebase-based pulls that rewrite commits.
 *
 * The hook guards before firing — the wiki's source must be the
 * canonical checkout on the default branch with a clean
 * `git status --porcelain` (dirty and untracked included): the
 * cycle projects the canonical checkout's tree, so a merge in a
 * linked worktree would silently sync the wrong content;
 * anything else log-and-skips, and
 * `k-wiki health` keeps flagging the staleness. The fire is
 * detached (`nohup … &`): the merge returns instantly, and the
 * scheduled-run wrapper contributes its own per-dataRoot lockfile,
 * pull/push, and push-rejection retry. One log line per fire —
 * silent automation is untrustworthy automation.
 */
import { homedir } from "node:os";
import { join } from "node:path";


/** The hooks the installer owns: merges and rebase-based pulls. */
export const HOOK_NAMES = ["post-merge", "post-rewrite"] as const;

/** The branch whose merges re-sync the meta wiki: the default. */
export const DEFAULT_BRANCH = "main";

/** The meta instance's config files, read from the checkout root. */
export const META_SETTINGS = "settings-meta.yml";
export const META_CONFIG = "sync-meta.json";

/** Ownership marker: a hook carrying this line belongs to the
 *  installer (any generation); a hook without it is operator state
 *  and is never overwritten or removed. */
export const HOOK_MARKER = "managed by k-wiki bin/setup-meta-sync";

/** The baked hook configuration: every absolute path the generated
 *  script needs. */
export interface MetaHookConfig {
  readonly nodePath: string;
  readonly sourceRoot: string;
  readonly settingsPath: string;
  readonly configPath: string;
  readonly rawDir: string;
  readonly logPath: string;
  readonly branch: string;
}

/** The fire log: one line per fire — trigger, guard decision, or
 *  cycle outcome; the detached cycle's output lands here too. */
export function metaSyncLogPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "darwin"
    ? join(home, "Library", "Logs", "kwiki", "meta-sync.log")
    : join(home, ".local", "state", "k-wiki", "logs", "meta-sync.log");
}

/** Quote a path for the generated shell script — single quotes,
 *  embedded quotes escaped; baked paths may contain spaces. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The generated hook: guards, one detached cycle, one log line per
 *  fire. Identical for every hook name — the trigger is read from
 *  `$0` at fire time. */
export function metaSyncHookScript(config: MetaHookConfig): string {
  const { branch, configPath, logPath, nodePath, rawDir, settingsPath } =
    config;

  return `#!/bin/sh
# k-wiki meta post-merge auto-sync — one detached meta-wiki cycle per
# merge landing on ${branch} in the canonical checkout with a clean
# tree; log-and-skip otherwise.
# ${HOOK_MARKER}: re-run bin/setup-meta-sync to refresh, --uninstall to remove.

NODE=${shellQuote(nodePath)}
SRC=${shellQuote(config.sourceRoot)}
SETTINGS=${shellQuote(settingsPath)}
CONFIG=${shellQuote(configPath)}
RAW_DIR=${shellQuote(rawDir)}
LOG=${shellQuote(logPath)}
BRANCH=${shellQuote(branch)}

note() {
  mkdir -p "$(dirname "$LOG")"
  printf 'meta-sync %s [%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"
}

trigger=$(basename "$0")
toplevel=$(git rev-parse --show-toplevel 2>/dev/null || printf '')

if [ "$toplevel" != "$SRC" ]; then
  note "$trigger" "skip: fired in \${toplevel:-no git worktree}, not the canonical checkout $SRC"
  exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf unknown)

if [ "$branch" != "$BRANCH" ]; then
  note "$trigger" "skip: current branch is $branch, not $BRANCH"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  note "$trigger" "skip: working tree not clean (dirty or untracked files)"
  exit 0
fi

note "$trigger" "merge on $BRANCH, clean tree — firing detached meta cycle"
KWIKI_SCHEDULED_LOG="$LOG" nohup "$NODE" "$SRC/bin/scheduled-run" --settings "$SETTINGS" "$CONFIG" "$RAW_DIR" >> "$LOG" 2>&1 &
`;
}
