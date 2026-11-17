#!/bin/sh
# Tests scripts/run-tests.sh in a fixture repository whose suite is a stand-in command.
set -eu
# A hook in a linked worktree exports an absolute GIT_DIR, which would aim every git command below at the real repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# A stand-in node whose version the cases choose.
mkdir "$TMP/bin"
printf '#!/bin/sh\necho "$FAKE_NODE_VERSION"\n' > "$TMP/bin/node"
chmod +x "$TMP/bin/node"
PATH="$TMP/bin:$PATH"
FAKE_NODE_VERSION=v1.0.0
export FAKE_NODE_VERSION

# The stand-in suite logs each run outside the worktree, so a run leaves the tree clean.
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'"
export SUPERMATT_TEST_COMMAND

git init -q -b main "$TMP/work"
cd "$TMP/work"
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
echo a > file
git add -A && git commit -q -m init

runs() { [ -f "$TMP/runs" ] && wc -l < "$TMP/runs" | tr -d ' ' || echo 0; }
# Feeds the pre-push hook the ref line git gives it for a push of a commit (default HEAD) to main.
pre_push() { echo "refs/heads/main $(git rev-parse "${1:-HEAD}") refs/heads/main 0000000000000000000000000000000000000000" | sh "$REPO/scripts/run-tests.sh" --pre-push; }

sh "$REPO/scripts/run-tests.sh" || fail "green run on a clean tree exited nonzero"
[ "$(runs)" = 1 ] || fail "the direct run did not run the suite once"
out="$(pre_push)" || fail "pre-push after a green run exited nonzero"
[ "$(runs)" = 1 ] || fail "pre-push ran the suite again for a tree that already passed"
case "$out" in *skip*) ;; *) fail "pre-push did not say it skips: $out" ;; esac

echo b > file && git commit -q -am change
pre_push > /dev/null || fail "pre-push of a changed tree exited nonzero"
[ "$(runs)" = 2 ] || fail "pre-push skipped a tree changed after the green run"
pre_push > /dev/null && [ "$(runs)" = 2 ] || fail "the pre-push run of a clean tree was not recorded"

FAKE_NODE_VERSION=v2.0.0
pre_push > /dev/null || fail "pre-push under another node exited nonzero"
[ "$(runs)" = 3 ] || fail "pre-push skipped a tree that passed under another node version"

SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'; true"
pre_push > /dev/null || fail "pre-push under another command exited nonzero"
[ "$(runs)" = 4 ] || fail "pre-push skipped a tree that passed under another test command"

echo c > file && git commit -q -am red
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'; exit 1"
! pre_push > /dev/null 2>&1 || fail "pre-push let a red run through"
! pre_push > /dev/null 2>&1 || fail "a red run was recorded as passing"
[ "$(runs)" = 6 ] || fail "red pre-push runs did not each run the suite"
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'"
FAKE_NODE_VERSION=v1.0.0
pre_push HEAD~2 > /dev/null && [ "$(runs)" = 6 ] || fail "a red run removed the record of an older tree"

echo d > untracked
out="$(sh "$REPO/scripts/run-tests.sh")" || fail "green run on a dirty tree exited nonzero"
[ "$(runs)" = 7 ] || fail "the dirty run did not run the suite"
case "$out" in *"not recorded"*) ;; *) fail "the dirty run did not say it records nothing: $out" ;; esac
rm untracked
pre_push > /dev/null && [ "$(runs)" = 8 ] || fail "a run on a dirty tree was recorded"
sh "$REPO/scripts/run-tests.sh" --pre-push < /dev/null > /dev/null && [ "$(runs)" = 9 ] || fail "pre-push with no ref lines skipped the suite"

# HEAD's tree is recorded now. A push holding another, untested ref still runs; a branch deletion has no tree to test.
zero=0000000000000000000000000000000000000000
untested="$(git commit-tree "$(git mktree < /dev/null)" -m untested)"
printf 'refs/heads/main %s refs/heads/main %s\nrefs/heads/other %s refs/heads/other %s\n' "$(git rev-parse HEAD)" "$zero" "$untested" "$zero" \
  | sh "$REPO/scripts/run-tests.sh" --pre-push > /dev/null && [ "$(runs)" = 10 ] || fail "pre-push skipped a push holding an untested ref"
printf '(delete) %s refs/heads/gone %s\nrefs/heads/main %s refs/heads/main %s\n' "$zero" "$(git rev-parse HEAD~1)" "$(git rev-parse HEAD)" "$zero" \
  | sh "$REPO/scripts/run-tests.sh" --pre-push > /dev/null && [ "$(runs)" = 10 ] || fail "a branch deletion in the push forced a run"

echo "ok"
