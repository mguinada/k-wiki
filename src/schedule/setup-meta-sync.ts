/**
 * setup-meta-sync: install the meta wiki's post-merge auto-sync git
 * hooks (content in meta-sync-hook.ts) into the checkout's shared
 * hooks dir — `git rev-parse --git-path hooks`, correct for the
 * canonical checkout and its linked worktrees — baking absolute
 * paths resolved at install time. Hooks are unversioned
 * per-machine state by nature: install runs once per machine.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { readTextIfExists } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";
import {
  DEFAULT_BRANCH,
  HOOK_MARKER,
  HOOK_NAMES,
  META_CONFIG,
  META_SETTINGS,
  type MetaHookConfig,
  metaSyncHookScript,
  metaSyncLogPath,
} from "./meta-sync-hook.ts";
import { resolveDataRoot } from "./scheduled-run.ts";
import { stableNodePath } from "./setup-schedule.ts";


/** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: setup-meta-sync [-h | --help] [--print] [--uninstall]

Install the meta wiki's post-merge auto-sync git hooks into the
current checkout's shared hooks dir (git rev-parse --git-path hooks
— also served to the checkout's linked worktrees). A merge or
rebase-pull landing on the default branch (${DEFAULT_BRANCH}) with a
clean tree fires one detached meta cycle: bin/scheduled-run
--settings ${META_SETTINGS} ${META_CONFIG} <dataRoot>/raw, logged and
locked per data repo. Install runs once per machine — hooks are
unversioned git state — and the meta data repo needs a private
origin remote for two-machine convergence.

  --print       Print the hook script (with the paths this checkout
                would bake) without installing anything — needs no
                git repo, works on every OS.
  --uninstall   Remove exactly the hooks this installer wrote
                (post-merge, post-rewrite); a hook without the
                installer's marker is never touched.
  -h, --help    Print this help and exit; no side effects.

Install resolves the canonical checkout (the parent of the shared
git dir — not a linked worktree), reads ${META_CONFIG} there for the
data repo root, and writes both hooks (mode 0755, idempotent: an
identical hook is left alone, an older generation of ours is
replaced, a foreign hook is refused loud and untouched). The fire
log is ~/Library/Logs/kwiki/meta-sync.log on macOS,
~/.local/state/k-wiki/logs/ elsewhere; the hook skips (logged)
whenever the firing worktree is not the canonical checkout, the
tree is not on ${DEFAULT_BRANCH}, or the tree is not clean, and
k-wiki health keeps flagging the staleness until the next real
fire.

Exits 0 on success, 1 on a refusal (no git repo, no dataRoot,
foreign hook in the way) or failure.`;

interface ParsedArgs {
  readonly print: boolean;
  readonly uninstall: boolean;
  readonly error: string | undefined;
}

/** The installer's parsed args; the shell parses, this validates. */
export function parseMetaSyncArgs(args: readonly string[]): ParsedArgs {
  const parsed = parseArgs(args, {
    boolean: ["--print", "--uninstall"],
    positionals: {
      max: 0,
      error: (arg) =>
        `unexpected argument ${JSON.stringify(arg)} — setup-meta-sync takes no positionals`,
    },
  });

  if (parsed.error !== undefined) {
    return { print: false, uninstall: false, error: parsed.error };
  }

  return {
    print: parsed.flags.has("--print"),
    uninstall: parsed.flags.has("--uninstall"),
    error: undefined,
  };
}

/** Injectables so tests can run against temp dirs and a fake git. */
export interface MetaSyncDeps {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly cwd?: string;
  readonly git?: (dir: string, args: readonly string[]) => Promise<string>;
}

const run = promisify(execFile);

async function runGitIn(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir });

  return stdout.trim();
}

/** The canonical checkout: the parent of the shared git dir, so an
 *  installer run from a linked worktree still bakes the canonical
 *  paths. `allowPlainCwd` lets --print work with no git repo. */
async function resolveSourceRoot(
  cwd: string,
  git: (dir: string, args: readonly string[]) => Promise<string>,
  allowPlainCwd: boolean,
): Promise<string> {
  const commonDir = await git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).catch(() => undefined);

  if (commonDir !== undefined) {
    return dirname(commonDir);
  }

  if (allowPlainCwd) {
    return cwd;
  }

  throw new Error(
    "not inside a git repository — run setup-meta-sync from the k-wiki checkout whose merges should re-sync the meta wiki",
  );
}

/** The hook config for one checkout, or the fail-loud reason. */
export async function resolveHookConfig(options: {
  readonly sourceRoot: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly nodePath: string;
}): Promise<MetaHookConfig | { readonly error: string }> {
  const { home, nodePath, platform, sourceRoot } = options;
  const configPath = join(sourceRoot, META_CONFIG);
  const resolved = await resolveDataRoot(configPath, undefined);

  if (resolved.error !== undefined) {
    return { error: resolved.error };
  }

  return {
    nodePath,
    sourceRoot,
    settingsPath: join(sourceRoot, META_SETTINGS),
    configPath,
    rawDir: join(resolved.dataRoot, "raw"),
    logPath: metaSyncLogPath(home, platform),
    branch: DEFAULT_BRANCH,
  };
}

/** Resolve the hook config for the run: source root (canonical
 *  checkout, plain cwd for --print) and the baked paths. An `error`
 *  return is the fail-loud reason; the hooks dir stays unresolved
 *  here — --print works without a git repo. */
async function resolveHookConfigFor(
  print: boolean,
  cwd: string,
  git: (dir: string, args: readonly string[]) => Promise<string>,
  deps: MetaSyncDeps,
): Promise<MetaHookConfig | { readonly error: string }> {
  try {
    return await resolveHookConfig({
      sourceRoot: await resolveSourceRoot(cwd, git, print),
      home: deps.home ?? homedir(),
      platform: deps.platform ?? process.platform,
      nodePath: stableNodePath(process.argv0, process.execPath),
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/** Refuse loud when a hook not owned by this installer stands in
 *  the way (hooks without the installer's marker are never touched). */
async function refuseForeign(
  paths: readonly string[],
  action: string,
): Promise<boolean> {
  const foreign: string[] = [];

  for (const path of paths) {
    const existing = await readTextIfExists(path);

    if (existing !== undefined && !existing.includes(HOOK_MARKER)) {
      foreign.push(path);
    }
  }

  if (foreign.length === 0) {
    return false;
  }

  cliFail(
    "setup-meta-sync",
    `refusing to ${action} — foreign hook${foreign.length === 1 ? "" : "s"} not installed by setup-meta-sync: ${foreign.join(", ")} (resolve manually and re-run)`,
  );

  return true;
}

/** The hook files this installer owns under the shared hooks dir. */
function hookPaths(hooksDir: string): readonly string[] {
  return HOOK_NAMES.map((name) => join(hooksDir, name));
}

/** Install (or confirm) both hooks; idempotent by content. */
async function installHooks(
  hooksDir: string,
  hook: string,
  config: { readonly logPath: string; readonly branch: string },
): Promise<void> {
  const files = hookPaths(hooksDir);

  if (await refuseForeign(files, "overwrite it")) {
    return;
  }

  const written: string[] = [];
  const current: string[] = [];

  for (const path of files) {
    const existing = await readTextIfExists(path);

    if (existing === hook) {
      await chmod(path, 0o755);
      current.push(basename(path));

      continue;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, hook, { mode: 0o755 });
    written.push(basename(path));
  }

  const summary = [
    written.length > 0 ? `installed ${written.join(", ")}` : "",
    current.length > 0 ? `${current.join(", ")} already current` : "",
  ]
    .filter((part) => part !== "")
    .join("; ");

  console.log(
    `setup-meta-sync: ${summary} in ${hooksDir} — merges to ${config.branch} fire a detached meta cycle; log: ${config.logPath}`,
  );
}

/** Remove exactly the hooks this installer wrote. */
async function uninstallHooks(hooksDir: string): Promise<void> {
  const files = hookPaths(hooksDir);

  if (await refuseForeign(files, "uninstall around it")) {
    return;
  }

  const removed: string[] = [];

  for (const path of files) {
    const existing = await readTextIfExists(path);

    if (existing?.includes(HOOK_MARKER)) {
      await unlink(path);
      removed.push(basename(path));
    }
  }

  console.log(
    `setup-meta-sync: uninstalled — removed ${removed.length > 0 ? removed.join(", ") : "nothing (not installed)"} from ${hooksDir}`,
  );
}

/** setup-meta-sync entry point: --uninstall touches only the
 *  hooks dir (it must work after the meta config is gone);
 *  --print and install resolve the hook config (source root —
 *  canonical checkout, plain cwd for --print — and baked paths). */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MetaSyncDeps = {},
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseMetaSyncArgs(argv);

  if (parsed.error !== undefined) {
    cliFail("setup-meta-sync", parsed.error);

    return;
  }

  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? runGitIn;

  if (parsed.uninstall) {
    const hooksDir = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    ]);

    await uninstallHooks(hooksDir);

    return;
  }

  const plan = await resolveHookConfigFor(parsed.print, cwd, git, deps);

  if ("error" in plan) {
    cliFail("setup-meta-sync", plan.error);

    return;
  }

  if (parsed.print) {
    console.log(metaSyncHookScript(plan).trimEnd());

    return;
  }

  const hooksDir = await git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);

  await installHooks(hooksDir, metaSyncHookScript(plan), plan);
}

/* v8 ignore next: covered only under direct `node src/schedule/setup-meta-sync.ts` runs */
refuseDirectExecution(import.meta.url, "setup-meta-sync");
