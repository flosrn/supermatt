#!/bin/sh
# Tests skills/tdd/scripts/mutate.sh against a one-line program and its test.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

cd "$TMP"
printf '# sum\n\techo $((1+1))\n' > add.sh
cp add.sh add.orig
printf 'add.sh\n1+1\n====\n1+2\n' > red.m
printf 'add.sh\n# sum\n====\n# total\n' > green.m
printf 'add.sh\n$((1+1))\n====\n$((1+\n' > broken.m
printf 'add.sh\n2+2\n====\n3+3\n' > missing.m
printf 'add.sh\n# sum\n\techo\n====\n# sum\n\techo 3; exit\n' > multiline.m

if out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" -b 'sh -n add.sh' '[ "$(sh add.sh)" = 2 ]' \
  red.m green.m broken.m missing.m multiline.m)"; then
  fail "mutate.sh exited zero with mutations that were not red"
fi
[ "$out" = "red.m test-failed
green.m GREEN
broken.m broken
missing.m missing
multiline.m test-failed" ] || fail "unexpected report: $out"
cmp -s add.sh add.orig || fail "add.sh was not restored"

sh "$REPO/skills/tdd/scripts/mutate.sh" '[ "$(sh add.sh)" = 2 ]' red.m >/dev/null || fail "an all-red run exited nonzero"

# Mutations preserve bytes outside the exact replacement, including EOF.
printf 'echo original' > no-newline.sh
cp no-newline.sh no-newline.orig
printf 'echo mutated' > no-newline.expected
printf 'no-newline.sh\noriginal\n====\nmutated\n' > no-newline.m
code=0
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" \
  'if [ "$(sh no-newline.sh)" = mutated ]; then cmp -s no-newline.sh no-newline.expected; else cmp -s no-newline.sh no-newline.orig; fi' no-newline.m)" || code=$?
[ "$out" = "no-newline.m GREEN" ] || fail "a mutation changed unrelated bytes: $out"
[ "$code" = 1 ] || fail "a surviving exact mutation exited $code, want 1"
cmp -s no-newline.sh no-newline.orig || fail "a no-newline target was not restored"

printf 'add.sh\n1+1\n' > no-separator.m
code=0
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" '[ "$(sh add.sh)" = 2 ]' no-separator.m)" || code=$?
[ "$code" = 1 ] || fail "a malformed mutation exited $code, want 1"
[ "$out" = "no-separator.m missing" ] || fail "a malformed mutation was applied: $out"
cmp -s add.sh add.orig || fail "a malformed mutation changed its target"

# A broken mutation, as a deleted name is in Go, gets a hint on stderr to keep
# the name in use. A run with none broken prints no hint.
hint="$(sh "$REPO/skills/tdd/scripts/mutate.sh" -b 'sh -n add.sh' '[ "$(sh add.sh)" = 2 ]' broken.m 2>&1 >/dev/null)" || true
case "$hint" in
*"false && cond"*) ;;
*) fail "a broken mutation printed no hint: $hint" ;;
esac
hint="$(sh "$REPO/skills/tdd/scripts/mutate.sh" -b 'sh -n add.sh' '[ "$(sh add.sh)" = 2 ]' red.m 2>&1 >/dev/null)"
case "$hint" in
*"false && cond"*) fail "a run with no broken mutation printed a build hint: $hint" ;;
esac

# Preserve both output streams for assertion failures and runtime errors.
# Neither is automatically certified as an assertion proving the mutation.
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" \
  '[ "$(sh add.sh)" = 2 ] || { echo "expected sum 2"; echo "actual sum 3" >&2; exit 1; }' red.m 2>assertion.log)"
[ "$out" = "red.m test-failed" ] || fail "an assertion was automatically certified: $out"
grep -q 'expected sum 2' assertion.log || fail "assertion stdout was lost"
grep -q 'actual sum 3' assertion.log || fail "assertion stderr was lost"
grep -q 'red.m' assertion.log || fail "assertion output did not identify its mutation"
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" \
  '[ "$(sh add.sh)" = 2 ] || { echo "ImportError: missing module" >&2; exit 1; }' red.m 2>runtime.log)"
[ "$out" = "red.m test-failed" ] || fail "a runtime error was certified red: $out"
grep -q 'ImportError: missing module' runtime.log || fail "runtime diagnostic was lost"
cmp -s add.sh add.orig || fail "add.sh was not restored after diagnostic checks"

# A failed backup must stop the batch without creating the missing target
# from the previous mutation's backup.
printf 'absent.sh\n1+1\n====\n1+2\n' > absent.m
code=0
sh "$REPO/skills/tdd/scripts/mutate.sh" \
  '[ ! -e absent.sh ] && [ "$(sh add.sh)" = 2 ]' red.m absent.m \
  >backup.out 2>backup.err || code=$?
[ "$code" = 2 ] || fail "a failed backup exited $code, want 2"
[ ! -e absent.sh ] || fail "a failed backup created its target"
cmp -s add.sh add.orig || fail "a failed backup changed the previous target"

# A restore failure is fatal and retains the original bytes for recovery.
# Inject a failing cp so this also works when the tests run as root.
mkdir fail-restore-bin recovery
real_cp=$(command -v cp)
cat > fail-restore-bin/cp <<'EOF'
#!/bin/sh
if [ "$2" = add.sh ]; then
  echo 'simulated restore failure' >&2
  exit 1
fi
exec "$REAL_CP" "$@"
EOF
chmod +x fail-restore-bin/cp
code=0
PATH="$TMP/fail-restore-bin:$PATH" REAL_CP="$real_cp" TMPDIR="$TMP/recovery" \
  sh "$REPO/skills/tdd/scripts/mutate.sh" '[ "$(sh add.sh)" = 2 ]' red.m \
  >restore.out 2>restore.err || code=$?
[ "$code" = 2 ] || fail "a failed restore exited $code, want 2"
backup=$(sed -n 's/^mutate.sh: cannot restore add.sh; backup retained at //p' restore.err)
[ -f "$backup" ] || fail "a failed restore lost its recovery copy"
cmp -s "$backup" add.orig || fail "the recovery copy lost the original bytes"
[ "$(sh add.sh)" = 3 ] || fail "the restore-failure fixture did not leave mutated code"
cp "$backup" add.sh

# A TEST already red with no mutation, as `-run A|B` is once sh reads the | as
# a pipe, would report every mutation red. The run stops before any.
code=0
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" 'echo baseline-test-stdout; echo baseline-test-stderr >&2; [ "$(sh add.sh)" = 2 ] | no-such-command' red.m 2>&1)" || code=$?
[ "$code" = 2 ] || fail "a red baseline exited $code, want 2"
case "$out" in
*"fails with no mutation"*) ;;
*) fail "a red baseline reported: $out" ;;
esac
case "$out" in
*"baseline-test-stdout"*"baseline-test-stderr"*) ;;
*) fail "baseline TEST diagnostics were lost: $out" ;;
esac
cmp -s add.sh add.orig || fail "add.sh changed on a red baseline"

code=0
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" \
  -b 'echo baseline-build-stdout; echo baseline-build-stderr >&2; exit 1' \
  '[ "$(sh add.sh)" = 2 ]' red.m 2>&1)" || code=$?
[ "$code" = 2 ] || fail "a broken baseline BUILD exited $code, want 2"
case "$out" in
*"baseline-build-stdout"*"baseline-build-stderr"*) ;;
*) fail "baseline BUILD diagnostics were lost: $out" ;;
esac

# An explicit timeout applies before any mutation, not only to mutated TEST.
code=0
sh "$REPO/skills/tdd/scripts/mutate.sh" -t 1 \
  'sleep 2; touch baseline-finished; [ "$(sh add.sh)" = 2 ]' red.m \
  >baseline.out 2>baseline.err || code=$?
[ "$code" = 2 ] || fail "a baseline timeout exited $code, want 2"
[ ! -e baseline-finished ] || fail "the baseline ran past its timeout"
cmp -s add.sh add.orig || fail "a baseline timeout changed the target"

# A limit that is not whole seconds, and a machine with no perl to make the
# process group, stop the run before any mutation.
code=0
sh "$REPO/skills/tdd/scripts/mutate.sh" -t 5s '[ "$(sh add.sh)" = 2 ]' red.m >/dev/null 2>&1 || code=$?
[ "$code" = 2 ] || fail "-t 5s exited $code, want 2"
mkdir noperl
out="$(PATH="$TMP/noperl" "$(command -v sh)" "$REPO/skills/tdd/scripts/mutate.sh" '[ "$(sh add.sh)" = 2 ]' red.m 2>&1)" &&
  fail "a run with no perl exited zero"
case "$out" in
*"perl is required"*) ;;
*) fail "a run with no perl reported: $out" ;;
esac

# Nothing TEST starts outlives it, as a test runner's child does when the
# runner is killed on its own timeout.
sh "$REPO/skills/tdd/scripts/mutate.sh" 'sleep 30 & echo $! > left.pid; [ "$(sh add.sh)" = 2 ]' red.m >/dev/null
! kill -0 "$(cat left.pid)" 2>/dev/null || fail "a process TEST started outlived it"

# A mutation that never ends, as a deleted loop guard does, is stopped at -t
# SECONDS with everything it started, and reported as a timeout.
code=0
out="$(sh "$REPO/skills/tdd/scripts/mutate.sh" -t 1 \
  '[ "$(sh add.sh)" = 2 ] || { sleep 30 & echo $! > hung.pid; wait; }' red.m)" || code=$?
[ "$out" = "red.m timeout" ] || fail "a hung mutation reported: $out"
[ "$code" = 1 ] || fail "a run with a timeout exited $code, want 1"
! kill -0 "$(cat hung.pid)" 2>/dev/null || fail "a hung mutation's process outlived the timeout"
cmp -s add.sh add.orig || fail "add.sh was not restored after a timeout"

# A run interrupted mid-mutation stops TEST, restores the target, and leaves
# no backup behind.
mkdir tmpd
TMPDIR="$TMP/tmpd" sh "$REPO/skills/tdd/scripts/mutate.sh" \
  '[ "$(sh add.sh)" = 2 ] || { sleep 30 & echo $! > stuck.pid; wait; }' red.m >/dev/null &
run=$!
i=0
until [ -s stuck.pid ]; do
  i=$((i + 1))
  [ "$i" -le 100 ] || fail "the mutated TEST never started"
  sleep 0.1
done
kill -TERM "$run"
wait "$run" || true
! kill -0 "$(cat stuck.pid)" 2>/dev/null || fail "an interrupted run's TEST outlived it"
cmp -s add.sh add.orig || fail "add.sh was not restored after an interrupt"
[ -z "$(ls -A tmpd)" ] || fail "an interrupted run left files behind: $(ls -A tmpd)"

# A restore failure in the exit trap must preserve the same recovery copy.
mkdir interrupted-recovery
PATH="$TMP/fail-restore-bin:$PATH" REAL_CP="$real_cp" TMPDIR="$TMP/interrupted-recovery" \
  sh "$REPO/skills/tdd/scripts/mutate.sh" \
  '[ "$(sh add.sh)" = 2 ] || { sleep 30 & echo $! > recovery-stuck.pid; wait; }' red.m \
  >interrupted.out 2>interrupted.err &
run=$!
i=0
until [ -s recovery-stuck.pid ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    kill -TERM "$run"
    wait "$run" || true
    fail "the recovery fixture never started"
  fi
  sleep 0.1
done
kill -TERM "$run"
code=0
wait "$run" || code=$?
[ "$code" = 2 ] || fail "an interrupted restore failure exited $code, want 2"
! kill -0 "$(cat recovery-stuck.pid)" 2>/dev/null || fail "an interrupted restore left TEST running"
backup=$(sed -n 's/^mutate.sh: cannot restore add.sh; backup retained at //p' interrupted.err)
[ -f "$backup" ] || fail "an interrupted restore lost its recovery copy"
cmp -s "$backup" add.orig || fail "the interrupted recovery copy lost the original bytes"
cp "$backup" add.sh

echo "ok"
