/**
 * scheduled-run's help text (AGENTS.md CLI rule: every switch,
 * argument, and default). Extracted from the wrapper; a static
 * string with no logic of its own.
 */

export /** Help text: every switch and default (AGENTS.md CLI rule). */
const HELP = `Usage: scheduled-run [-h | --help] [--lint-full] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]

Run one unattended pipeline cycle — the command the
launchd job executes every interval. The wrapper is portable Node:
lockfile → git pull --rebase → (with --lint-full: wiki-lint --full,
the weekly quality sweep) → wiki-sync (sync → ingest → lint →
crosslinks → citation wall → verification → commit) → git push.
wiki-sync stays commit-only; the push happens here and only here.

  --lint-full         Run the full-lint sweep before the cycle:
                      wiki-lint --full — every page, the complete
                      check list — then the ordinary wiki-sync flow
                      (verification, commit, publish; ingest usually
                      a no-op). The sweep runs under the same run
                      lock: a concurrent 30-minute cycle makes this
                      firing refuse loud naming the holder, and vice
                      versa. Registered weekly by setup-schedule
                      --calendar (Sundays 03:00 by default); run it
                      by hand for one sweep now.
  --settings <path>  Forwarded to wiki-sync. Default: the repo's
                     settings.yml.
  --outputs <dir>    Forwarded to wiki-sync (ingest digest location).
                     Default: the repo's outputs/.
  --timeout <secs>   Forwarded to wiki-sync. Default: 1800. With
                     --lint-full, one explicit value sets both the
                     cycle's and the sweep's budget; the defaults
                     stay 1800 (the cycle) and 7200 (the sweep).
  -h, --help         Print this help and exit; no side effects.
  <config>           Forwarded to wiki-sync. Default: the repo's
                     sync.json.
  <raw-dir>          Forwarded to wiki-sync. Default: <dataRoot>/raw.

Behavior, failure mode by failure mode:
  - Overlap (same machine): an O_EXCL lockfile at
    <dataRoot>/.scheduled-run.lock (PID + timestamp) prevents
    concurrent runs; a lock older than four hours is taken over, so
    a killed run never wedges the schedule. The lock is shared with
    manual wiki-sync runs: whichever cycle is in progress makes the
    other skip (scheduled firings) or fail loud (manual runs). The
    file lives at the data repo root — outside wiki-sync's
    wiki/raw/outputs commit pathspecs — so the sync can never
    commit or stage it.
  - Overlap (across machines): prevented in shared-writer mode (the
    data repo carries .k-wiki/shared-writer.json — the coordinator
    serializes through the remote lease). Without the marker it is
    not prevented — recovered: the pre-run git pull --rebase keeps
    the run on a fresh base; a push rejection
    gets one pull --rebase + retry; a second failure logs an ALERT
    line and exits 1.
  - Shared-writer mode: the wrapper keeps its schedule, logs,
    heartbeat, and local run lock and delegates the remote work to
    the same coordinator manual wiki-sync runs — no pull, no push.
    Proposed removals/renames fail before raw/ is mutated; a
    scheduled run can never supply --removal-receipt (rejected as
    an unknown flag before any cycle work) and never expunges.
  - No origin: the data repo must have an origin remote (the push
    stage needs one); the wrapper fails loud without running.
  - wiki-sync failure: the guardrails and verification have already
    reverted the run — the wiki stays at the last good commit, the
    error and digest land in the log, exit 1; the next interval is
    the recovery (no retry/backoff by design). A --lint-full sweep
    failure fails the same way, and the next firing retries it.
  - Dirty tree: a failed or killed sync leaves its edits uncommitted
    on purpose (the fix surface). The next tick skips its pre-run
    pull — a rebase refuses a dirty tree — so that recovery stays
    reachable; the push-rejection path owns any divergence that
    follows.
  - Logs: ~/Library/Logs/k-wiki/scheduled-run.log (rotated at
    5 MiB, one previous generation kept); wiki-sync's digest and
    progress stream into the same file. KWIKI_SCHEDULED_LOG overrides
    the log path (tests and multi-instance setups).
  - Heartbeat: every completed cycle (ok or failed) writes the stamp
    outputs/last-cycle.json in the data repo — timestamp, outcome,
    holder PID, and the last ok cycle's timestamp — kept out of git
    via .git/info/exclude. The sync-watchdog door and the dashboard's
    last-cycle row read it; a skipped tick (lock held) writes
    nothing, and the stamp never changes the cycle's outcome.
  - Notifications: an ALERT (cycle failed, push failed after its
    one retry) also fires a macOS notification (osascript), and the
    independent com.kwiki.watchdog launchd job (installed by
    setup-schedule --watchdog) alerts when the heartbeat goes stale,
    missing, or unreadable — failures reach the screen, not only a
    log. KWIKI_NOTIFY=0 disables every notification.

Exits 0 on a completed or skipped cycle, 1 on failure.`;
