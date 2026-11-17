#!/bin/sh
# Usage: run-tests.sh               run the test suite as CI does
#        run-tests.sh --pre-push    the pre-push hook: read git's ref lines on stdin, skip when every pushed tree already passed
#
# A green run on a clean worktree appends "<tree> <node --version> <command blob id>" to supermatt-test-runs in the
# repository's common Git directory, shared by its worktrees. The pre-push hook skips only when the tree of every commit
# a ref is pushed to has an entry with the same node version and test command; any difference means a full run. A red run, or a run on a
# worktree with uncommitted changes, records nothing, and nothing ever removes an entry.
# SUPERMATT_TEST_COMMAND replaces the suite command; tests/run-tests.test.sh uses it to stand in for the suite.
set -eu
cd "$(git rev-parse --show-toplevel)"
command="${SUPERMATT_TEST_COMMAND:-for t in tests/*.test.sh; do sh \"\$t\" || exit 1; done && node --test tests/*.test.mjs}"
record="$(git rev-parse --path-format=absolute --git-common-dir)/supermatt-test-runs"
key="$(node --version) $(printf '%s' "$command" | git hash-object --stdin)"

if [ "${1:-}" = --pre-push ]; then
  untested=1
  while read -r _ sha _ _; do
    case "$sha" in *[!0]*) ;; *) continue ;; esac
    grep -qxF "$(git rev-parse "$sha^{tree}") $key" "$record" 2>/dev/null || { untested=1; break; }
    untested=
  done
  if [ -z "$untested" ]; then
    echo "run-tests: the pushed tree already passed: skipping the suite."
    exit 0
  fi
fi

tree="$(git rev-parse 'HEAD^{tree}')"
dirty="$(git status --porcelain)"
sh -c "$command"
if [ -n "$dirty" ]; then
  echo "run-tests: the worktree has uncommitted changes: this run is not recorded."
else
  echo "$tree $key" >> "$record"
fi
