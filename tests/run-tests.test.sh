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
printf '#!/bin/sh\n[ -n "$FAKE_NODE_VERSION" ] || exit 127\necho "$FAKE_NODE_VERSION"\n' > "$TMP/bin/node"
chmod +x "$TMP/bin/node"
REAL_PATH="$PATH"
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

# Worktrees share the record: a linked worktree on another commit with the same tree skips the suite.
git worktree add -q --detach "$TMP/linked" "$(git commit-tree 'HEAD^{tree}' -p HEAD -m same-tree)"
(cd "$TMP/linked" && pre_push > /dev/null) && [ "$(runs)" = 1 ] || fail "a linked worktree ran the suite for a tree that already passed"

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

# A suite that commits while it runs did not test the tree it started from, so that tree stays unrecorded.
echo e > file && git commit -q -am start
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'; if [ -f '$TMP/move' ]; then rm '$TMP/move'; echo f > file; git commit -q -am moved; fi"
touch "$TMP/move"
sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "a green run that moved HEAD exited nonzero"
pre_push HEAD~1 > /dev/null && [ "$(runs)" = 12 ] || fail "a run that moved HEAD recorded the tree it started from"
git checkout -q HEAD~1 -- file
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'; if [ -f '$TMP/move' ]; then rm '$TMP/move'; echo g > file; fi"
touch "$TMP/move" && git commit -q -am back
sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "a green run that left changes exited nonzero"
git checkout -q -- file
pre_push > /dev/null && [ "$(runs)" = 14 ] || fail "a run that left uncommitted changes was recorded"

# Without a node version the run cannot be bound to one, so it stops before the suite.
FAKE_NODE_VERSION= && ! sh "$REPO/scripts/run-tests.sh" > /dev/null 2>&1 && [ "$(runs)" = 14 ] || fail "a run without a node version went on"
FAKE_NODE_VERSION=v1.0.0

# The record holds one entry per passing tree, command and node version.
sh "$REPO/scripts/run-tests.sh" > /dev/null && sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "repeated green runs exited nonzero"
[ "$(grep -c "^$(git rev-parse 'HEAD^{tree}') " .git/supermatt-test-runs)" = 1 ] || fail "two identical green runs left two entries"

# The hook tests the worktree: a pushed ref whose tree is not the checked-out one is named, since the suite did not run on it.
out="$(printf 'refs/heads/other %s refs/heads/other %s\n' "$untested" "$zero" | sh "$REPO/scripts/run-tests.sh" --pre-push)" \
  || fail "pre-push of an untested ref exited nonzero"
case "$out" in *refs/heads/other*) ;; *) fail "pre-push did not name the ref it did not test: $out" ;; esac
echo h > file && git commit -q -am untested-head
out="$(pre_push)" || fail "pre-push of an untested HEAD exited nonzero"
case "$out" in *refs/heads/*) fail "pre-push named the ref it tested: $out" ;; esac
# When the suite runs, every pushed ref that is not the checked-out commit is named, even one already recorded or sharing its tree.
echo i > file && git commit -q -am untested-again
twin="$(git commit-tree 'HEAD^{tree}' -p HEAD -m twin)"
out="$(printf 'refs/heads/main %s refs/heads/main %s\nrefs/heads/prev %s refs/heads/prev %s\nrefs/heads/twin %s refs/heads/twin %s\n' \
  "$(git rev-parse HEAD)" "$zero" "$(git rev-parse HEAD~1)" "$zero" "$twin" "$zero" | sh "$REPO/scripts/run-tests.sh" --pre-push)" \
  || fail "pre-push of an untested HEAD with other refs exited nonzero"
case "$out" in *refs/heads/prev*) ;; *) fail "pre-push did not name a recorded ref it did not test: $out" ;; esac
case "$out" in *refs/heads/twin*) ;; *) fail "pre-push did not name another commit sharing the tested tree: $out" ;; esac
case "$out" in *refs/heads/main*) fail "pre-push named the checked-out commit: $out" ;; esac
# A pushed object with no tree to resolve is named too, and the suite still runs on the worktree.
before="$(runs)"
out="$(printf 'refs/heads/ghost %s refs/heads/ghost %s\n' 1111111111111111111111111111111111111111 "$zero" | sh "$REPO/scripts/run-tests.sh" --pre-push 2>&1)" \
  && [ "$(runs)" = $((before + 1)) ] || fail "pre-push of an unresolvable object did not run the suite: $out"
case "$out" in *refs/heads/ghost*) ;; *) fail "pre-push did not name an unresolvable ref: $out" ;; esac
# `git push origin HEAD~1:refs/heads/dest` gives the hook the source as typed; the branch it updates is the one to name.
out="$(printf 'HEAD~1 %s refs/heads/dest %s\n' "$untested" "$zero" | sh "$REPO/scripts/run-tests.sh" --pre-push)" \
  || fail "pre-push to another destination exited nonzero"
case "$out" in *refs/heads/dest*) ;; *) fail "pre-push did not name the destination it did not test: $out" ;; esac

# A push that only deletes refs sends no tree to test.
before="$(runs)"
printf '(delete) %s refs/heads/gone %s\n' "$zero" "$untested" | sh "$REPO/scripts/run-tests.sh" --pre-push > /dev/null \
  && [ "$(runs)" = "$before" ] || fail "a deletion-only push ran the suite"
deletion="(delete) $zero refs/heads/gone $untested"
echo "$deletion" | FAKE_NODE_VERSION= sh "$REPO/scripts/run-tests.sh" --pre-push > /dev/null 2>&1 || fail "a deletion-only push needed node"
git init -q -b main "$TMP/unborn"
(cd "$TMP/unborn" && echo "$deletion" | sh "$REPO/scripts/run-tests.sh" --pre-push > /dev/null 2>&1) || fail "a deletion-only push needed a first commit"

# An untracked file the suite may read keeps the run unrecorded, even when status is configured to hide untracked files.
echo j > file && git commit -q -am hidden-untracked
git config status.showUntrackedFiles no
echo y > untracked
sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "a green run beside a hidden untracked file exited nonzero"
rm untracked
git config --unset status.showUntrackedFiles
before="$(runs)"
pre_push > /dev/null && [ "$(runs)" = $((before + 1)) ] || fail "a run beside a hidden untracked file was recorded"

# When Git cannot read the worktree after the suite, the run cannot be shown clean and stays unrecorded.
echo k > file && git commit -q -am unreadable-index
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'; if [ -f '$TMP/move' ]; then rm '$TMP/move'; cp .git/index '$TMP/index'; echo junk > .git/index; fi"
touch "$TMP/move"
sh "$REPO/scripts/run-tests.sh" > /dev/null 2>&1 || :
cp "$TMP/index" .git/index
before="$(runs)"
pre_push > /dev/null && [ "$(runs)" = $((before + 1)) ] || fail "a run whose final status check failed was recorded"

# A sparse checkout hides absent files from status; the suite saw only part of the tree, so the run stays unrecorded.
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'"
echo l > file && git commit -q -am sparse
git update-index --skip-worktree file && rm file
sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "a green run in a sparse checkout exited nonzero"
git update-index --no-skip-worktree file && git checkout -q -- file
before="$(runs)"
pre_push > /dev/null && [ "$(runs)" = $((before + 1)) ] || fail "a run in a sparse checkout was recorded"

# A file marked assume-unchanged can differ from the commit without status showing it.
echo m > file && git commit -q -am assume
git update-index --assume-unchanged file && echo changed > file
sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "a green run beside an assume-unchanged file exited nonzero"
git update-index --no-assume-unchanged file && git checkout -q -- file
before="$(runs)"
pre_push > /dev/null && [ "$(runs)" = $((before + 1)) ] || fail "a run beside an assume-unchanged file was recorded"

# A suite that removes the changes it started with tested them, not the commit's tree.
echo h2 > file && git commit -q -am dirty-start
SUPERMATT_TEST_COMMAND="echo run >> '$TMP/runs'; rm -f leftover"
echo x > leftover
sh "$REPO/scripts/run-tests.sh" > /dev/null || fail "a green run that removed its starting changes exited nonzero"
before="$(runs)"
pre_push > /dev/null && [ "$(runs)" = $((before + 1)) ] || fail "a run that started with uncommitted changes was recorded"

# The repository's pre-push job, run by lefthook: it hands git's ref lines to the script, and a push with no record runs
# the suite whatever files it changes. CI installs no lefthook; the hook only runs where lefthook is installed.
if command -v lefthook > /dev/null 2>&1; then
  git init -q -b main "$TMP/hook"
  cd "$TMP/hook"
  git config user.name test && git config user.email test@example.com && git config commit.gpgsign false
  mkdir scripts && cp "$REPO/lefthook.yml" . && cp "$REPO/scripts/run-tests.sh" scripts/
  echo a > README.md && git add -A && git commit -q -m init
  base="$(git rev-parse HEAD)"
  # lefthook filters a job's files against what the remote already holds.
  git init -q --bare "$TMP/hook-origin.git" && git remote add origin "$TMP/hook-origin.git"
  git push -q --no-verify origin main
  echo b > README.md && git commit -q -am prose
  hook() { echo "refs/heads/main $(git rev-parse HEAD) refs/heads/main $base" | lefthook run pre-push --no-auto-install --job tests > /dev/null 2>&1; }
  before="$(runs)"
  hook && [ "$(runs)" = $((before + 1)) ] || fail "the hook did not run the suite for a prose-only push with no record"
  hook && [ "$(runs)" = $((before + 1)) ] || fail "the hook did not hand the pushed refs to the script"
else
  echo "lefthook not installed: the hook cases did not run"
fi

# Without the override the script runs the repository's suite as CI does: every shell test, stopping at the first
# failure, then node's runner on the JavaScript tests.
git init -q -b main "$TMP/default"
cd "$TMP/default"
git config user.name test && git config user.email test@example.com && git config commit.gpgsign false
mkdir tests
echo 'echo shell >> "$ORDER"' > tests/a.test.sh
printf '%s\n' "import { appendFileSync } from 'node:fs';" "appendFileSync(process.env.ORDER, 'node\\n');" > tests/a.test.mjs
git add -A && git commit -q -m suite
ORDER="$TMP/order" && export ORDER
PATH="$REAL_PATH" env -u SUPERMATT_TEST_COMMAND sh "$REPO/scripts/run-tests.sh" > /dev/null 2>&1 || fail "the default suite failed on a green fixture"
[ "$(cat "$ORDER")" = "shell
node" ] || fail "the default suite did not run the shell tests, then node: $(cat "$ORDER")"
echo 'exit 1' > tests/0.test.sh && git add -A && git commit -q -m red-shell
rm "$ORDER"
! PATH="$REAL_PATH" env -u SUPERMATT_TEST_COMMAND sh "$REPO/scripts/run-tests.sh" > /dev/null 2>&1 || fail "a red shell test let the default suite pass"
[ ! -e "$ORDER" ] || fail "tests ran after the first red shell test: $(cat "$ORDER")"

echo "ok"
