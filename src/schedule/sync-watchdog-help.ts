/**
 * sync-watchdog's help text (AGENTS.md CLI rule: every switch,
 * argument, and default). Extracted from the door; a static string
 * with no logic of its own.
 */

export /** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: sync-watchdog [-h | --help] [--stale-after <duration>] [<config>] [<raw-dir>]

The heartbeat watchdog: read the data repo's outputs/last-cycle.json
stamp (written by every completed scheduled-run cycle — ok, failed,
or a benign quota-skipped tick) and report whether the pipeline is
alive. The stamp's age is the verdict: within the threshold prints
one line and exits 0; past it — or unreadable, or missing past the
grace window — prints one line, fires a macOS notification
(osascript; KWIKI_NOTIFY=0 disables every notification), and exits 1
(launchd records the failure). A quota-skipped stamp is benign while
its ticks keep arriving and names its cause; when the last
successful cycle ages past the threshold the watchdog alerts naming
that cause, and a stamp that itself goes stale — a scheduler that
died — alerts like any other. A stamp whose cycle ran with the
quota pre-flight dormant carries a "pre-flight: off" note. The
watchdog is independent of the monitored pipeline by design: a
cycle that never started leaves no log line, but a stalling
heartbeat is visible from outside.

  --stale-after <duration>  The staleness threshold, e.g. 90minutes
                            (the default: three 30-minute run
                            intervals), 3hours, 45minutes. A stamp
                            at least this old still counts as
                            fresh; older alerts.
  -h, --help                Print this help and exit; no side
                            effects.
  <config>                  The sync config naming the data repo.
                            Default: the repo's sync.json.
  <raw-dir>                 The raw projection directory; its
                            parent names the data repo. Default:
                            the config's raw dir.

Grace window: a fresh install has no stamp until the first cycle
completes. While no stamp exists, the newest of the data-repo
commit date and the install anchor (the ISO line setup-schedule
writes when the watchdog registration installs — the upgrade path,
an existing data repo whose commits are old) holds the grace:
quiet while inside the threshold, an alert once older. An
unreadable stamp alerts immediately: torn bytes must never read
as fresh.

Reads the stamp file and (only when it is missing) the newest git
commit date and the install anchor; writes nothing. The launchd
registration
com.kwiki.watchdog (setup-schedule --watchdog) runs this door
hourly.

Exits 0 on a fresh (or in-grace) heartbeat, 1 on stale, unreadable,
missing-past-grace, quota-skipped ticks persisting past the
threshold, or skipping with no successful cycle on record.`;
