#!/bin/sh
# Usage: check-changelog-unreleased.sh --staged
#        check-changelog-unreleased.sh <base-rev> <head-rev>
#
# Rejects net changes to released CHANGELOG.md sections unless the same change
# bumps the version in .claude-plugin/plugin.json. Staged checks compare the
# index with the branch's merge base against origin/main (or HEAD without it).
# Revision checks compare the head revision with the two revisions' merge base.
set -eu

usage() {
  echo "Usage: check-changelog-unreleased.sh --staged | <base-rev> <head-rev>" >&2
  exit 2
}

case $# in
  1) [ "$1" = --staged ] || usage; staged=1 ;;
  2)
    case $1 in -*) usage ;; esac
    case $2 in -*) usage ;; esac
    staged=0
    ;;
  *) usage ;;
esac

cd "$(dirname "$0")/.."
if [ "$staged" = 1 ]; then
  git rev-parse --verify HEAD >/dev/null 2>&1 || exit 0
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    base=$(git merge-base HEAD origin/main)
  else
    base=HEAD
  fi
  new=:
else
  base=$(git merge-base -- "$1" "$2")
  new=$2:
fi

changelog=$(git show "$base:CHANGELOG.md" 2>/dev/null || :)
boundary=$(printf '%s\n' "$changelog" | awk '/^## \[[0-9]+\.[0-9]+\.[0-9]+\]/ { print NR; exit }')
[ -n "$boundary" ] || exit 0

# Disable external diff drivers, text conversion, renames and merged hunks so
# old-side hunk coordinates describe exactly the protected base file.
if [ "$staged" = 1 ]; then
  diff=$(git diff --cached --no-color --no-ext-diff --no-textconv --no-renames --text --inter-hunk-context=0 -U0 "$base" -- CHANGELOG.md)
else
  diff=$(git diff --no-color --no-ext-diff --no-textconv --no-renames --text --inter-hunk-context=0 -U0 "$base" "$2" -- CHANGELOG.md)
fi

offense=$(printf '%s\n' "$diff" | awk -v boundary="$boundary" '
  /^@@ -[0-9]+(,[0-9]+)? \+[0-9]+(,[0-9]+)? @@/ {
    split(substr($2, 2), old, ",")
    split(substr($3, 2), new, ",")
    count = index($2, ",") ? old[2] + 0 : 1
    if ((count > 0 && old[1] + count - 1 >= boundary) ||
        (count == 0 && old[1] >= boundary)) {
      line = old[1] < boundary ? boundary : old[1]
      print line, new[1]
      exit
    }
  }')
[ -n "$offense" ] || exit 0

base_manifest=$(git show "$base:.claude-plugin/plugin.json" 2>/dev/null || :)
new_manifest=$(git show "${new}.claude-plugin/plugin.json" 2>/dev/null || :)
base_version=$(printf '%s\n' "$base_manifest" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p')
new_version=$(printf '%s\n' "$new_manifest" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p')
[ "$base_version" = "$new_version" ] || exit 0

old_line=${offense% *}
new_line=${offense#* }
heading=$(printf '%s\n' "$changelog" | awk -v line="$old_line" '
  NR <= line && /^## \[[0-9]+\.[0-9]+\.[0-9]+\]/ { heading = $0 }
  END { print heading }')
printf '%s\n' "CHANGELOG.md:$new_line: $heading: ordinary changes go under ## [Unreleased]; only a release PR that bumps version in .claude-plugin/plugin.json edits released sections (AGENTS.md)" >&2
exit 1
