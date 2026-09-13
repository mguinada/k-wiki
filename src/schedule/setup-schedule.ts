/**
 * setup-schedule: register the scheduled pipeline with the OS
 * scheduler (issue #14). One CLI, per-OS backends: darwin writes a
 * launchd plist to `~/Library/LaunchAgents/` and loads it via
 * `launchctl`; linux (systemd timer) and win32 (Task Scheduler) are
 * follow-up issues — they fail loud, and the platform switch keeps
 * them additive. `--print` emits the artifact without installing.
 *
 * Two independent registrations (issue #359): the default interval
 * job (Label com.kwiki.scheduled-run, `StartInterval`, default 30
 * minutes, issue #14 decision 1) and — with `--calendar` — the
 * weekly full-lint sweep (Label com.kwiki.scheduled-lint,
 * `StartCalendarInterval`, default Sundays 03:00, running
 * `bin/scheduled-run --lint-full`). Each is installed, printed, and
 * removed by its own invocation; neither command touches the other's
 * plist. The plists run `node bin/scheduled-run` with absolute paths,
 * an explicit HOME, and a minimal PATH — no interactive shell env is
 * assumed; the wrapper builds the rest (see scheduled-run.ts).
 * launchd coalesces missed fires — one run at wake, never a pile-up.
 * Re-running with a new `--interval` or `--weekly-at` replaces the
 * registration.
 *
 * Origin guard (issue #361): install and uninstall refuse every
 * origin that is temporary — a Stryker sandbox, a linked worktree,
 * a detached HEAD — because the plist bakes this checkout's
 * absolute paths into a launchd job that must outlive the checkout;
 * the 2026-08-30 registration from a sandbox copy died 84 fires in a
 * row once Stryker cleaned the sandbox. `--print` is exempt (it
 * writes nothing). No `--force`: every alternative origin is
 * wrong, not merely discouraged.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { cliFail, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";

/** The fixed launchd label (reverse-domain; rename = reinstall). */
export const LAUNCHD_LABEL = "com.kwiki.scheduled-run";

/** The weekly full-sweep label (issue #359): a second registration,
 *  installed and removed independently of the interval job. */
export const LINT_LAUNCHD_LABEL = "com.kwiki.scheduled-lint";

/** The agreed default: 30 minutes (issue #14 decision 1). */
export const DEFAULT_INTERVAL_SECONDS = 1800;

/** The sweep's default trigger: Sundays 03:00 (issue #359). launchd,
 *  not cron, deliberately: launchd coalesces missed calendar fires
 *  into one run at wake; cron silently skips them. */
export const DEFAULT_WEEKLY_AT = "sun-03:00";

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

/** The weekly sweep's plist path under the given home. */
export function lintPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LINT_LAUNCHD_LABEL}.plist`);
}

/** The weekday names `--weekly-at` accepts, in launchd's numbering:
 *  0 Sunday … 6 Saturday. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** A calendar trigger: launchd `StartCalendarInterval` fields. */
export interface WeeklyAt {
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

/** Parse a `--weekly-at` value like `sun-03:00` into its calendar
 *  fields; undefined when the text is not `<weekday>-<HH:MM>`. */
export function parseWeeklyAt(text: string): WeeklyAt | undefined {
  const match = /^([a-z]{3})-(\d{2}):(\d{2})$/.exec(text.trim().toLowerCase());
  const weekday = match === null ? undefined : WEEKDAYS[match[1] ?? ""];

  if (match === null || weekday === undefined) {
    return undefined;
  }

  const hour = Number(match[2]);
  const minute = Number(match[3]);

  if (hour > 23 || minute > 59) {
    return undefined;
  }

  return { weekday, hour, minute };
}

/** Escape XML text content — the interpolated paths come from the
 *  environment and may contain &, <, or >. */
function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
        <string>${escapeXmlText(nodePath)}</string>
        <string>${escapeXmlText(scriptPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${escapeXmlText(home)}</string>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXmlText(join(logDir, "launchd-stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXmlText(join(logDir, "launchd-stderr.log"))}</string>
</dict>
</plist>
`;
}

/** The launchd plist for the weekly full sweep (issue #359): the
 *  same shape as the interval registration with a
 *  `StartCalendarInterval` trigger and the `--lint-full` argument.
 *  launchd's calendar semantics coalesce missed fires into one run at
 *  wake — the property a weekly job on a sleeping laptop needs. */
export function launchdCalendarPlist(options: {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly weekly: WeeklyAt;
  readonly home: string;
  readonly logDir: string;
}): string {
  const { home, logDir, nodePath, scriptPath, weekly } = options;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LINT_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXmlText(nodePath)}</string>
        <string>${escapeXmlText(scriptPath)}</string>
        <string>--lint-full</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>${weekly.weekday}</integer>
        <key>Hour</key>
        <integer>${weekly.hour}</integer>
        <key>Minute</key>
        <integer>${weekly.minute}</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${escapeXmlText(home)}</string>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXmlText(join(logDir, "launchd-lint-stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXmlText(join(logDir, "launchd-lint-stderr.log"))}</string>
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

  return `scheduling on ${platform} is not implemented yet — the backend is ${backend}, a follow-up issue (out of scope); use --print to inspect the macOS artifact or run wiki-sync manually`;
}

/** Whether this module runs from a Stryker sandbox copy — the
 *  quality tests' detector pattern (tests/quality/src-tree.ts,
 *  issue #276): the module loaded from a .stryker-tmp path, or the
 *  instrumented global present. A sandbox must never register
 *  launchd — its paths are temporary (issue #361). */
function insideStrykerSandbox(): boolean {
  return (
    import.meta.url.includes(".stryker-tmp") || "__stryker__" in globalThis
  );
}

/** What git says about the checkout the installer runs from; each
 *  field undefined when git could not answer it. */
export interface CheckoutFacts {
  /** The worktree's own git dir (`--git-dir`). */
  readonly gitDir: string | undefined;
  /** The shared git dir (`--git-common-dir`) — the main checkout's
   *  `.git` also for linked worktrees. */
  readonly commonDir: string | undefined;
  /** The ref HEAD points at (`symbolic-ref HEAD`); undefined when
   *  detached. */
  readonly head: string | undefined;
}

/** The origin refusal (issue #361): undefined when the installer's
 *  origin is safe — not a Stryker sandbox, and the main working
 *  tree on a branch. Every other origin is temporary, and the
 *  registration bakes its absolute paths into a launchd job that
 *  must outlive it. */
export function originRefusal(
  sandboxed: boolean,
  facts: CheckoutFacts,
  root: string,
): string | undefined {
  if (sandboxed) {
    return "refusing to install: this process runs inside a Stryker sandbox — the sandbox copy is temporary, and the registration would bake its paths into the launchd job; run k-wiki setup-schedule from the main k-wiki checkout instead";
  }

  if (facts.gitDir === undefined || facts.commonDir === undefined) {
    return `refusing to install: ${root} is not inside a git repository — the installer cannot verify it is the main checkout; run k-wiki setup-schedule from the main k-wiki checkout instead`;
  }

  if (facts.gitDir !== facts.commonDir) {
    return `refusing to install: ${root} is a linked worktree — a worktree is temporary, and the registration would bake its paths into the launchd job; run k-wiki setup-schedule from the main checkout (${dirname(facts.commonDir)}) instead`;
  }

  if (facts.head === undefined) {
    return `refusing to install: HEAD is detached at ${root} — a detached checkout is temporary state; run k-wiki setup-schedule from the main checkout (${dirname(facts.commonDir)}) on a branch instead`;
  }

  return undefined;
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

/** The weekday name of launchd's 0–6 numbering (0 = Sunday). */
function weekdayName(weekday: number): string {
  return (
    [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][weekday] ?? String(weekday)
  );
}

/** The node path pinned into the plist (issue #216): the verbatim
 *  invocation path (`process.argv0`) when absolute and existing —
 *  stable across Homebrew upgrades, unlike the symlink-resolved
 *  `process.execPath`, which points into a versioned Cellar — else
 *  the resolved binary. Note: `process.argv[0]` is already resolved
 *  by Node and equals `execPath`; only `argv0` keeps the invocation. */
export function stableNodePath(
  argv0: string,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): string {
  return isAbsolute(argv0) && exists(argv0) ? argv0 : execPath;
}

async function launchctl(args: readonly string[]): Promise<void> {
  await run("launchctl", args).catch((error: unknown) => {
    throw new Error(
      `launchctl ${args.join(" ")} failed — ${errorMessage(error)}`,
    );
  });
}

/** Run git in `dir`, returning trimmed stdout — the origin guard's
 *  probe; injectable so tests feed facts without a repository. */
async function runGitIn(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir });

  return stdout.trim();
}

/** Ask git what the checkout at `root` is: its own git dir, the
 *  shared one, and the ref HEAD names. Failed queries read as
 *  undefined — the guard refuses what it cannot verify. */
async function probeCheckout(
  root: string,
  git: (dir: string, args: readonly string[]) => Promise<string>,
): Promise<CheckoutFacts> {
  const [gitDir, commonDir, head] = await Promise.all([
    git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]).catch(
      () => undefined,
    ),
    git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).catch(() => undefined),
    git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => undefined),
  ]);

  return { commonDir, gitDir, head };
}

/** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: setup-schedule [-h | --help] [--calendar [--weekly-at <day-HH:MM>]] [--interval <duration>] [--print] [--uninstall]

Register the k-wiki pipeline with the OS scheduler. Two independent
registrations: the fixed-interval cycle (default) and —
with --calendar — the weekly full-lint sweep. The scheduled command
is node bin/scheduled-run — lockfile, git pull --rebase, wiki-sync,
git push; the calendar registration adds --lint-full (wiki-lint
--full first). macOS only today: the source vault lives in iCloud, so
only macOS can run the pipeline; other OSs host read-only clones
that need no scheduler. Linux (systemd timer) and Windows (Task
Scheduler) backends are follow-up issues and fail loud here.

  --calendar            Manage the weekly full-sweep registration
                         (Label ${LINT_LAUNCHD_LABEL}) instead of the
                         interval job: installs, prints, or removes
                         only that plist. The interval registration is
                         untouched — each is managed by its own
                         command.
  --weekly-at <day-HH:MM>  The sweep's calendar trigger, e.g.
                         sun-03:00 (Sundays 03:00 — the default) or
                         sat-04:30. Weekday names: sun mon tue wed
                         thu fri sat. Only with --calendar;
                         re-running replaces the registration.
  --interval <duration>  Minutes between runs (interval registration
                         only), e.g. --interval 15minutes (also
                         45seconds, 1hour, 2hours). Default: 30minutes
                         (launchd StartInterval 1800). Re-running with
                         a new interval replaces the registration.
  --print                Print the macOS launchd plist to stdout
                         without installing or loading anything —
                         works on every OS, for inspection where
                         auto-install lacks permissions.
  --uninstall            Remove the registration this command
                         addresses: boot out the launchd job and
                         delete its plist.
  -h, --help             Print this help and exit; no side effects.

What install does (darwin, interval registration):
  1. builds the plist (Label ${LAUNCHD_LABEL}, StartInterval, RunAtLoad,
     absolute node + script paths — the node path is the invocation
     path when absolute and existing (stable across Homebrew
     upgrades), else the resolved binary — explicit HOME,
     minimal PATH, launchd stdout/stderr into ~/Library/Logs/k-wiki/);
  2. boots out any previous registration of the label;
  3. writes it to ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist;
  4. boots it in and verifies with launchctl print.

What install does (darwin, --calendar):
  the same steps for Label ${LINT_LAUNCHD_LABEL} with a
  StartCalendarInterval trigger (default sun-03:00), running
  bin/scheduled-run --lint-full — the weekly wiki-lint --full sweep
  under the shared run lock: a concurrent 30-minute cycle makes the
  sweep skip loud naming the holder, and vice versa.

The interval job then runs once at load (boot/login) and every
interval; the calendar job runs at its weekly time. A sleep
coalesces missed fires into one run at wake — launchd, not cron,
  deliberately: cron silently skips missed fires; wrong for a weekly
job on a laptop closed at 03:00. Nothing is written outside the
plist files and the launchd log captures.

Origin guard: install and uninstall run only from the
repository's main working tree on a branch. The command refuses —
exit 1, nothing written — when it runs inside a Stryker sandbox, a
linked worktree, or a detached HEAD: the registration bakes this
checkout's absolute paths into a launchd job that must outlive the
checkout, and those origins are temporary. Run k-wiki setup-schedule
from the main checkout instead; --print is exempt (it writes
nothing).

Exits 0 on success, 1 on refusal (unsafe origin, unsupported OS) or
failure.`;

interface ParsedArgs {
  readonly interval: number;
  readonly calendar: boolean;
  readonly weeklyAt: WeeklyAt;
  readonly print: boolean;
  readonly uninstall: boolean;
  readonly error: string | undefined;
}

/** A usage-error result: nothing parsed, the first error message. */
function usageError(message: string): ParsedArgs {
  return {
    interval: DEFAULT_INTERVAL_SECONDS,
    calendar: false,
    weeklyAt: parseWeeklyAt(DEFAULT_WEEKLY_AT) as WeeklyAt,
    print: false,
    uninstall: false,
    error: message,
  };
}

/** The installer's parsed args; the shell parses, this validates. */
export function parseScheduleArgs(args: readonly string[]): ParsedArgs {
  const parsed = parseArgs(args, {
    value: ["--interval", "--weekly-at"],
    boolean: ["--print", "--uninstall", "--calendar"],
    positionals: {
      max: 0,
      error: (arg) =>
        `unexpected argument ${JSON.stringify(arg)} — setup-schedule takes no positionals`,
    },
  });

  if (parsed.error !== undefined) {
    return usageError(parsed.error);
  }

  const calendar = parsed.flags.has("--calendar");
  const weeklyText = parsed.values.get("--weekly-at");

  if (weeklyText !== undefined && !calendar) {
    return usageError(
      "--weekly-at needs --calendar — it configures the weekly sweep registration",
    );
  }

  const weeklyAt =
    weeklyText === undefined
      ? parseWeeklyAt(DEFAULT_WEEKLY_AT)
      : parseWeeklyAt(weeklyText);

  if (weeklyAt === undefined) {
    return usageError(
      `invalid --weekly-at value ${JSON.stringify(weeklyText)} — use <weekday>-<HH:MM> with weekday sun|mon|tue|wed|thu|fri|sat (e.g. sun-03:00)`,
    );
  }

  const resolved = resolveInterval(parsed.values);

  if (typeof resolved !== "number") {
    return usageError(resolved.error);
  }

  return {
    interval: resolved,
    calendar,
    weeklyAt,
    print: parsed.flags.has("--print"),
    uninstall: parsed.flags.has("--uninstall"),
    error: undefined,
  };
}

/** The --interval seconds: the default when absent, else the error. */
function resolveInterval(
  values: ReadonlyMap<string, string | undefined>,
): number | { readonly error: string } {
  const intervalText = values.get("--interval");

  if (values.has("--interval") && intervalText === undefined) {
    return { error: "--interval needs a duration value (e.g. 15minutes)" };
  }

  const interval =
    intervalText === undefined
      ? DEFAULT_INTERVAL_SECONDS
      : parseIntervalDuration(intervalText);

  if (interval === undefined) {
    return {
      error: `invalid --interval value ${JSON.stringify(intervalText)} — use <n><unit> with unit seconds|minutes|hours (e.g. 15minutes)`,
    };
  }

  return interval;
}

/** One registration this invocation manages: its label, plist file,
 *  and plist text. With `--calendar` the weekly sweep; without, the
 *  interval cycle. Each is installed, printed, and removed by its
 *  own command — neither touches the other's plist (issue #359). */
interface Registration {
  readonly label: string;
  readonly target: string;
  readonly plist: string;
}

/** The registration the parsed args address. */
function registrationFor(parsed: ParsedArgs, home: string): Registration {
  const nodePath = stableNodePath(process.argv0, process.execPath);
  const scriptPath = join(repoRoot, "bin", "scheduled-run");

  if (parsed.calendar) {
    return {
      label: LINT_LAUNCHD_LABEL,
      target: lintPlistPath(home),
      plist: launchdCalendarPlist({
        nodePath,
        scriptPath,
        weekly: parsed.weeklyAt,
        home,
        logDir: logDirFor(home),
      }),
    };
  }

  return {
    label: LAUNCHD_LABEL,
    target: plistPath(home),
    plist: launchdPlist({
      nodePath,
      scriptPath,
      intervalSeconds: parsed.interval,
      home,
      logDir: logDirFor(home),
    }),
  };
}

/** Install (or, with --uninstall, remove) the registration through
 *  launchctl: replace any previous registration of the label, write
 *  the plist, bootstrap it, and verify it answers print. */
async function installRegistration(
  parsed: ParsedArgs,
  registration: Registration,
  runLaunchctl: (args: readonly string[]) => Promise<void>,
): Promise<void> {
  const { label, target } = registration;

  if (parsed.uninstall) {
    await runLaunchctl(["bootout", guiDomain(), target]).catch(() => {});
    await unlink(target).catch(() => {});
    console.log(
      `setup-schedule: uninstalled — ${target} removed and booted out`,
    );

    return;
  }

  // Replace any previous registration first: a re-run with a new
  // --interval or --weekly-at must update, not duplicate.
  await runLaunchctl(["bootout", guiDomain(), target]).catch(() => {});

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, registration.plist, { mode: 0o644 });
  await runLaunchctl(["bootstrap", guiDomain(), target]);

  // Verify from the same clean launchd view the job will run in —
  // a loaded job answers print.
  await runLaunchctl(["print", `${guiDomain()}/${label}`]);
}

/** The installed-registration success line. */
function installedMessage(
  parsed: ParsedArgs,
  registration: Registration,
  home: string,
): string {
  if (parsed.calendar) {
    const { weekday, hour, minute } = parsed.weeklyAt;
    const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

    return `setup-schedule: installed — ${registration.target} (weekly ${weekdayName(weekday)} ${clock}, bin/scheduled-run --lint-full); logs in ${logDirFor(home)}`;
  }

  return `setup-schedule: installed — ${registration.target} (every ${parsed.interval}s, RunAtLoad); logs in ${logDirFor(home)}`;
}

/** setup-schedule entry point. `runLaunchctl`, `home`, and `git`
 *  are injectable so tests can record the registration commands,
 *  write the plist into a temp dir, and feed the origin guard
 *  checkout facts instead of touching operator state. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  platform: NodeJS.Platform = process.platform,
  runLaunchctl: (args: readonly string[]) => Promise<void> = launchctl,
  home: string = homedir(),
  git: (dir: string, args: readonly string[]) => Promise<string> = runGitIn,
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseScheduleArgs(argv);

  if (parsed.error !== undefined) {
    cliFail("setup-schedule", parsed.error);

    return;
  }

  const registration = registrationFor(parsed, home);

  if (parsed.print) {
    console.log(registration.plist.trimEnd());

    return;
  }

  const refusal = originRefusal(
    insideStrykerSandbox(),
    await probeCheckout(repoRoot, git),
    repoRoot,
  );

  if (refusal !== undefined) {
    cliFail("setup-schedule", refusal);

    return;
  }

  if (platform !== "darwin") {
    cliFail("setup-schedule", schedulerUnsupportedError(platform));

    return;
  }

  await installRegistration(parsed, registration, runLaunchctl);

  console.log(installedMessage(parsed, registration, home));
}

/* v8 ignore next: covered only under direct `node src/schedule/setup-schedule.ts` runs */
refuseDirectExecution(import.meta.url, "setup-schedule");
