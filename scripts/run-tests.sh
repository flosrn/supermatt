#!/bin/sh
# Usage: run-tests.sh               run the test suite as CI does
#        run-tests.sh --pre-push    the pre-push hook: read git's ref lines on stdin, skip when every pushed tree already passed
#
# A green run on a clean worktree adds "<tree> <node --version> <command blob id>" to supermatt-test-runs in the
# repository's common Git directory, shared by its worktrees, once per entry. The pre-push hook skips when the tree of
# every commit a ref is pushed to has an entry with the same node version and test command (a push that only deletes refs
# has none to check); any difference, or no ref line at all, means a full run. That run tests this worktree, not the pushed
# commits: it names each destination ref whose pushed commit is not the checked-out one, and CI tests those. A red run,
# a run that starts or ends with changes Git knows of (untracked files, sparse or assume-unchanged entries included), and a
# run that ends on another HEAD tree record nothing, and nothing ever removes an entry. A change made and undone while the
# suite runs goes unseen.
# SUPERMATT_TEST_COMMAND replaces the suite command; tests/run-tests.test.sh uses it to stand in for the suite.
set -eu
cd "$(git rev-parse --show-toplevel)"
command="${SUPERMATT_TEST_COMMAND:-for t in tests/*.test.sh; do sh \"\$t\" || exit 1; done && node --test tests/*.test.mjs}"
record="$(git rev-parse --path-format=absolute --git-common-dir)/supermatt-test-runs"

if [ "${1:-}" = --pre-push ]; then
  refs="$(cat)"
  # The second field of each line is the pushed commit, all zeros when the line deletes a ref.
  if [ -n "$refs" ] && ! printf '%s\n' "$refs" | cut -d ' ' -f 2 | grep -q '[^0]'; then
    echo "run-tests: the push only deletes refs: skipping the suite."
    exit 0
  fi
fi

node="$(node --version)"
key="$node $(printf '%s' "$command" | git hash-object --stdin)"
# Succeeds when tree $1 already passed with this command and node version.
recorded() { grep -qxF "$1 $key" "$record" 2>/dev/null; }

tree="$(git rev-parse 'HEAD^{tree}')"
head="$(git rev-parse HEAD)"

if [ "${1:-}" = --pre-push ]; then
  missing=
  elsewhere=
  while read -r _ sha ref _; do
    case "$sha" in *[!0]*) ;; *) continue ;; esac
    [ "$(git rev-parse "$sha^{commit}" 2>/dev/null)" = "$head" ] || elsewhere="$elsewhere $ref"
    pushed="$(git rev-parse "$sha^{tree}" 2>/dev/null)" || pushed=
    recorded "$pushed" || missing=1
  done <<EOF
$refs
EOF
  if [ -n "$refs" ] && [ -z "$missing" ]; then
    echo "run-tests: every pushed tree already passed: skipping the suite."
    exit 0
  fi
  for ref in $elsewhere; do
    echo "run-tests: $ref is not the checked-out commit: the suite runs on this worktree, not on it, and CI tests it."
  done
fi

# Prints every way the worktree may differ from HEAD's tree: what status shows, untracked files whatever
# status.showUntrackedFiles says, and the index entries status hides (skip-worktree, as in a sparse checkout, and
# assume-unchanged). Fails when Git cannot tell.
changes() {
  git status --porcelain --untracked-files=all || return
  index="$(git ls-files -v)" || return
  printf '%s\n' "$index" | grep -v '^H ' || :
}

before="$(changes)"
sh -c "$command"
after="$(changes)"
if [ -n "$before" ] || [ -n "$after" ] || [ "$(git rev-parse 'HEAD^{tree}')" != "$tree" ]; then
  echo "run-tests: the worktree has uncommitted changes or changed during the run: this run is not recorded."
elif ! recorded "$tree"; then
  echo "$tree $key" >> "$record"
fi
