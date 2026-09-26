/**
 * setup-schedule's help text (AGENTS.md CLI rule: every switch,
 * argument, and default). Extracted from the installer; a static
 * string with no logic of its own.
 */

import {
  LAUNCHD_LABEL,
  LINT_LAUNCHD_LABEL,
  WATCHDOG_LAUNCHD_LABEL,
} from "./launchd-plists.ts";

/** Help text: every switch and default (AGENTS.md CLI rule). */
export const HELP = `Usage: setup-schedule [-h | --help] [--calendar [--weekly-at <day-HH:MM>]] [--watchdog [--stale-after <duration>]] [--interval <duration>] [--print] [--uninstall]

Register the k-wiki pipeline with the OS scheduler. Three independent
registrations: the fixed-interval cycle (default), — with --calendar —
the weekly full-lint sweep, and — with --watchdog — the hourly
heartbeat watchdog. The scheduled command is node bin/scheduled-run —
lockfile, agent resolution, quota pre-flight, git pull --rebase,
wiki-sync, git push;
the calendar registration adds --lint-full (wiki-lint --full first);
the watchdog
registration runs the read-only bin/libexec/sync-watchdog door, which
alerts when the cycle heartbeat goes stale, missing, or unreadable,
or when benign quota-skipped ticks persist past its threshold or no
successful cycle is on record.
macOS only today: the source vault lives in iCloud, so only macOS can
run the pipeline; other OSs host read-only clones that need no
scheduler. Linux (systemd timer) and Windows (Task Scheduler) backends
are follow-up issues and fail loud here.

  --watchdog           Manage the heartbeat watchdog registration
                         (Label ${WATCHDOG_LAUNCHD_LABEL}) instead:
                         an hourly launchd job running the read-only
                         bin/libexec/sync-watchdog door, independent
                         of the cycle job — it reads the
                         outputs/last-cycle.json stamp every
                         completed cycle writes and alerts (macOS
                         notification, exit 1) when the stamp is
                         stale, unreadable, or missing past the
                         grace window, or when benign
                         quota-skipped ticks persist past its
                         threshold or no successful cycle is on
                         record.
                         Installed, printed, and
                         removed by its own invocation; the other
                         registrations are untouched.
  --stale-after <duration>  The watchdog's staleness threshold,
                         e.g. 90minutes (the default: three
                         30-minute run intervals) or 3hours; baked
                         into the watchdog job's arguments. Only
                         with --watchdog; re-running replaces the
                         registration.
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

What install does (darwin, --watchdog):
  1. stamps the data repo's watchdog grace anchor (the ISO line at
     outputs/watchdog-since.txt, resolved through the repo's
     sync.json) — the watchdog's RunAtLoad fire against an existing
     (upgrade) data repo would otherwise read a missing stamp over
     old commits and alert before the first cycle completes; the
     stamp is best-effort, a failure warns and the install proceeds;
  2. builds the plist (Label ${WATCHDOG_LAUNCHD_LABEL}, hourly
     StartInterval, RunAtLoad, running bin/libexec/sync-watchdog
     --stale-after <duration>) — the independent heartbeat observer:
     it never runs the pipeline, only reads its stamp, so an outage
     that fails before the pipeline's process starts is still caught;
  3. boots out any previous registration of the label;
  4. writes it to ~/Library/LaunchAgents/${WATCHDOG_LAUNCHD_LABEL}.plist;
  5. boots it in and verifies with launchctl print.

What install does (darwin, --calendar):
  the same steps for Label ${LINT_LAUNCHD_LABEL} with a
  StartCalendarInterval trigger (default sun-03:00), running
  bin/scheduled-run --lint-full — the weekly wiki-lint --full sweep
  under the shared run lock: a concurrent 30-minute cycle makes the
  sweep skip loud naming the holder, and vice versa.

The interval job then runs once at load (boot/login) and every
interval; the calendar job runs at its weekly time; the watchdog
job sweeps hourly. A sleep coalesces missed fires into one run at
wake — launchd, not cron,
  deliberately: cron silently skips missed fires; wrong for a weekly
job on a laptop closed at 03:00. Nothing is written outside the
plist files, the launchd log captures, and — with --watchdog — the
data repo's outputs/watchdog-since.txt grace anchor (a per-instance
file, kept out of git history like the heartbeat stamp).

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
