#!/bin/sh
# Install this file as an SSH forced command, never as a general shell endpoint.
set -eu
set -f
umask 077
PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"
export PATH LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_GLOBAL
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR NODE_OPTIONS BUN_OPTIONS

reject() { printf 'native-eval: %s\n' "$*" >&2; exit 64; }
fail() { code=$1; shift; printf 'native-eval: %s\n' "$*" >&2; exit "$code"; }
logged_in() { codex login status; }

# Word splitting is intentional, globbing is disabled, and no shell evaluates input.
request=${SSH_ORIGINAL_COMMAND:-}
case $request in *[!A-Za-z0-9' '.,_-]*) reject 'invalid request characters' ;; esac
set -- $request
[ "$#" -ge 2 ] || reject 'expected native-eval ping or native-eval run'
[ "$1" = native-eval ] || reject 'unknown command'
shift
operation=$1
shift
if [ "$operation" = ping ]; then
  [ "$#" -eq 0 ] || reject 'ping accepts no arguments'
  printf 'native-eval ok\n'
  logged_in || exit 69
  exit 0
fi
[ "$operation" = run ] || reject 'unknown operation'
model= baseline= cases= runs= dry_run=
while [ "$#" -gt 0 ]; do
  flag=$1
  shift
  case $flag in
    --model|--baseline|--cases|--runs)
      [ "$#" -gt 0 ] || reject "missing value for $flag"
      value=$1
      [ -n "$value" ] || reject "empty value for $flag"
      shift
      case $flag in
        --model) [ -z "$model" ] || reject 'duplicate --model'; model=$value ;;
        --baseline) [ -z "$baseline" ] || reject 'duplicate --baseline'; baseline=$value ;;
        --cases) [ -z "$cases" ] || reject 'duplicate --cases'; cases=$value ;;
        --runs) [ -z "$runs" ] || reject 'duplicate --runs'; runs=$value ;;
      esac ;;
    --dry-run) [ -z "$dry_run" ] || reject 'duplicate --dry-run'; dry_run=yes ;;
    *) reject "unknown token: $flag" ;;
  esac
done
case $model in ''|*[!A-Za-z0-9._-]*) reject 'invalid --model' ;; esac
case $baseline in *[!0-9a-fA-F]*|'') reject 'invalid --baseline' ;; esac
[ "${#baseline}" -eq 40 ] || reject '--baseline must be a 40-hex commit'
case $cases in ,*|*,|*,,*|*[!a-z0-9,-]*) reject 'invalid --cases' ;; esac
if [ -n "$cases" ]; then
  saved_ifs=$IFS
  IFS=,
  set -- $cases
  IFS=$saved_ifs
  for id in "$@"; do
    case $id in ''|*[!a-z0-9-]*) reject 'invalid case id' ;; esac
  done
fi
case $runs in ''|[1-9]|10) ;; *) reject '--runs must be 1..10' ;; esac
logged_in >&2 || exit 69

cache=${XDG_CACHE_HOME:-$HOME/.cache}/supermatt-native-eval
mkdir -p "$cache"
mkdir "$cache/lock" 2>/dev/null || fail 75 'another evaluation holds the cache lock; retry after it finishes'
work=
cleanup() {
  [ -z "$work" ] || rm -rf "$work"
  rmdir "$cache/lock"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
work=$(mktemp -d "$cache/run.XXXXXX")
work=$(CDPATH= cd "$work" && pwd -P)
mkdir "$work/tmp" "$work/report" "$work/candidate-source"
# The override is for offline tests, never an SSH request parameter.
origin=${SUPERMATT_NATIVE_EVAL_ORIGIN_URL:-https://github.com/flosrn/supermatt.git}
if [ ! -d "$cache/origin.git" ]; then
  git clone --bare "$origin" "$cache/origin.git" >&2 || fail 65 'cannot clone trusted origin'
fi
git -C "$cache/origin.git" remote set-url origin "$origin"
git -C "$cache/origin.git" fetch --prune --prune-tags origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' >&2 || fail 65 'cannot refresh trusted origin'
git -C "$cache/origin.git" fetch origin HEAD >&2 || fail 65 'cannot fetch trusted origin HEAD'
trusted=$(git -C "$cache/origin.git" rev-parse 'FETCH_HEAD^{commit}')
# Candidate objects never enter the trusted cache. A transport clone includes only
# origin-reachable objects, not objects left behind by earlier candidate requests.
git clone --bare --no-local "$cache/origin.git" "$work/candidate.git" >&2 || fail 65 'cannot prepare bundle receiver'
cat > "$work/candidate.bundle"
git -C "$work/candidate.git" bundle verify "$work/candidate.bundle" >&2 || fail 65 'invalid bundle or unavailable prerequisites'
heads=$(git bundle list-heads "$work/candidate.bundle" refs/heads/candidate) || fail 65 'cannot read candidate ref'
set -- $heads
[ "$#" -eq 2 ] && [ "$2" = refs/heads/candidate ] || fail 65 'bundle must advertise refs/heads/candidate'
git -C "$work/candidate.git" fetch "$work/candidate.bundle" '+refs/heads/candidate:refs/heads/candidate' >&2 || fail 65 'cannot fetch candidate bundle'
candidate=$(git -C "$work/candidate.git" rev-parse 'refs/heads/candidate^{commit}') || fail 65 'candidate is not a commit'
git clone --no-local --no-checkout "$cache/origin.git" "$work/trusted" >&2 || fail 65 'cannot prepare trusted evaluator'
git -C "$work/trusted" -c core.hooksPath=/dev/null checkout --detach "$trusted" >&2 || fail 65 'cannot check out trusted evaluator'
git -C "$work/candidate.git" archive --format=tar "$candidate" > "$work/candidate.tar" || fail 65 'cannot snapshot candidate'
tar -xf "$work/candidate.tar" -C "$work/candidate-source" || fail 65 'cannot extract candidate snapshot'

report=$work/report
status=0
if [ ! -f "$work/trusted/scripts/export-eval-catalogue.mjs" ]; then
  printf 'native-eval: trusted origin must contain export-eval-catalogue.mjs; merge the remote-evaluation support first\n' >&2
  status=69
else
  node "$work/trusted/scripts/export-eval-catalogue.mjs" "$work/candidate-source" "$work/catalogue.json" >&2 || status=$?
fi
if [ "$status" -eq 0 ]; then
  set -- scripts/evaluate-skills.mjs --model "$model" --baseline "$baseline" --repo "$work/candidate.git" --candidate "$candidate" --catalogue "$work/catalogue.json"
  [ -z "$cases" ] || set -- "$@" --cases "$cases"
  [ -z "$runs" ] || set -- "$@" --runs "$runs"
  [ -z "$dry_run" ] || set -- "$@" --dry-run
  (cd "$work/trusted" && TMPDIR="$work/tmp" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun "$@") > "$work/evaluator.stdout" 2> "$work/evaluator.stderr" || status=$?
  cat "$work/evaluator.stdout" "$work/evaluator.stderr" >&2
  if [ -n "$dry_run" ]; then
    cp "$work/evaluator.stdout" "$report/plan.json"
  else
    set +f
    for evidence in "$work/tmp"/supermatt-evals-*; do
      if [ -f "$evidence/report.json" ]; then report=$evidence; break; fi
    done
    set -f
    cp "$work/evaluator.stdout" "$report/evaluator-stdout.log"
  fi
  cp "$work/evaluator.stderr" "$report/evaluator-stderr.log"
fi
# Trusted code writes provenance; neither a candidate module nor its output
# controls the destination, host identity, or trusted evaluator revision.
node --input-type=module - "$report/native-eval.json" "$trusted" "$candidate" "$baseline" "$status" <<'JS'
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
const [out, evaluatorCommit, candidateCommit, baselineCommit, status] = process.argv.slice(2);
writeFileSync(out, JSON.stringify({ remoteHost: hostname(), evaluatorCommit, candidateCommit, baselineCommit,
  exitStatus: Number(status), catalogueIsolation: 'Node permission model; not a hostile-code sandbox; network may remain available' }, null, 2) + '\n');
JS
tar -czf - -C "$report" .
exit "$status"
