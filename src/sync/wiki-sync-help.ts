/**
 * wiki-sync's help text (AGENTS.md CLI rule: every switch,
 * argument, and default). Extracted from the orchestrator (issue
 * #390's shared-writer integration needed the line budget); a static
 * string with no logic of its own.
 */

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
export const HELP = `Usage: wiki-sync [-h | --help] [--settings <path>] [--outputs <dir>] [--timeout <secs>] [<config>] [<raw-dir>]

Run the whole cycle in one command:
sync (sync-vault for vault sources, sync-repo for repo sources) →
wiki-ingest → headless lint (windowed by default:
prompts/lint-window.md over the pages changed since the last audit
plus their reverse-link neighbors; a missing snapshot or a first run
audits everything, prompts/lint.md) →
crosslink audit (configured second brains) → citation wall
(one-way sandbox check — rogue edges are path-scoped-reverted,
never committed) → verification (check-fidelity +
check-provenance) → one data-repo commit → mirror publish
(configs with a publish section). Every stage stays independently
runnable for debugging; this command only chains them.

  --settings <path>  Agent settings file (command, model, provider,
                     reasoning) for both agent stages — ingest and
                     lint — and the optional secondBrain.domains list
                     of the crosslink stage. Provider is optional.
                     isolate (true by default, false to opt out) adds
                     the pi isolation flags --no-context-files
                     --no-extensions --no-skills to both agent runs
                     so global agent config cannot leak in.
                     isolate.skills and isolate.extensions
                     (optional comma-separated lists)
                     whitelist specific entries back in: one --skill
                     flag per skill dir (resolved against the
                     settings file's directory) and one -e flag per
                     extension source (a path, npm:<package>, or
                     git:<repo>). A missing entry warns and is
                     omitted; both keys are ignored with isolate:
                     false.
                     Default: the repo's settings.yml.
  --outputs <dir>    Where the ingest digest (runs/<timestamp>.md) goes.
                     Default: the repo's outputs/. The manifest snapshot
                     always lives in the data repo's outputs/ and is not
                     moved by this switch.
  --timeout <secs>   Kill either agent run after this many seconds
                     and fail the cycle. Default: 1800 (30 minutes).
  --removal-receipt <path>
                     Shared-writer mode only: the source-removal
                     receipt a previous refused cycle wrote (outputs/
                     shared-writer-receipt.json in the data repo),
                     confirming the planned removals/renames. Refused
                     outside shared-writer mode.
  -h, --help         Print this help and exit; no side effects.
  <config>           Path to sync.json (vault sources) or a
                     repo-sourced config such as sync-meta.json
                     (source: "repo"). Default: the repo's own
                     sync.json.
  <raw-dir>          raw/ directory; its parent is the data repo the
                     agents run in and the commit lands in. Default:
                     <dataRoot>/raw from the config, otherwise the
                     repo's own raw/.

What it does, stage by stage:
  1. sync — vault configs: sync-vault projects the vaults into raw/
     (deterministic). Repo-sourced configs (source: "repo", e.g.
     sync-meta.json) run the sync-repo core instead: the allowlisted
     files of the committed source tree are projected verbatim into
     raw/notes/<name>/, stamped with the source HEAD commit; tracked
     changes or untracked-selectable files fail the cycle (commit
     first). Mixed vault+repo configs are refused — one instance per config.
  2. ingest — wiki-ingest: run the wiki agent over the changed
     sources, guardrail-check it (auto-revert on failure), and write
     the digest to the code repo's outputs/runs/ (gitignored).
  3. lint — the windowed quality audit: prompts/
     lint-window.md over the pages changed since the last successful
     lint (a missing snapshot means a full audit, prompts/lint.md)
     plus their one-hop reverse-link neighbors, the deterministic
     worklists embedded; the report lands in the DATA repo's
     outputs/ and is committed with the cycle; the
     outputs/lint-window.json snapshot (excluded via the data
     repo's .git/info/exclude) advances only after a
     completed audit, so a failed or timed-out lint retries its
     window next cycle. Same guardrails and auto-revert as the
     ingest stage; the weekly whole-wiki sweep (including the
     global report-only checks) is scheduled by setup-schedule
     --calendar.
  4. crosslinks — only for instances whose settings carry a
     secondBrain.domains list ([<wiki dirs>], comma-separated,
     brackets optional): run the check-crosslinks audit of the data
     repo's wiki/ against every listed domain wiki — every cycle,
     including no-change cycles. One broken or forbidden
     [[<vault>/<page>]] link fails the cycle before the commit
     (nothing reverts; the uncommitted diff is the fix surface).
     Instances without the key skip the stage.
  5. citation wall — the one-way sandbox audit over the working
     tree, every cycle: main pages never link, embed, or cite
     wiki/sandbox/ pages, sandbox pages never carry sources edges
     or cross-wiki links, and via: agent lives only inside the
     sandbox. A violation fails the cycle after path-scoped-
     reverting every offending page (never a whole-repo reset).
  6. verification — run the deterministic check-fidelity and
     check-provenance cores over the data
     repo's wiki/ and raw/ — every cycle, including no-change
     cycles, no configuration. One problem line per finding fails
     the cycle before the commit: the lint edits are reverted (the
     ingest edits stay, uncommitted, as the fix surface), mirroring
     the lint stage's failure semantics, and the command exits 1.
  7. commit — stage wiki/, raw/, and outputs/ in the data repo and
     commit with a message summarizing sources processed and pages
     touched.
  8. publish — only for configs whose sync.json carries a publish
     section: copy the data repo's
     include-matched files (["wiki/**"] in the shipped config) into the
     mirror vault — an iCloud-served disposable reading copy for
     iPhone and iPad. With publish.root set ("wiki" in the shipped
     config) the top-level segment is stripped from every
     mirror path, so the wiki tree appears at vault root; without it
     the copy is verbatim. Deletions included: a page gone from the wiki
     is removed from the mirror; the mirror's own .obsidian/ device
     state is never touched; byte-identical files are never
     rewritten, so a second run over an intact mirror changes
     nothing (idempotent). Runs after the commit, every cycle —
     a mirror the transport mangled is healed by the next run. A
     publish failure fails the cycle (exit 1) after the commit has
     landed; the next run retries the copy. Instances without the
     publish section skip the stage.

With no changed sources the agent stages skip (cost scales with
activity, not the clock), a clean data repo commits nothing, and the
command exits 0; the citation wall, a configured crosslink audit,
and the verification checks still run. A failed previous ingest is retried even when sync
reports no changes — the skip keys on the manifest snapshot, which a
failed run leaves untouched. A failure at any stage stops the chain
and exits 1; a tripped guardrail has already reverted its agent run,
and a verification failure has reverted the lint edits.

Shared-writer mode: when the data repo carries the operator-owned
marker .k-wiki/shared-writer.json, this command serializes through a
remote lease on the configured origin: it refuses a dirty, ahead, or
diverged checkout before any scan, acquires the lease (taking over
only an expired one by exact OID), fast-forwards to the canonical
remote tree, re-baselines the ingest snapshot from that tree, and —
after the stages and the content commit — advances the branch and
releases the lease in one atomic push. Proposed source removals or
renames stop the cycle with a receipt file before raw/ is touched;
rerun with --removal-receipt to confirm. k-wiki writer-lease status
and k-wiki enable-shared-writer are the operator doors.

Run lock: the cycle acquires the shared run lock —
<dataRoot>/.scheduled-run.lock, the same lock scheduled-run holds —
before its first stage and releases it on every exit path (success,
failure, guardrail revert). When another run holds a fresh lock, the
command fails loud with one line naming the holder's start time and
PID — “a run has been in progress since HH:MM (PID N) — retry in a
few minutes” — instead of colliding at the git layer. A lock older
than four hours (a killed run) is taken over. The lock lives at the
data repo root, outside the commit pathspecs, so it is never
committed; one lock per data repo, so independent instances never
contend. A scheduled wrapper's child run reuses its parent's tenure
(KWIKI_RUN_LOCK_HELD) and does not re-acquire.

The final digest on stdout — sync summary, lint summary, the crosslink
audit (configured second brains), the fidelity and provenance results,
the commit hash, the publish summary (configured mirror), and the full
ingest digest — plus git log -1 in the data repo tell the whole story
of the run. On a cycle that did real work the same digest is committed
into the data repo as outputs/cycle-<YYYY-MM-DD>.md, in its own commit
naming the path (a same-day rerun overwrites); no-op cycles write and
commit nothing. The ingest prompt names that path so the agent's log
entry can cite it; a cycle failing after ingest still writes the file,
recording the failure. Live progress goes to stderr. Unattended
scheduling is setup-schedule.`;
