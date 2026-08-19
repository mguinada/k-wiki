#!/bin/sh
# Advisory mutation run, scoped to src files changed vs main (issue #21).
# Prints the changed-file list and exits 0 without running Stryker when
# no src/**/*.ts file differs from origin/main.
set -eu

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
