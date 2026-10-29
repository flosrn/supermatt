#!/bin/sh
# Send a committed candidate to the maintainer's restricted native-eval endpoint.
set -eu
set -f
umask 077
LC_ALL=C
export LC_ALL
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

reject() { printf 'native-eval: %s\n' "$*" >&2; exit 64; }
dest=${SUPERMATT_NATIVE_EVAL_SSH:-}
out= model= baseline= cases= runs= dry_run= ping=
while [ "$#" -gt 0 ]; do
  flag=$1
  shift
  case $flag in
    --dest|--out|--model|--baseline|--cases|--runs)
      [ "$#" -gt 0 ] || reject "missing value for $flag"
      value=$1
      [ -n "$value" ] || reject "empty value for $flag"
      shift
      case $flag in
        --dest) dest=$value ;;
        --out) [ -z "$out" ] || reject 'duplicate --out'; out=$value ;;
        --model) [ -z "$model" ] || reject 'duplicate --model'; model=$value ;;
        --baseline) [ -z "$baseline" ] || reject 'duplicate --baseline'; baseline=$value ;;
        --cases) [ -z "$cases" ] || reject 'duplicate --cases'; cases=$value ;;
        --runs) [ -z "$runs" ] || reject 'duplicate --runs'; runs=$value ;;
      esac ;;
    --dry-run) [ -z "$dry_run" ] || reject 'duplicate --dry-run'; dry_run=yes ;;
    --ping) [ -z "$ping" ] || reject 'duplicate --ping'; ping=yes ;;
    *) reject "unknown token: $flag" ;;
  esac
done
case $dest in ''|-*|*[!A-Za-z0-9@._:-]*) reject 'set --dest or SUPERMATT_NATIVE_EVAL_SSH to an SSH destination' ;; esac
if [ -n "$ping" ]; then
  [ -z "$out$model$baseline$cases$runs$dry_run" ] || reject '--ping accepts only --dest'
  exec ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$dest" 'native-eval ping'
fi
[ -n "$out" ] || reject '--out is required'
case $out in /*) ;; *) out=$PWD/$out ;; esac
[ ! -e "$out" ] || reject '--out already exists; choose a new report directory'
case $model in ''|*[!A-Za-z0-9._-]*) reject 'invalid --model' ;; esac
case $baseline in ''|*[!0-9a-fA-F]*) reject 'invalid --baseline' ;; esac
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
root=$(git rev-parse --show-toplevel) || reject 'run from a supermatt checkout'
[ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ] || reject 'refusing a dirty tree; commit the candidate first'
head=$(git -C "$root" rev-parse 'HEAD^{commit}')
default=$(git -C "$root" symbolic-ref --quiet refs/remotes/origin/HEAD) || reject 'origin/HEAD is missing; fetch origin and run git remote set-head origin --auto'
exclude=$(git -C "$root" rev-parse "$default^{commit}")
# An all-excluded HEAD would make an empty bundle. Send its last commit with
# its parent as prerequisite when HEAD is already on the default branch.
if git -C "$root" merge-base --is-ancestor "$head" "$exclude"; then
  exclude=$(git -C "$root" rev-parse --verify "$head^" 2>/dev/null) || exclude=
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git clone --quiet --bare --shared "$root" "$work/repo.git" >&2
git -C "$work/repo.git" update-ref refs/heads/candidate "$head"
set -- refs/heads/candidate
[ -z "$exclude" ] || set -- "$@" "^$exclude"
git -C "$work/repo.git" bundle create "$work/candidate.bundle" "$@" >&2
request="native-eval run --model $model --baseline $baseline"
[ -z "$cases" ] || request="$request --cases $cases"
[ -z "$runs" ] || request="$request --runs $runs"
[ -z "$dry_run" ] || request="$request --dry-run"
status=0
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$dest" "$request" < "$work/candidate.bundle" > "$work/report.tar.gz" || status=$?
if [ -s "$work/report.tar.gz" ]; then
  # Never merge evidence from separate attempts or replace existing user files.
  if [ -e "$out" ]; then
    printf 'native-eval: --out already exists; choose a new report directory\n' >&2
    [ "$status" -ne 0 ] && exit "$status"
    exit 64
  fi
  tar -tzf "$work/report.tar.gz" > "$work/members" || {
    printf 'native-eval: remote stdout was not a report archive\n' >&2
    [ "$status" -ne 0 ] && exit "$status"
    exit 65
  }
  while IFS= read -r member; do
    case $member in /*|../*|*/../*|*/..) reject 'unsafe report archive path' ;; esac
  done < "$work/members"
  mkdir -p "$out"
  tar -xzf "$work/report.tar.gz" -C "$out" || {
    [ "$status" -ne 0 ] && exit "$status"
    exit 65
  }
  printf 'native-eval: report from %s saved to %s\n' "$dest" "$out" >&2
elif [ "$status" -eq 0 ]; then
  printf 'native-eval: remote returned no report archive\n' >&2
  exit 65
fi
exit "$status"
