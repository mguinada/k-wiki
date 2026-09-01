#!/bin/bash
# Dress rehearsal for the scheduled board triage (issue #209's
# acceptance procedure, preserved as the re-verification runbook).
#
# Builds a scratch board — a standing scratch repo (the keyring token
# has no delete_repo scope) plus a scratch user project whose Status
# field carries the board's exact lanes — places one issue in every
# contract state, then runs dev/board-triage.ts against it and checks:
#
#   - the dry run plans moves but writes nothing
#   - every lane verdict (plain -> Ready, research stays, open-blocked
#     stays, open PR -> In progress, closed -> Done from Backlog and
#     from In progress, already-Ready untouched, closed-Done untouched)
#   - the report's evidence lines
#   - the Ready lane's pre-existing order is preserved and no position
#     mutation is ever sent (a mover enters at GitHub's default top)
#   - a second run plans zero moves (idempotency)
#
# Usage: run from the repo root with the gh keyring login (project
# scope; a local GITHUB_TOKEN is stripped per AGENTS.md):
#   bash dev/rehearse-board-triage.sh
#
# GraphQL secondary rate limits bite on burst polling: the script
# spaces its calls, retries the project-add (eventually consistent,
# ~2-4s), and backs off 90s if a CLI run is rate-limited. Cleanup on
# exit deletes the scratch project and closes scratch issues; the
# scratch repo itself must be removed by hand (web UI or
# `gh auth refresh -s delete_repo`).
set -euo pipefail

REPO=mguinada/k-wiki-triage-rehearsal
GHU="env -u GITHUB_TOKEN gh"
PASS=0
FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); say "FAIL: $*"; }
check(){ if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3 (want $2, got $1)"; fi; }

cleanup() {
  if [ -n "${PROJ_N:-}" ]; then
    $GHU project delete "$PROJ_N" --owner mguinada >/dev/null 2>&1 || true
  fi
  for n in $($GHU issue list --repo "$REPO" --state open --limit 100 --json number --jq '.[].number'); do
    $GHU issue close "$n" --repo "$REPO" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

PROJ_N=""

# --- scratch repo (standing fixture) ----------------------------------
for n in $($GHU issue list --repo "$REPO" --state open --limit 100 --json number --jq '.[].number'); do
  $GHU issue close "$n" --repo "$REPO" >/dev/null
done
sleep 1
$GHU label create research --repo "$REPO" >/dev/null 2>&1 || true

issue() { $GHU issue create --repo "$REPO" --title "$1" --body rehearsal ${2:+--label "$2"} | grep -oE '[0-9]+'; }
I_PLAIN=$(issue "plain unblocked")
I_RESEARCH=$(issue "research labeled" research)
I_BLOCKED=$(issue "blocked by open")
I_BLOCKER=$(issue "the open blocker")
I_CLOSED_BLOCKER=$(issue "the closed blocker")
I_PRREF=$(issue "has an open PR")
I_CLOSED_BACKLOG=$(issue "closed while on backlog")
I_READY1=$(issue "already ready one")
I_READY2=$(issue "already ready two")
I_CLOSED_PROG=$(issue "closed while in progress")
I_CLOSED_DONE=$(issue "closed already done")

$GHU issue close "$I_CLOSED_BLOCKER" --repo "$REPO" >/dev/null
$GHU issue close "$I_CLOSED_BACKLOG" --repo "$REPO" >/dev/null
$GHU issue close "$I_CLOSED_PROG" --repo "$REPO" >/dev/null
$GHU issue close "$I_CLOSED_DONE" --repo "$REPO" >/dev/null
$GHU issue edit "$I_BLOCKED" --repo "$REPO" --add-blocked-by "$I_BLOCKER" >/dev/null
$GHU issue edit "$I_PLAIN" --repo "$REPO" --add-blocked-by "$I_CLOSED_BLOCKER" >/dev/null

# An open PR referencing I_PRREF (cross-referenced event, state OPEN).
for n in $($GHU pr list --repo "$REPO" --head pr-branch --json number --jq '.[].number'); do
  $GHU pr close "$n" --repo "$REPO" --delete-branch >/dev/null 2>&1 || true
done
rm -rf /tmp/k-wiki-triage-rehearsal
git clone -q "git@github.com:$REPO.git" /tmp/k-wiki-triage-rehearsal
cd /tmp/k-wiki-triage-rehearsal
git config user.email rehearsal@local
git config user.name rehearsal
echo "note $(date +%s)" > note.txt
git add note.txt
git commit -qm note
git push -q origin main
git checkout -qb pr-branch
echo "more $(date +%s)" >> note.txt
git commit -qam more
git push -q origin pr-branch
$GHU pr create --repo "$REPO" --head pr-branch --title "Rehearsal PR" --body "Closes #$I_PRREF" >/dev/null 2>&1 ||
  { say "FAIL: could not create the rehearsal PR"; exit 1; }
PR_N=$($GHU pr list --repo "$REPO" --head pr-branch --json number --jq '.[0].number')
cd - >/dev/null

# --- scratch project with the board's Status lanes ---------------------
PROJ_JSON=$($GHU project create --title "k-wiki triage rehearsal" --owner @me --format json)
PROJ_N=$(printf '%s' "$PROJ_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["number"])')
PROJ_ID=$(printf '%s' "$PROJ_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
say "scratch project $PROJ_N ($PROJ_ID)"

# The board's Status lanes on the scratch project's Status field: the
# built-in field cannot be deleted or duplicated ("Only custom fields
# can be deleted"), but updateProjectV2Field rewrites its options —
# every option needs name AND color AND description.
FIELD_ID=$($GHU project field-list "$PROJ_N" --owner mguinada --format json --jq '.fields[] | select(.name == "Status") | .id')
$GHU api graphql -f query="mutation(\$f: ID!) { updateProjectV2Field(input: {fieldId: \$f, singleSelectOptions: [{name: \"Backlog\", color: GRAY, description: \"\"}, {name: \"Ready\", color: GREEN, description: \"\"}, {name: \"In progress\", color: BLUE, description: \"\"}, {name: \"In review\", color: YELLOW, description: \"\"}, {name: \"Done\", color: PURPLE, description: \"\"}]}) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }" -f f="$FIELD_ID" >/dev/null
sleep 1
OPT() { $GHU project field-list "$PROJ_N" --owner mguinada --format json --jq ".fields[] | select(.name == \"Status\") | .options[] | select(.name == \"$1\") | .id"; }

# --- place items --------------------------------------------------------
# gh issue edit --add-project takes the project TITLE and is eventually
# consistent (~2-4s), so retry the add and poll for the item.
lane() { # lane <issue> <lane>
  local item=""
  for _attempt in 1 2 3; do
    $GHU issue edit "$2" --repo "$REPO" --add-project "k-wiki triage rehearsal" >/dev/null 2>&1 || true
    sleep 4
    for _ in 1 2 3 4 5 6; do
      item=$($GHU project item-list "$PROJ_N" --owner mguinada --format json --limit 100 --jq ".items[] | select(.content.number == $2) | .id" | head -1)
      [ -n "$item" ] && break
      sleep 2
    done
    [ -n "$item" ] && break
  done
  if [ -z "$item" ]; then
    bad "item for issue #$2 never appeared on the project"
    return 1
  fi
  $GHU project item-edit --project-id "$PROJ_ID" --id "$item" --field-id "$FIELD_ID" --single-select-option-id "$(OPT "$1")" >/dev/null
  say "#$2 -> $1"
}
lane Backlog "$I_PLAIN"
lane Backlog "$I_RESEARCH"
lane Backlog "$I_BLOCKED"
lane Backlog "$I_PRREF"
lane Backlog "$I_CLOSED_BACKLOG"
lane Ready "$I_READY1"
lane Ready "$I_READY2"
lane "In progress" "$I_CLOSED_PROG"
lane Done "$I_CLOSED_DONE"

SNAPSHOT_FILE=$(mktemp)
BEFORE_BACKLOG=$($GHU project item-list "$PROJ_N" --owner mguinada --format json --limit 100 --jq '[.items[] | select(.status == "Backlog") | .content.number] | sort | join(",")')
READY_ORDER_BEFORE=$($GHU project item-list "$PROJ_N" --owner mguinada --format json --limit 100 --jq '[.items[] | select(.status == "Ready") | .content.number] | join(",")')
say "baseline: backlog=[$BEFORE_BACKLOG] ready-order=[$READY_ORDER_BEFORE]"

lane_of() { jq -r --argjson n "$1" '.items[] | select(.content.number == $n) | .status' "$SNAPSHOT_FILE"; }

# --- dry run: zero writes ----------------------------------------------
sleep 10
DRY=$(node dev/board-triage.ts --dry-run --owner mguinada --project "$PROJ_N" || true)
if echo "$DRY" | grep -q "rate limit"; then say "rate-limited; waiting 90s"; sleep 90; DRY=$(node dev/board-triage.ts --dry-run --owner mguinada --project "$PROJ_N"); fi
echo "$DRY"
$GHU project item-list "$PROJ_N" --owner mguinada --format json --limit 100 > "$SNAPSHOT_FILE"
check "$(lane_of "$I_PLAIN")" Backlog "dry run wrote nothing (I_PLAIN still Backlog)"

# --- the real run -------------------------------------------------------
sleep 5
OUT=$(node dev/board-triage.ts --owner mguinada --project "$PROJ_N" || true)
if echo "$OUT" | grep -q "rate limit"; then say "rate-limited; waiting 90s"; sleep 90; OUT=$(node dev/board-triage.ts --owner mguinada --project "$PROJ_N"); fi
echo "$OUT"
$GHU project item-list "$PROJ_N" --owner mguinada --format json --limit 100 > "$SNAPSHOT_FILE"

check "$(lane_of "$I_PLAIN")" Ready "plain unblocked -> Ready"
check "$(lane_of "$I_RESEARCH")" Backlog "research stays Backlog"
check "$(lane_of "$I_BLOCKED")" Backlog "open-blocked stays Backlog"
check "$(lane_of "$I_PRREF")" "In progress" "open PR -> In progress"
check "$(lane_of "$I_CLOSED_BACKLOG")" Done "closed on Backlog -> Done"
check "$(lane_of "$I_READY1")" Ready "already-Ready untouched"
check "$(lane_of "$I_CLOSED_PROG")" Done "closed In progress -> Done"
check "$(lane_of "$I_CLOSED_DONE")" Done "closed Done untouched"

READY_ORDER_AFTER=$(jq -r '[.items[] | select(.status == "Ready") | .content.number] | join(",")' "$SNAPSHOT_FILE")
check "$READY_ORDER_AFTER" "$I_PLAIN,$READY_ORDER_BEFORE" "Ready order: existing pair keeps its relative order, mover enters at GitHub's default top position (no position mutation is ever sent)"

echo "$OUT" | grep -q "#$I_PRREF Backlog → In progress — open PR #$PR_N" && ok "PR move line with evidence" || bad "PR move line with evidence"
echo "$OUT" | grep -q "#$I_RESEARCH stays Backlog — research label" && ok "research stay line with reason" || bad "research stay line with reason"

# --- idempotency --------------------------------------------------------
sleep 5
SECOND=$(node dev/board-triage.ts --owner mguinada --project "$PROJ_N")
echo "$SECOND"
check "$(echo "$SECOND" | tail -1 | grep -oE '[0-9]+ moves')" "0 moves" "second run plans zero moves"

# --- verdict ------------------------------------------------------------
say "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
