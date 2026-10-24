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
    oldstart = old[1] + 0
    oldcount = index($2, ",") ? old[2] + 0 : 1
    newstart = new[1] + 0
    newcount = index($3, ",") ? new[2] + 0 : 1
    if ((oldcount > 0 && oldstart + oldcount - 1 >= boundary) ||
        (oldcount == 0 && oldstart >= boundary)) {
      oldline = oldstart < boundary ? boundary : oldstart
      # A violating hunk that starts before the boundary spans it: mixed nonempty
      # hunks report their whole new-side range; deletions keep Git anchors.
      if (newcount > 0 && oldstart < boundary)
        print oldline, newstart "-" (newstart + newcount - 1), "mixed"
      else
        print oldline, newstart, "precise"
      exit
    }
  }
  ')
[ -n "$offense" ] || exit 0

base_manifest=$(git show "$base:.claude-plugin/plugin.json" 2>/dev/null || :)
new_manifest=$(git show "${new}.claude-plugin/plugin.json" 2>/dev/null || :)
base_version=$(printf '%s\n' "$base_manifest" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p')
new_version=$(printf '%s\n' "$new_manifest" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p')
[ "$base_version" = "$new_version" ] || exit 0

# offense is "<old-line> <new-side location> <kind>", digits, dashes and letters only.
set -- $offense
old_line=$1 new_line=$2 kind=$3
detail=
if [ "$kind" = mixed ]; then
  detail='changed hunk spans Unreleased and released content; '
fi
heading=$(printf '%s\n' "$changelog" | awk -v line="$old_line" '
  NR <= line && /^## \[[0-9]+\.[0-9]+\.[0-9]+\]/ { heading = $0 }
  END { print heading }')
printf '%s\n' "CHANGELOG.md:$new_line: $heading: ${detail}ordinary changes go under ## [Unreleased]; only a release PR that bumps version in .claude-plugin/plugin.json edits released sections (AGENTS.md)" >&2
exit 1
