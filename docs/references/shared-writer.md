# Shared-writer mode

The multi-machine coordination protocol for a remote-backed data repo
(issue #390). Enable it once per data repo; every compliant writer on
every machine then serializes through one remote lease. Read this
before enabling, and run the two-Mac acceptance script
(`two-mac-acceptance.sh`, same directory) after cutover.

## The marker

`.k-wiki/shared-writer.json` at the data repo root, schema v1:

```json
{
  "version": 1,
  "remote": "origin",
  "branch": "main",
  "leaseRef": "refs/k-wiki/leases/shared-writer-v1",
  "sourceRemovalPolicy": "confirm"
}
```

The marker is operator-owned (`k-wiki enable-shared-writer` is the
only writer) and tracked — the policy is visible in every checkout.
There is no per-machine switch to forget: a repo without the marker
keeps the local/no-remote behavior; a repo with it runs the shared
protocol for manual `wiki-sync` and `scheduled-run` alike. The marker
contains no hostname, path, or scheduler identity — any current
checkout can hold the write.

`k-wiki enable-shared-writer` is idempotent: if a valid marker is
already present, or arrives when the command fast-forwards the branch,
it exits successfully without a capability probe, commit, or lease
operation. An invalid marker fails closed.

## The lease lifecycle

The lease is the ref `refs/k-wiki/leases/shared-writer-v1` on the
configured remote, pointing at a synthetic commit (tree = the remote
branch's tree, no parent) whose message carries protocol version,
token, holder, acquired, expires, base remote SHA, and renewal count.
Lease commits never enter branch history.

1. **Acquire** — after a fetch, a plain push creates the absent ref.
   The create is a compare-and-swap: a racing second creator loses
   the non-fast-forward check and refuses, naming the live holder and
   expiry, before touching `raw/` or `wiki/`.
2. **Renew** — before and after every long agent stage and before
   finalization: same token, expiry extended, renewal count +1,
   replaced by exact expected OID. A lost renewal race aborts the
   cycle before its final push.
3. **Expire-take-over** — only an expired, observed lease is replaced
   automatically, quoting its exact OID; the replacement has no
   unlocked gap. A live lease refuses every writer.
4. **Finalize** — after the content commit, one atomic push advances
   the branch and deletes the exact owned lease; the deletion is
   fenced by the owner's lease OID, so a stale owner's replayed
   finalize fails. The remote branch head is verified afterwards.
5. **No-op release** — a cycle with nothing to do conditionally
   deletes the exact owned lease after fresh verification.

Default TTL: four hours, matching the local run lock. Observation is
always `git ls-remote` (or an explicit custom-ref fetch refspec) — a
default `git fetch` cannot make a live lease invisible, and the
protocol never relies on it.

## Failure rules

| Situation | Behavior |
|---|---|
| Lease held and live | Refuse before writes; report holder + expiry |
| Clean pre-write/config failure | Conditionally release own lease |
| Agent/guardrail failure with dirty fix surface | Retain lease; fail loud |
| Push rejected or result uncertain | Retain lease; verify on recovery |
| Process crash | Lease remains until expiry; next writer takes over |
| Stale owner wakes after takeover | Its fenced final push fails |
| Dirty/ahead/diverged local repo | Fail before source scan |
| Unsupported remote | Enable refuses; shared run fails loud |
| Malformed marker/lease | Fail closed before source scan |
| Renewal CAS race lost | Abort before final push |
| Failure once the content commit exists | Retain the lease; the commit is local-only — recover by manual push or takeover |
| Final push response lost | Recognize success only when the expected branch head is remote and the lease is absent; otherwise retain |
| Removal/rename without a matching receipt | Fail before `raw/` mutation or expunge |

A retained lease is a bounded availability pause (at most the TTL),
not a deadlock. Safety wins over premature release.

## Source-removal receipts

The lease serializes data-repo writers; it cannot prove an arbitrary
Mac's iCloud view of the source vault is current. In shared mode a
proposed source removal or rename stops the cycle before `raw/` is
mutated: the coordinator plans the candidate set, anchors it to the
canonical remote SHA it holds the lease under, writes
`outputs/shared-writer-receipt.json` (per-machine, git-excluded),
prints it, and fails. The candidate set covers the cycle's whole
removal surface: per-note removals and renames of configured vaults,
and the expunge of any stale namespace — a namespace the manifest or
`raw/notes/` holds that the config no longer lists — planned as the
individual paths its prune would delete. A human reruns the cycle with
`wiki-sync --removal-receipt <path>`; the coordinator re-validates —
the receipt dies if the remote advanced or the candidate set changed.
Either Mac may confirm once its vault view is current. Scheduled runs
cannot supply a receipt: they fail loud naming the confirmation
command and never silently expunge.

## The honest limits

- **No raw-Git bypass protection.** GitHub cannot install custom
  receive hooks. The protocol is ironclad between updated compliant
  `k-wiki` writers; an old binary or a raw manual `git push` to the
  branch bypasses the lease entirely. Server-enforced protection
  needs a later controlled writer or a remote with receive hooks.
- **The confirm-then-apply window.** The removal-receipt gate
  validates the candidate set once, at gate time — before the
  optional `--lint-full` sweep and the sync stage's fresh re-plan. A
  source removal that lands in that window (a vault edit or another
  device's iCloud sync) is applied to `raw/` on the same cycle
  without a new confirmation: the sync stage re-plans from the vault
  as it finds it. The race is inherent to confirm-then-apply —
  iCloud offers no subscription a held lease could freeze the view
  against — so the receipt's guarantee holds at gate time, not at
  apply time. A cycle that expunges such a removal matched the vault
  as of its scan; the next cycle re-plans the same way.
- **Manual shared cycles push by design.** Enabling the marker is the
  operator's consent to unattended-style pushes from manual runs.
- **Accidental dual scheduling** is safe but inefficient: one
  machine's cycle holds the lease; the other exits before source
  scan or agent invocation. One enabled scheduler at a time is still
  the recommendation.

## Cutover procedure

1. Quiesce: uninstall the scheduler on every old machine
   (`k-wiki setup-schedule --uninstall`); let any in-flight cycle
   finish (its local lock and the remote lease must clear —
   `k-wiki writer-lease status` shows both).
2. Deploy the updated k-wiki checkout to every writer machine.
3. Enable once, from one clean, current data repo:
   `k-wiki enable-shared-writer`. The command verifies cleanliness,
   probes the remote's capabilities with disposable refs, acquires
   the bootstrap lease, commits the marker, and pushes marker + lease
   release atomically.
4. Bootstrap each machine: fetch and run one cycle (or let the
   schedule do it) — the first cycle fast-forwards and re-baselines
   the ingest snapshot from the canonical tree, so nothing another
   machine already ingested is ingested again.
5. Re-enable the scheduler on the chosen machine(s). Run the
   two-Mac acceptance script before declaring cutover done.

## Scheduler handoff (no data migration)

Handing the schedule from machine A to machine B needs no marker or
data migration: uninstall on A, wait for A's local lock and the
remote lease to clear, verify B's checkout is clean and current
(`git fetch` + `git status`), then install on B. Shared mode makes
the overlap window safe in both directions: whichever cycle is
mid-flight holds the lease; every other writer exits before source
scan. Run the acceptance script's A→B and B→A halves after any
handoff.
