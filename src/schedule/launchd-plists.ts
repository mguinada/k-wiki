/**
 * The launchd plist builders (issues #14, #359, #362): one pure
 * renderer per registration — the interval cycle, the weekly
 * full-lint sweep, and the hourly heartbeat watchdog. Extracted from
 * setup-schedule.ts (issue #362 made three registrations and their
 * templates outgrew the installer module); the installer keeps the
 * arg parsing, origin guard, and launchctl orchestration, and each
 * plist stays a pure function: paths and triggers in, XML text out.
 */

import { join } from "node:path";

/** The fixed launchd label of the interval cycle (reverse-domain;
 *  rename = reinstall). */
export const LAUNCHD_LABEL = "com.kwiki.scheduled-run";

/** The weekly full-sweep label (issue #359). */
export const LINT_LAUNCHD_LABEL = "com.kwiki.scheduled-lint";

/** The heartbeat watchdog's label (issue #362). */
export const WATCHDOG_LAUNCHD_LABEL = "com.kwiki.watchdog";

/** A calendar trigger: launchd `StartCalendarInterval` fields. */
export interface WeeklyAt {
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

/** The plist path for the label under the given home. */
export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** The weekly sweep's plist path under the given home. */
export function lintPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LINT_LAUNCHD_LABEL}.plist`);
}

/** The watchdog's plist path under the given home. */
export function watchdogPlistPath(home: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${WATCHDOG_LAUNCHD_LABEL}.plist`,
  );
}

/** Escape XML text content — the interpolated paths come from the
 *  environment and may contain &, <, or >. */
function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The shared plist chrome around one registration's specifics:
 *  label, program arguments, trigger, environment, and launchd's
 *  own output captures beside the wrapper's log. */
function launchdPlistBody(fields: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly trigger: string;
  readonly home: string;
  readonly logDir: string;
  readonly logPrefix: string;
}): string {
  const { home, label, logDir, logPrefix, programArguments, trigger } = fields;
  const args = programArguments
    .map((arg) => `        <string>${escapeXmlText(arg)}</string>`)
    .join("\n");

  return `<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
${trigger}
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${escapeXmlText(home)}</string>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXmlText(join(logDir, `${logPrefix}-stdout.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXmlText(join(logDir, `${logPrefix}-stderr.log`))}</string>
</dict>
</plist>
`;
}

/** The plist document around one registration's body. */
function plistDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${body}`;
}

/** The launchd plist for the interval cycle (issue #14): absolute
 *  node + script paths, explicit HOME, minimal PATH, fixed-interval
 *  trigger (plus RunAtLoad), and launchd-level output capture. */
export function launchdPlist(options: {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly intervalSeconds: number;
  readonly home: string;
  readonly logDir: string;
}): string {
  const { home, intervalSeconds, logDir, nodePath, scriptPath } = options;

  return plistDocument(
    launchdPlistBody({
      label: LAUNCHD_LABEL,
      programArguments: [nodePath, scriptPath],
      trigger: `    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>`,
      home,
      logDir,
      logPrefix: "launchd",
    }),
  );
}

/** The launchd plist for the weekly full sweep (issue #359): the
 *  same shape with a `StartCalendarInterval` trigger and the
 *  `--lint-full` argument. launchd's calendar semantics coalesce
 *  missed fires into one run at wake — the property a weekly job on
 *  a sleeping laptop needs. */
export function launchdCalendarPlist(options: {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly weekly: WeeklyAt;
  readonly home: string;
  readonly logDir: string;
}): string {
  const { home, logDir, nodePath, scriptPath, weekly } = options;

  return plistDocument(
    launchdPlistBody({
      label: LINT_LAUNCHD_LABEL,
      programArguments: [nodePath, scriptPath, "--lint-full"],
      trigger: `    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>${weekly.weekday}</integer>
        <key>Hour</key>
        <integer>${weekly.hour}</integer>
        <key>Minute</key>
        <integer>${weekly.minute}</integer>
    </dict>`,
      home,
      logDir,
      logPrefix: "launchd-lint",
    }),
  );
}

/** The launchd plist for the heartbeat watchdog (issue #362): the
 *  same shape, hourly, running the read-only sync-watchdog door with
 *  the staleness threshold baked into its arguments. Independent of
 *  the pipeline's own job by design — it must keep watching when the
 *  pipeline cannot report. */
export function launchdWatchdogPlist(options: {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly intervalSeconds: number;
  readonly staleAfter: string;
  readonly home: string;
  readonly logDir: string;
}): string {
  const { home, intervalSeconds, logDir, nodePath, scriptPath, staleAfter } =
    options;

  return plistDocument(
    launchdPlistBody({
      label: WATCHDOG_LAUNCHD_LABEL,
      programArguments: [nodePath, scriptPath, "--stale-after", staleAfter],
      trigger: `    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>`,
      home,
      logDir,
      logPrefix: "launchd-watchdog",
    }),
  );
}
