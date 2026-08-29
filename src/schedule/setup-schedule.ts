import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { errorMessage } from "../cli/colors.ts";
import { readFlagValues } from "../cli/flag-args.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";

/**
 * setup-schedule: register the scheduled pipeline with the OS
 * scheduler (issue #14). One CLI, per-OS backends: darwin writes a
 * launchd plist to `~/Library/LaunchAgents/` and loads it via
 * `launchctl`; linux (systemd timer) and win32 (Task Scheduler) are
 * follow-up issues — they fail loud, and the platform switch keeps
 * them additive. `--print` emits the artifact without installing.
 *
 * The plist runs `node bin/scheduled-run.ts` with absolute paths, an
 * explicit HOME, and a minimal PATH — no interactive shell env is
 * assumed; the wrapper builds the rest (see scheduled-run.ts). The
 * trigger is a fixed interval (`StartInterval`, default 30 minutes,
 * issue #14 decision 1); launchd coalesces missed intervals — one run
 * at wake, never a pile-up — and `RunAtLoad` makes the
 * first-run-after-boot deterministic. Re-running with a new
 * `--interval` replaces the registration.
 */

/** The fixed launchd label (reverse-domain; rename = reinstall). */
export const LAUNCHD_LABEL = "com.kwiki.scheduled-run";

/** The agreed default: 30 minutes (issue #14 decision 1). */
export const DEFAULT_INTERVAL_SECONDS = 1800;

const run = promisify(execFile);

const DURATIONS: Readonly<Record<string, number>> = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 3600,
  hours: 3600,
};

/** Parse an interval like `15minutes` or `1hour` into seconds;
 *  undefined when the text is not `<positive integer><unit>`. */
export function parseIntervalDuration(text: string): number | undefined {
  const match = /^([1-9][0-9]*)(seconds?|minutes?|hours?)$/i.exec(text.trim());
  const unit = match?.[2]?.toLowerCase();
  const multiplier = unit === undefined ? undefined : DURATIONS[unit];

  if (match === null || multiplier === undefined) {
    return undefined;
  }

  return Number(match[1]) * multiplier;
}

/** The plist path for the label under the given home. */
export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** The launchd plist for one registration: absolute node + script
 *  paths, explicit HOME, minimal PATH, fixed-interval trigger, and
 *  launchd-level output capture beside the wrapper's own log. */
export function launchdPlist(options: {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly intervalSeconds: number;
  readonly home: string;
  readonly logDir: string;
}): string {
  const { home, intervalSeconds, logDir, nodePath, scriptPath } = options;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${join(logDir, "launchd-stdout.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(logDir, "launchd-stderr.log")}</string>
</dict>
</plist>
`;
}

/** The loud refusal for an OS without a scheduler backend — the
 *  follow-up issues make the backends additive (issue #14). */
export function schedulerUnsupportedError(platform: string): string {
  const backend =
    platform === "linux"
      ? "a systemd timer"
      : platform === "win32"
        ? "Task Scheduler"
        : `a ${platform} scheduler`;

  return `scheduling on ${platform} is not implemented yet — the backend is ${backend}, a follow-up issue (issue #14 out of scope); use --print to inspect the macOS artifact or run wiki-sync manually`;
}

/** The log dir the plist points launchd's own captures at — the same
 *  home the wrapper logs beside (scheduled-run.ts). */
function logDirFor(home: string): string {
  return join(home, "Library", "Logs", "k-wiki");
}

/** The launchctl domain for this user's GUI session. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function launchctl(args: readonly string[]): Promise<void> {
  await run("launchctl", args).catch((error: unknown) => {
    throw new Error(
      `launchctl ${args.join(" ")} failed — ${errorMessage(error)}`,
    );
  });
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: setup-schedule [-h | --help] [--interval <duration>] [--print] [--uninstall]

Register the k-wiki pipeline with the OS scheduler (issue #14). The
scheduled command is node bin/scheduled-run.ts — lockfile, git pull
--rebase, wiki-sync, git push — run unattended on a fixed interval.
macOS only today: the source vault lives in iCloud, so only macOS can
run the pipeline; other OSs host read-only clones that need no
scheduler. Linux (systemd timer) and Windows (Task Scheduler)
backends are follow-up issues and fail loud here.

  --interval <duration>  Minutes between runs, e.g. --interval
                         15minutes (also 45seconds, 1hour, 2hours).
                         Default: 30minutes (launchd StartInterval
                         1800). Re-running with a new interval
                         replaces the registration.
  --print                Print the macOS launchd plist to stdout
                         without installing or loading anything —
                         works on every OS, for inspection where
                         auto-install lacks permissions.
  --uninstall            Remove the registration: bootout the launchd
                         job and delete its plist.
  -h, --help             Print this help and exit; no side effects.

What install does (darwin):
  1. builds the plist (Label ${LAUNCHD_LABEL}, StartInterval, RunAtLoad,
     absolute node + script paths, explicit HOME, minimal PATH,
     launchd stdout/stderr into ~/Library/Logs/k-wiki/);
  2. boots out any previous registration of the label;
  3. writes it to ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist;
  4. boots it in and verifies with launchctl print.

The job then runs once at load (boot/login) and every interval; a
sleep coalesces missed intervals into one run at wake. Nothing is
written outside the plist file and the launchd log captures.

Exits 0 on success, 1 on refusal (unsupported OS) or failure.`;

interface ParsedArgs {
  readonly interval: number;
  readonly print: boolean;
  readonly uninstall: boolean;
  readonly error: string | undefined;
}

/** A usage-error result: nothing parsed, the first error message. */
function usageError(message: string): ParsedArgs {
  return {
    interval: DEFAULT_INTERVAL_SECONDS,
    print: false,
    uninstall: false,
    error: message,
  };
}

/** The first argument that is neither a known flag nor an --interval
 *  value, as a usage error; undefined when argv holds only knowns. */
function unknownArgError(
  args: readonly string[],
  consumed: ReadonlySet<number>,
): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (!consumed.has(index) && arg !== "--print" && arg !== "--uninstall") {
      return arg.startsWith("-")
        ? `unknown option ${JSON.stringify(arg)}`
        : `unexpected argument ${JSON.stringify(arg)} — setup-schedule takes no positionals`;
    }
  }

  return undefined;
}

/** Pull the installer's flags out of argv; any other option or a
 *  positional is a usage error, as are --interval value errors. */
export function parseCliArgs(args: readonly string[]): ParsedArgs {
  const { values, consumed } = readFlagValues(["--interval"], args);
  const unknown = unknownArgError(args, consumed);

  if (unknown !== undefined) {
    return usageError(unknown);
  }

  const intervalText = values.get("--interval");

  if (values.has("--interval") && intervalText === undefined) {
    return usageError("--interval needs a duration value (e.g. 15minutes)");
  }

  const interval =
    intervalText === undefined
      ? DEFAULT_INTERVAL_SECONDS
      : parseIntervalDuration(intervalText);

  if (interval === undefined) {
    return usageError(
      `invalid --interval value ${JSON.stringify(intervalText)} — use <n><unit> with unit seconds|minutes|hours (e.g. 15minutes)`,
    );
  }

  return {
    interval,
    print: args.includes("--print"),
    uninstall: args.includes("--uninstall"),
    error: undefined,
  };
}

/** setup-schedule entry point. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseCliArgs(argv);

  if (parsed.error !== undefined) {
    console.error(`setup-schedule: ${parsed.error}`);
    process.exitCode = 1;

    return;
  }

  const home = homedir();
  const plist = launchdPlist({
    nodePath: process.execPath,
    scriptPath: join(repoRoot, "bin", "scheduled-run.ts"),
    intervalSeconds: parsed.interval,
    home,
    logDir: logDirFor(home),
  });

  if (parsed.print) {
    console.log(plist.trimEnd());

    return;
  }

  if (platform !== "darwin") {
    console.error(`setup-schedule: ${schedulerUnsupportedError(platform)}`);
    process.exitCode = 1;

    return;
  }

  const target = plistPath(home);

  if (parsed.uninstall) {
    await launchctl(["bootout", guiDomain(), target]).catch(() => {});
    await unlink(target).catch(() => {});
    console.log(
      `setup-schedule: uninstalled — ${target} removed and booted out`,
    );

    return;
  }

  // Replace any previous registration first: a re-run with a new
  // --interval must update, not duplicate (issue #14 scope).
  await launchctl(["bootout", guiDomain(), target]).catch(() => {});

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, plist, { mode: 0o644 });
  await launchctl(["bootstrap", guiDomain(), target]);

  // Verify from the same clean launchd view the job will run in —
  // a loaded job answers print.
  await launchctl(["print", `${guiDomain()}/${LAUNCHD_LABEL}`]);

  console.log(
    `setup-schedule: installed — ${target} (every ${parsed.interval}s, RunAtLoad); logs in ${logDirFor(home)}`,
  );
}

/* v8 ignore next: covered only under direct `node src/schedule/setup-schedule.ts` runs */
refuseDirectExecution(import.meta.url, "setup-schedule");
