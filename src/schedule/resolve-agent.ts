/**
 * The agent binary resolution (issue #399): launchd runs the
 * scheduled wrapper with a minimal PATH, and a bare agent command
 * installed outside the standard dirs (npm prefixes, version
 * managers) can never start — every tick died as `spawn pi ENOENT`
 * noise. The launcher resolves the settings' command to an absolute
 * path once per cycle — the scheduled PATH first, then the
 * operator's login shell, whose profile carries the interactive
 * PATH — and hands that path to every spawned child through
 * `KWIKI_AGENT_COMMAND` (agent-settings.ts). Unresolvable, the cycle
 * fails before any stage: an unstartable agent must never reach the
 * shared-writer lease.
 */

import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long the login-shell probe may take: profiles are fast, and
 *  a hung shell must not hang the cycle. */
const LOGIN_SHELL_TIMEOUT_MS = 10_000;

/** The shell the login-shell probe runs: the operator's SHELL when
 *  the environment names one, the macOS default login shell on
 *  darwin (whose .zprofile carries the interactive PATH), POSIX sh
 *  elsewhere. */
export function loginShell(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  return environment.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

/** Whether `candidate` is an existing, executable file: the spawn
 *  that consumes the resolved path needs X_OK, so a non-executable
 *  hit is no resolution at all. */
async function isExecutable(candidate: string): Promise<boolean> {
  return (
    (await stat(candidate).then(
      (info) => info.isFile(),
      () => false,
    )) &&
    (await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    ))
  );
}

/** The first executable `command` on `searchPath` (the scheduled
 *  env's PATH layout), or undefined. */
async function fromSearchPath(
  command: string,
  searchPath: string,
): Promise<string | undefined> {
  for (const dir of searchPath.split(":")) {
    if (dir === "") {
      continue;
    }

    const candidate = join(dir, command);

    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** The absolute path the login shell's `command -v` reports, or
 *  undefined: a login shell's profile output may precede the answer,
 *  so only the final stdout line counts, and only when it is an
 *  executable path (builtin and alias hits are names, not paths). */
async function fromLoginShell(
  command: string,
  shell: string,
): Promise<string | undefined> {
  const escaped = command.replace(/'/g, "'\\''");
  const { stdout } = await execFileAsync(
    shell,
    ["-lc", `command -v '${escaped}'`],
    { timeout: LOGIN_SHELL_TIMEOUT_MS },
  );

  const answer = stdout.trim().split("\n").pop() ?? "";

  return isAbsolute(answer) && (await isExecutable(answer))
    ? answer
    : undefined;
}

/**
 * The absolute path of the agent binary a settings command names, or
 * undefined when nothing resolves it. A command holding a slash is a
 * path — absolute, or relative to the wrapper's cwd — and only gets
 * an executable check; a bare name searches `searchPath`, then asks
 * the login shell (whose profile carries the interactive PATH the
 * launchd env lacks) when `shell` is given. The quoted probe is the
 * only place the command reaches a shell, and it cannot break out.
 */
export async function resolveAgentPath(
  command: string,
  searchPath: string,
  shell?: string | undefined,
): Promise<string | undefined> {
  if (command.includes("/")) {
    const candidate = resolve(command);

    return (await isExecutable(candidate)) ? candidate : undefined;
  }

  const onPath = await fromSearchPath(command, searchPath);

  if (onPath !== undefined || shell === undefined) {
    return onPath;
  }

  try {
    return await fromLoginShell(command, shell);
  } catch {
    return undefined;
  }
}
