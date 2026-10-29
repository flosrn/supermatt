#!/bin/sh
# Offline client/server contract: real Git bundles and tar, only SSH/Codex/Bun are doubles.
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
REPO=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
background=
cleanup() {
  [ -z "$background" ] || { kill "$background" 2>/dev/null || :; wait "$background" 2>/dev/null || :; }
  rm -rf "$TMP"
}
trap cleanup 0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$TMP/bin" "$TMP/home" "$TMP/source/scripts/lib" "$TMP/source/tests/evals"
mkdir -p "$TMP/home/.local"
ln -s "$TMP/bin" "$TMP/home/.local/bin"
ln -s "$(node -p process.execPath)" "$TMP/bin/node"
cp "$REPO/scripts/export-eval-catalogue.mjs" "$TMP/source/scripts/"
cp "$REPO/scripts/lib/skill-evidence.mjs" "$TMP/source/scripts/lib/"
printf 'trusted evaluator\n' > "$TMP/source/scripts/evaluate-skills.mjs"
printf 'export const cases = [{id:"existing", skill:"example", prompt:"Run probe", files:{}, rubric:["Probe completed"]}]; export const variants = {neutral:"probe"};\n' > "$TMP/source/tests/evals/cases.mjs"
cat > "$TMP/bin/codex" <<'SH'
#!/bin/sh
[ "$*" = 'login status' ] || exit 90
printf 'Codex login diagnostic\n'
exit "${TEST_CODEX_STATUS:-0}"
SH
cat > "$TMP/bin/bun" <<'SH'
#!/bin/sh
set -eu
[ "$(cat scripts/evaluate-skills.mjs)" = 'trusted evaluator' ] || exit 91
shift
model= baseline= repo= candidate= catalogue= cases= runs= dry=
while [ "$#" -gt 0 ]; do
  flag=$1; shift
  if [ "$flag" = --dry-run ]; then dry=yes; continue; fi
  value=$1; shift
  case $flag in
    --model) model=$value ;; --baseline) baseline=$value ;; --repo) repo=$value ;;
    --candidate) candidate=$value ;; --catalogue) catalogue=$value ;;
    --cases) cases=$value ;; --runs) runs=$value ;; *) exit 92 ;;
  esac
done
[ "$model" = test-model ] && [ -n "$baseline" ] && [ -n "$candidate" ] || exit 93
[ "$(git -C "$repo" rev-parse --is-bare-repository)" = true ] || exit 94
node --input-type=module - "$catalogue" <<'JS'
import { readFileSync } from 'node:fs';
const catalogue = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (catalogue.cases[0].id !== 'candidate-new') process.exit(95);
JS
if [ -n "${TEST_HOLD_DIR:-}" ]; then
  mkdir "$TEST_HOLD_DIR/started"
  while [ ! -f "$TEST_HOLD_DIR/release" ]; do sleep 0.05; done
fi
printf 'evaluator diagnostic on stderr\n' >&2
if [ -n "$dry" ]; then
  printf '{"plannedRuns":3}\n'
else
  evidence=$(mktemp -d "$TMPDIR/supermatt-evals-XXXXXX")
  printf '{"status":"needs review","case":"%s","runs":"%s"}\n' "$cases" "$runs" > "$evidence/report.json"
  printf 'evaluator progress on stdout\n'
  printf '{"evidence":"%s"}\n' "$evidence"
fi
exit "${TEST_EVAL_STATUS:-0}"
SH
cat > "$TMP/bin/ssh" <<'SH'
#!/bin/sh
set -eu
[ "$1" = -o ] && [ "$2" = BatchMode=yes ] || exit 96
shift 2
[ "$1" = -o ] && [ "$2" = StrictHostKeyChecking=yes ] || exit 97
shift 2
[ "$1" = maintainer@test-host ] && [ "$#" -eq 2 ] || exit 98
SSH_ORIGINAL_COMMAND=$2
export SSH_ORIGINAL_COMMAND
exec sh "$TEST_SERVER"
SH
chmod +x "$TMP/bin/codex" "$TMP/bin/bun" "$TMP/bin/ssh"
export PATH="$TMP/bin:$PATH" HOME="$TMP/home" XDG_CACHE_HOME="$TMP/cache"
export TEST_SERVER="$REPO/scripts/native-eval-serve.sh" SUPERMATT_NATIVE_EVAL_SSH=maintainer@test-host
export SUPERMATT_NATIVE_EVAL_ORIGIN_URL="$TMP/origin.git"
git -C "$TMP/source" init -q -b main
git -C "$TMP/source" config user.email test@example.invalid
git -C "$TMP/source" config user.name Test
git -C "$TMP/source" add .
git -C "$TMP/source" commit -qm 'test: trusted source'
BASE=$(git -C "$TMP/source" rev-parse HEAD)
git clone -q --bare "$TMP/source" "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/client"
git -C "$TMP/client" config user.email test@example.invalid
git -C "$TMP/client" config user.name Test
printf 'throw new Error("candidate evaluator must never run");\n' > "$TMP/client/scripts/evaluate-skills.mjs"
printf 'export const cases = [{id:"candidate-new", skill:"example", prompt:"Run probe", files:{}, rubric:["Probe completed"]}]; export const variants = {neutral:"probe"};\n' > "$TMP/client/tests/evals/cases.mjs"
git -C "$TMP/client" add .
git -C "$TMP/client" commit -qm 'test: candidate with a new catalogue'
CANDIDATE=$(git -C "$TMP/client" rev-parse HEAD)
cd "$TMP/client"
client() { sh "$REPO/scripts/native-eval-remote.sh" "$@"; }
server() { SSH_ORIGINAL_COMMAND=$1 sh "$TEST_SERVER"; }
expect_status() {
  wanted=$1; shift
  actual=0
  "$@" > "$TMP/stdout" 2> "$TMP/stderr" || actual=$?
  [ "$actual" -eq "$wanted" ] || fail "expected $wanted, got $actual: $(cat "$TMP/stderr")"
}
expect_status 0 client --ping
case $(cat "$TMP/stdout") in *'native-eval ok'*'Codex login diagnostic'*) ;; *) fail 'ping did not include login status' ;; esac
TEST_CODEX_STATUS=1 expect_status 69 client --ping
TEST_CODEX_STATUS=1 expect_status 69 server "native-eval run --model test-model --baseline $BASE"
[ ! -s "$TMP/stdout" ] || fail 'missing login contaminated run stdout'
for request in \
  "native-eval run --model test;touch --baseline $BASE" \
  'native-eval run --model $(touch injected) --baseline 0000000000000000000000000000000000000000' \
  "native-eval run --model test --baseline $BASE extra" \
  "native-eval run --model test --baseline $BASE --runs 0" \
  "native-eval run --model test --baseline $BASE --runs 11" \
  "native-eval run --model test --baseline $BASE --cases invalid_id" \
  "native-eval run --model test --baseline $BASE --model duplicate" \
  "native-eval run --model test --baseline $BASE --cases good,,bad" \
  'native-eval ping extra'; do
  expect_status 64 server "$request"
  [ ! -s "$TMP/stdout" ] || fail 'rejected request contaminated stdout'
done
[ ! -e injected ] || fail 'request executed shell syntax'
expect_status 65 server "native-eval run --model test-model --baseline $BASE" <<'BAD'
not a git bundle
BAD
[ ! -s "$TMP/stdout" ] || fail 'bad bundle contaminated stdout'

expect_status 0 client --out "$TMP/report" --model test-model --baseline "$BASE" --cases candidate-new --runs 2
[ -f "$TMP/report/report.json" ] || fail 'client did not extract report'
node --input-type=module - "$TMP/report" "$BASE" "$CANDIDATE" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [directory, trusted, candidate] = process.argv.slice(2);
const provenance = JSON.parse(readFileSync(`${directory}/native-eval.json`));
assert.equal(provenance.evaluatorCommit, trusted);
assert.equal(provenance.candidateCommit, candidate);
assert.ok(provenance.remoteHost);
assert.equal(JSON.parse(readFileSync(`${directory}/report.json`)).case, 'candidate-new');
JS
[ ! -s "$TMP/stdout" ] || fail 'client wrote report/logs to stdout'
case $(cat "$TMP/stderr") in *'evaluator progress on stdout'*'evaluator diagnostic on stderr'*) ;; *) fail 'evaluation logs missing from stderr' ;; esac

# Direct server stdout must be a gzip tar, even when the evaluator fails.
git update-ref refs/heads/candidate HEAD
git bundle create "$TMP/good.bundle" refs/heads/candidate "^$BASE" >&2
TEST_EVAL_STATUS=23 expect_status 23 server "native-eval run --model test-model --baseline $BASE --cases candidate-new" < "$TMP/good.bundle"
tar -tzf "$TMP/stdout" > "$TMP/members" || fail 'server stdout is not a valid tar.gz'
TEST_EVAL_STATUS=23 expect_status 23 client --out "$TMP/failed" --model test-model --baseline "$BASE"
[ -f "$TMP/failed/report.json" ] || fail 'failed evaluation report not retained'
expect_status 0 client --out "$TMP/plan" --model test-model --baseline "$BASE" --dry-run
[ -f "$TMP/plan/plan.json" ] || fail 'dry-run plan missing'

printf 'dirty\n' > untracked
expect_status 64 client --out "$TMP/dirty-report" --model test-model --baseline "$BASE"
case $(cat "$TMP/stderr") in *'dirty tree'*) ;; *) fail 'dirty checkout not refused' ;; esac
rm untracked

# An unrelated bundle with a prerequisite absent from origin must fail closed.
git init -q -b main "$TMP/unrelated"
git -C "$TMP/unrelated" config user.email test@example.invalid
git -C "$TMP/unrelated" config user.name Test
printf 'one\n' > "$TMP/unrelated/file"
git -C "$TMP/unrelated" add .
git -C "$TMP/unrelated" commit -qm 'test: unrelated prerequisite'
printf 'two\n' >> "$TMP/unrelated/file"
git -C "$TMP/unrelated" commit -qam 'test: unrelated candidate'
git -C "$TMP/unrelated" update-ref refs/heads/candidate HEAD
git -C "$TMP/unrelated" bundle create "$TMP/unrelated.bundle" refs/heads/candidate '^HEAD^' >&2
expect_status 65 server "native-eval run --model test-model --baseline $BASE" < "$TMP/unrelated.bundle"

mkdir "$TMP/hold"
TEST_HOLD_DIR="$TMP/hold" server "native-eval run --model test-model --baseline $BASE" < "$TMP/good.bundle" > "$TMP/held.stdout" 2> "$TMP/held.stderr" &
background=$!
waited=0
while [ ! -d "$TMP/hold/started" ]; do
  waited=$((waited + 1))
  [ "$waited" -lt 200 ] || fail "held evaluation did not start: $(cat "$TMP/held.stderr")"
  sleep 0.05
done
expect_status 75 server "native-eval run --model test-model --baseline $BASE" < "$TMP/good.bundle"
case $(cat "$TMP/stderr") in *'cache lock'*) ;; *) fail 'lock conflict lacked a clear message' ;; esac
: > "$TMP/hold/release"
wait "$background" || fail 'first concurrent run failed'
background=
[ ! -d "$XDG_CACHE_HOME/supermatt-native-eval/lock" ] || fail 'lock leaked'
for leftover in "$XDG_CACHE_HOME/supermatt-native-eval"/run.*; do
  [ ! -e "$leftover" ] || fail 'private temporary state leaked'
done
printf 'native-eval client/server tests passed\n'
