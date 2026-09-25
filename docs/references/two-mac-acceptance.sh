#!/usr/bin/env bash
# The post-cutover two-Mac acceptance script (issue #390): operator
# evidence that shared-writer mode serializes two real machines. This
# is acceptance evidence for the operator's own data repo and remote —
# it is not a replacement for the hermetic e2e suite, and it records
# the live enable-time remote capability-probe result.
#
# Usage (run on each machine as marked; every step is read-only or
# uses the protocol's own writes):
#
#   MACHINE=A ./two-mac-acceptance.sh <checkout-dir>
#   MACHINE=B ./two-mac-acceptance.sh <checkout-dir>
#
# Prerequisites: both machines have the updated k-wiki checkout, the
# data repo carries the shared-writer marker, and `k-wiki` resolves on
# PATH (or edit the KWIKI variable below).

set -euo pipefail

MACHINE="${MACHINE:?set MACHINE=A or MACHINE=B}"
CHECKOUT="${1:?usage: MACHINE=A|B $0 <checkout-dir>}"
KWIKI="${KWIKI:-k-wiki}"
DATA="$CHECKOUT/data"   # the data repo root inside the checkout

echo "== two-Mac acceptance — machine $MACHINE, checkout $CHECKOUT =="

echo "-- [probe record] shared-writer enablement state (records the"
echo "    enable-time capability-probe verdict: run"
echo "    'k-wiki enable-shared-writer' from a clean canonical checkout"
echo "    and keep this transcript if not already enabled):"
if [ -f "$DATA/.k-wiki/shared-writer.json" ]; then
  echo "    marker present: $(cat "$DATA/.k-wiki/shared-writer.json" | tr -d '\n')"
else
  echo "    FAIL: no marker at $DATA/.k-wiki/shared-writer.json"
  exit 1
fi

echo "-- [$MACHINE] lease status (records the live capability state):"
"$KWIKI" writer-lease status "$DATA/raw"

if [ "$MACHINE" = "A" ]; then
  echo "-- [A] starting a writer and holding the lease"
  echo "    (run the cycle you want to hold: an agent-bearing cycle with a"
  echo "     slow agent, or simply hold the run lock; while A's cycle runs,"
  echo "     execute the B half in a second terminal):"
  echo "    cd $CHECKOUT && $KWIKI wiki-sync data/sync.json data/raw"
  echo "    Keep this running until the B half has completed its checks,"
  echo "    then let it finish."
  echo "-- [A] after the cycle: expect exit 0, the digest on stdout."
  "$KWIKI" writer-lease status "$DATA/raw"
  echo "-- [A] done: lease released, remote head advanced."
  exit 0
fi

if [ "$MACHINE" = "B" ]; then
  echo "-- [B] while A holds the lease, prove the refusal happens BEFORE"
  echo "    any source scan or agent invocation (expect exit 1 and a"
  echo "    'lease ... live' line naming A's holder and expiry):"
  if "$KWIKI" wiki-sync "$DATA/sync.json" "$DATA/raw"; then
    echo "    FAIL: B's cycle ran while A held the lease"
    exit 1
  fi
  echo "    PASS: B refused while A held the lease."
  echo "-- [B] after A finishes: B fast-forwards and succeeds (expect"
  echo "    exit 0, and B's HEAD equals origin/main):"
  "$KWIKI" wiki-sync "$DATA/sync.json" "$DATA/raw"
  git -C "$DATA" fetch -q origin
  A_HEAD="$(git -C "$DATA" rev-parse origin/main)"
  B_HEAD="$(git -C "$DATA" rev-parse HEAD)"
  if [ "$A_HEAD" != "$B_HEAD" ]; then
    echo "    FAIL: B's HEAD ($B_HEAD) != origin/main ($A_HEAD)"
    exit 1
  fi
  echo "    PASS: B at $B_HEAD — same canonical main, no live lease:"
  "$KWIKI" writer-lease status "$DATA/raw"
  exit 0
fi

echo "FAIL: unknown MACHINE '$MACHINE'"
exit 1
