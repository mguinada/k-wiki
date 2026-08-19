#!/bin/sh
# Advisory mutation run (issue #21).
#
# Default mode: mutate only the src/**/*.ts files changed vs origin/main
# (including uncommitted work); exits 0 without running Stryker when
# nothing changed. Full mode (--full): mutate everything the Stryker
# config's mutate list covers.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/mutation-changed.sh [--full]
       (same as: npm run mutation:changed [--full])

Advisory StrykerJS mutation testing — a signal, never a gate.

Default:  Mutate only the src/**/*.ts files changed vs origin/main,
          including uncommitted work. Exits 0 without running Stryker
          when no src file changed.

--full:   Mutate every file matched by stryker.config.json's mutate
          list (src/**/*.ts) — same as `npm run mutation`.

--help:   Print this help.
EOF
}

case "${1:-}" in
  --full)
    exec npx stryker run
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
esac

# origin/main, not local main: survives fresh clones and worktrees where
# the local branch is checked out elsewhere or missing. Plain two-endpoint
# diff (not `origin/main...HEAD`): it includes uncommitted work, so the
# pre-handoff run sees what the agent actually changed.
changed=$(git diff --name-only origin/main -- 'src/**/*.ts')

if [ -z "$changed" ]; then
  echo "No src/ changes vs origin/main -- skipping mutation run."
  exit 0
fi

echo "Mutating changed src files:"
echo "$changed" | sed 's/^/  /'

exec npx stryker run --mutate $changed
