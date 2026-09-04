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
usage: dev/mutation-changed.sh [--full]
       (same as: npm run mutation:changed [--full])

Advisory StrykerJS mutation testing — a signal, never a gate.
Both modes end by printing the actionable mutants (Survived and
NoCoverage) from reports/mutation/mutation.json. Re-list the last
report any time with: npm run mutation:survivors

Default:  Mutate only the changed hunks of the src/*.ts files that
          differ from the mutation base (uncommitted work included),
          at hunk granularity: one file:start-end range per changed
          hunk (src/quality/mutation-scope.ts builds the list). New or
          untracked files mutate whole; deleted files are skipped.
          The base is $MUTATION_BASE when set, else the
          origin/main commit from $MUTATION_WINDOW_DAYS days ago when
          set, else origin/main. Runs capped at --concurrency 4 —
          scoped runs are small and the cap keeps sibling Stryker
          fleets from starving each other's test timeouts. Exits 0
          without running Stryker when no src file changed.

--full:   Mutate every file matched by stryker.config.json's mutate
          list (src/**/*.ts) — same as `npm run mutation`, at the
          default concurrency.

--help:   Print this help.
EOF
}

case "${1:-}" in
  --full)
    npx stryker run
    node dev/mutation-survivors.ts
    exit 0
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

# The base resolves once (flag > $MUTATION_BASE > $MUTATION_WINDOW_DAYS
# window > origin/main — src/quality/mutation-scope.ts owns the rule)
# and is printed so run logs name what was diffed against; the second
# call takes --base "$base" so the diffed base is exactly the logged
# one (a window base re-resolved at a later instant could differ).
# Plain two-endpoint diff (not base...HEAD): it includes uncommitted
# work, so the local run sees what the agent actually changed.
# src/quality/mutation-scope.ts turns that diff into hunk-range
# --mutate patterns.
base=$(node dev/mutation-scope.ts --print-base)
echo "Mutation base: $base"
patterns=$(node dev/mutation-scope.ts --base "$base")

if [ -z "$patterns" ]; then
  changed=$(git diff --name-only "$base" -- 'src/*.ts'; git ls-files --others --exclude-standard -- 'src/*.ts')

  if [ -z "$changed" ]; then
    echo "No src/ changes vs $base -- skipping mutation run."
  else
    echo "src/ changes carry no new-side lines (deletions only) -- nothing to mutate."
  fi

  exit 0
fi

echo "Mutating changed src hunks:"
printf '%s' "$patterns" | tr ',' '\n' | sed 's/^/  /'

# Stryker's --mutate takes one comma-separated list; unquoted $patterns
# would word-split into extra positional arguments.
npx stryker run --mutate "$patterns" --concurrency 4
node dev/mutation-survivors.ts
