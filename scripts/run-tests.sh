#!/bin/sh
# Usage: run-tests.sh               run the test suite as CI does
#        run-tests.sh --pre-push    the pre-push hook: read git's ref lines on stdin, skip when every pushed tree already passed
#
# A green run on a clean worktree adds "<tree> <node --version> <command blob id>" to supermatt-test-runs in the
# repository's common Git directory, shared by its worktrees, once per entry. The pre-push hook skips only when the tree of
# every commit a ref is pushed to has an entry with the same node version and test command; any difference means a full run.
# That run tests this worktree, not the pushed commits: it names each pushed ref whose tree is not the checked-out one, and
# CI tests those. A red run, a run on a worktree with uncommitted changes, and a run during which HEAD or the worktree
# changes record nothing, and nothing ever removes an entry.
# SUPERMATT_TEST_COMMAND replaces the suite command; tests/run-tests.test.sh uses it to stand in for the suite.
set -eu
cd "$(git rev-parse --show-toplevel)"
command="${SUPERMATT_TEST_COMMAND:-for t in tests/*.test.sh; do sh \"\$t\" || exit 1; done && node --test tests/*.test.mjs}"
record="$(git rev-parse --path-format=absolute --git-common-dir)/supermatt-test-runs"
node="$(node --version)"
key="$node $(printf '%s' "$command" | git hash-object --stdin)"

tree="$(git rev-parse 'HEAD^{tree}')"

if [ "${1:-}" = --pre-push ]; then
  checked=
  missing=
  elsewhere=
  while read -r ref sha _ _; do
    case "$sha" in *[!0]*) ;; *) continue ;; esac
    checked=1
    pushed="$(git rev-parse "$sha^{tree}" 2>/dev/null)" || pushed=
    grep -qxF "$pushed $key" "$record" 2>/dev/null && continue
    missing=1
    [ "$pushed" = "$tree" ] || elsewhere="$elsewhere $ref"
  done
  if [ -n "$checked" ] && [ -z "$missing" ]; then
    echo "run-tests: the pushed tree already passed: skipping the suite."
    exit 0
  fi
  for ref in $elsewhere; do
    echo "run-tests: $ref is not the checked-out commit: the suite runs on this worktree, not on it, and CI tests it."
  done
fi

dirty="$(git status --porcelain)"
sh -c "$command"
if [ -n "$dirty" ] || [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse 'HEAD^{tree}')" != "$tree" ]; then
  echo "run-tests: the worktree has uncommitted changes or changed during the run: this run is not recorded."
elif ! grep -qxF "$tree $key" "$record" 2>/dev/null; then
  echo "$tree $key" >> "$record"
fi
